import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import axios, { type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import * as lark from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger } from '../logging.js';
import type { BridgeConfig } from '../config/schema.js';
import { splitTextForFeishu } from './text.js';
import type { MetricsRegistry } from '../observability/metrics.js';

export interface FeishuMessageResponse {
  message_id?: string;
  open_message_id?: string;
  root_id?: string;
}

export interface FeishuApiEnvelope<T = unknown> {
  code?: number | string;
  msg?: string;
  data?: T;
}

export type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

export interface FeishuSendOptions {
  replyToMessageId?: string;
  replyInThread?: boolean;
}

export interface FeishuPostMessage {
  zh_cn: {
    title: string;
    content: Array<Array<{ tag: 'text'; text: string } | { tag: 'a'; text: string; href: string }>>;
  };
}

const FEISHU_MAX_SEND_ATTEMPTS = 3;
const FEISHU_RETRY_BASE_DELAY_MS = 500;
const FEISHU_RETRY_MAX_DELAY_MS = 5000;
const FEISHU_REQUEST_TIMEOUT_MS = 10000;
const RETRYABLE_NETWORK_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

export class FeishuClient {
  private readonly client: lark.Client;
  private readonly sdkHttpInstance: AxiosInstance;

  public constructor(
    private readonly config: BridgeConfig['feishu'],
    private readonly logger: Logger,
    private readonly metrics?: MetricsRegistry,
  ) {
    this.sdkHttpInstance = this.createSdkHttpInstance();
    this.client = new lark.Client({
      appId: config.app_id,
      appSecret: config.app_secret,
      domain: lark.Domain.Feishu,
      appType: lark.AppType.SelfBuild,
      loggerLevel: lark.LoggerLevel.warn,
      httpInstance: this.sdkHttpInstance,
    });
  }

  public createSdkClient(): lark.Client {
    return this.client;
  }

  public createWsClient(): lark.WSClient {
    const agent = this.createWsAgent();
    const httpInstance = this.createWsHttpInstance(agent);
    return new lark.WSClient({
      appId: this.config.app_id,
      appSecret: this.config.app_secret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      ...(agent ? { agent } : {}),
      ...(httpInstance ? { httpInstance } : {}),
    });
  }

  public async sendText(chatId: string, text: string, options: FeishuSendOptions = {}): Promise<FeishuMessageResponse> {
    const parts = splitTextForFeishu(text);
    let lastResponse: FeishuMessageResponse = {};
    for (const [index, part] of parts.entries()) {
      lastResponse = await this.sendMessage('chat_id', chatId, 'text', JSON.stringify({ text: part }), options);
      this.logger.debug({ chatId, chunk: index + 1, totalChunks: parts.length }, 'Sent Feishu text chunk');
    }
    return lastResponse;
  }

  public async sendCard(chatId: string, card: Record<string, unknown>, options: FeishuSendOptions = {}): Promise<FeishuMessageResponse> {
    return this.sendMessage('chat_id', chatId, 'interactive', JSON.stringify(card), options);
  }

  public async sendPost(chatId: string, post: FeishuPostMessage, options: FeishuSendOptions = {}): Promise<FeishuMessageResponse> {
    return this.sendMessage('chat_id', chatId, 'post', JSON.stringify(post), options);
  }

  /**
   * Upload a local file to Feishu and send it as a file message.
   * Supports any file type. Images sent as image messages, others as file messages.
   */
  public async sendFile(chatId: string, filePath: string, options: FeishuSendOptions = {}): Promise<FeishuMessageResponse> {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`文件不存在: ${absolutePath}`);
    }

    const stat = fs.statSync(absolutePath);
    if (stat.size > 30 * 1024 * 1024) {
      throw new Error(`文件过大 (${Math.round(stat.size / 1024 / 1024)}MB)，飞书限制 30MB`);
    }

    const fileName = path.basename(absolutePath);
    const isImage = /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(fileName);

    if (this.config.dry_run) {
      this.logger.info({ chatId, filePath: absolutePath, fileName, isImage }, 'Skipped Feishu file send (dry_run)');
      return { message_id: `dry-run-file-${Date.now()}` };
    }

    const sdkClient = this.createSdkClient?.();
    if (!sdkClient) {
      throw new Error('飞书 SDK 客户端不可用，无法上传文件');
    }

    if (isImage) {
      // Upload image → get image_key → send image message
      const uploadRes = await sdkClient.im.image.create({
        data: { image_type: 'message', image: fs.createReadStream(absolutePath) },
      }) as unknown as { data?: { image_key?: string } };
      const imageKey = uploadRes?.data?.image_key;
      if (!imageKey) throw new Error('飞书图片上传成功但未返回 image_key');
      return this.sendMessage('chat_id', chatId, 'image', JSON.stringify({ image_key: imageKey }), options);
    }

    // Upload file → get file_key → send file message
    const uploadRes = await sdkClient.im.file.create({
      data: { file_type: 'stream', file_name: fileName, file: fs.createReadStream(absolutePath) },
    }) as unknown as { data?: { file_key?: string } };
    const fileKey = uploadRes?.data?.file_key;
    if (!fileKey) throw new Error('飞书文件上传成功但未返回 file_key');
    return this.sendMessage('chat_id', chatId, 'file', JSON.stringify({ file_key: fileKey }), options);
  }

  public async updateText(messageId: string, text: string): Promise<FeishuMessageResponse> {
    return this.updateMessage(messageId, 'text', JSON.stringify({ text }));
  }

  public async updateCard(messageId: string, card: Record<string, unknown>): Promise<FeishuMessageResponse> {
    return this.updateMessage(messageId, 'interactive', JSON.stringify(card));
  }

  public async updatePost(messageId: string, post: FeishuPostMessage): Promise<FeishuMessageResponse> {
    return this.updateMessage(messageId, 'post', JSON.stringify(post));
  }

  public async sendTextToReceiveId(
    receiveIdType: FeishuReceiveIdType,
    receiveId: string,
    text: string,
    options: FeishuSendOptions = {},
  ): Promise<FeishuMessageResponse> {
    return this.sendMessage(receiveIdType, receiveId, 'text', JSON.stringify({ text }), options);
  }

  public async requestApi<T = unknown>(payload: {
    method: 'GET' | 'POST' | 'PATCH';
    url: string;
    params?: Record<string, string | number | boolean | undefined>;
    data?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<FeishuApiEnvelope<T>> {
    let attempt = 0;

    while (attempt < FEISHU_MAX_SEND_ATTEMPTS) {
      attempt += 1;

      try {
        const response = (await this.client.request({
          method: payload.method,
          url: payload.url,
          ...(payload.params ? { params: payload.params } : {}),
          ...(payload.data ? { data: payload.data } : {}),
          timeout: payload.timeoutMs ?? FEISHU_REQUEST_TIMEOUT_MS,
        })) as FeishuApiEnvelope<T>;
        this.logger.debug({ url: payload.url, method: payload.method, attempt }, 'Feishu API request completed');
        return response;
      } catch (error) {
        const delayMs = getRetryDelayMs(error, attempt);
        if (delayMs === null || attempt >= FEISHU_MAX_SEND_ATTEMPTS) {
          throw error;
        }
        this.logger.warn({ method: payload.method, url: payload.url, attempt, delayMs, err: error }, 'Retrying Feishu API request after transient failure');
        await sleep(delayMs);
      }
    }

    throw new Error(`Feishu API request failed unexpectedly: ${payload.method} ${payload.url}`);
  }

  private async sendMessage(
    receiveIdType: FeishuReceiveIdType,
    receiveId: string,
    msgType: 'text' | 'interactive' | 'post' | 'image' | 'file',
    content: string,
    options: FeishuSendOptions = {},
  ): Promise<FeishuMessageResponse> {
    if (this.config.dry_run) {
      const dryRunId = `dry-run-${Date.now()}`;
      const response = {
        message_id: dryRunId,
        open_message_id: dryRunId,
      };
      this.metrics?.recordOutboundMessage(msgType, 'success');
      this.logger.info({ receiveIdType, receiveId, msgType, content, replyToMessageId: options.replyToMessageId }, 'Skipped Feishu outbound send because dry_run is enabled');
      return response;
    }

    try {
      const response = options.replyToMessageId
        ? await this.requestApi<FeishuMessageResponse>({
            method: 'POST',
            url: `/open-apis/im/v1/messages/${encodeURIComponent(options.replyToMessageId)}/reply`,
            data: {
              content,
              msg_type: msgType,
              reply_in_thread: options.replyInThread ?? false,
              uuid: randomUUID(),
            },
          })
        : await this.requestApi<FeishuMessageResponse>({
            method: 'POST',
            url: '/open-apis/im/v1/messages',
            params: {
              receive_id_type: receiveIdType,
            },
            data: {
              receive_id: receiveId,
              content,
              msg_type: msgType,
              uuid: randomUUID(),
            },
          });

      ensureSuccessfulResponse(response);
      this.metrics?.recordOutboundMessage(msgType, 'success');
      this.logger.debug({ receiveIdType, receiveId, msgType, replyToMessageId: options.replyToMessageId }, 'Sent Feishu message');
      return response.data ?? {};
    } catch (error) {
      this.metrics?.recordOutboundMessage(msgType, 'failure');
      throw error;
    }
  }

  private async updateMessage(
    messageId: string,
    msgType: 'text' | 'interactive' | 'post',
    content: string,
  ): Promise<FeishuMessageResponse> {
    if (this.config.dry_run) {
      const response = {
        message_id: messageId,
        open_message_id: messageId,
      };
      this.metrics?.recordOutboundMessage(msgType, 'success');
      this.logger.info({ messageId, msgType, content }, 'Skipped Feishu outbound update because dry_run is enabled');
      return response;
    }

    try {
      const response = await this.requestApi<FeishuMessageResponse>({
        method: 'PATCH',
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        data: {
          content,
          msg_type: msgType,
        },
      });
      ensureSuccessfulResponse(response);
      this.metrics?.recordOutboundMessage(msgType, 'success');
      this.logger.debug({ messageId, msgType }, 'Updated Feishu message');
      return response.data ?? {};
    } catch (error) {
      this.metrics?.recordOutboundMessage(msgType, 'failure');
      throw error;
    }
  }

  private createWsAgent(): HttpsProxyAgent<string> | undefined {
    const proxyUrl =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy;
    if (!proxyUrl) {
      return undefined;
    }

    try {
      return new HttpsProxyAgent(proxyUrl);
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to build Feishu WebSocket proxy agent; falling back to direct connection');
      return undefined;
    }
  }

  private createWsHttpInstance(agent: HttpsProxyAgent<string> | undefined): AxiosInstance | undefined {
    if (!agent) {
      return undefined;
    }

    return this.createSdkHttpInstance(agent);
  }

  private createSdkHttpInstance(agent?: HttpsProxyAgent<string>): AxiosInstance {
    const httpInstance = axios.create({
      ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
      proxy: false,
    });

    httpInstance.interceptors.request.use((request: InternalAxiosRequestConfig) => {
      if (request.headers) {
        request.headers['User-Agent'] = 'oapi-node-sdk/1.0.0';
      }
      return request;
    }, undefined, { synchronous: true });

    httpInstance.interceptors.response.use((response: AxiosResponse) => {
      if ((response.config as InternalAxiosRequestConfig & { $return_headers?: boolean }).$return_headers) {
        return {
          data: response.data,
          headers: response.headers,
        };
      }
      return response.data;
    });

    return httpInstance;
  }
}

function ensureSuccessfulResponse(response: FeishuApiEnvelope): void {
  if (response.code === undefined || response.code === 0 || response.code === '0') {
    return;
  }

  const error = new Error(`Feishu API error ${String(response.code)}: ${response.msg ?? 'unknown error'}`) as Error & {
    retryable?: boolean;
  };
  error.retryable = isRetryableMessage(response.msg);
  throw error;
}

function getRetryDelayMs(error: unknown, attempt: number): number | null {
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const status = getErrorStatus(error);
  if (status === 429 || (status !== null && status >= 500)) {
    return boundedBackoff(attempt);
  }

  const code = getErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return boundedBackoff(attempt);
  }

  if (hasRetryableFlag(error) || isRetryableMessage(getErrorMessage(error))) {
    return boundedBackoff(attempt);
  }

  return null;
}

function getRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const response = isRecord(error.response) ? error.response : null;
  if (!response) {
    return null;
  }
  const headers = isRecord(response.headers) ? response.headers : null;
  if (!headers) {
    return null;
  }

  const candidate = headers['retry-after'] ?? headers['Retry-After'];
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
    return candidate * 1000;
  }

  if (typeof candidate === 'string') {
    const seconds = Number(candidate);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  return null;
}

function getErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const status = error.status;
  if (typeof status === 'number') {
    return status;
  }
  const response = isRecord(error.response) ? error.response : null;
  return typeof response?.status === 'number' ? response.status : null;
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== 'string') {
    return null;
  }
  return error.code;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}

function hasRetryableFlag(error: unknown): boolean {
  return isRecord(error) && error.retryable === true;
}

function isRetryableMessage(message: unknown): boolean {
  if (typeof message !== 'string') {
    return false;
  }
  return /(rate limit|too many requests|temporar|timeout|timed out|network|system busy|service unavailable)/i.test(message);
}

function boundedBackoff(attempt: number): number {
  return Math.min(FEISHU_RETRY_BASE_DELAY_MS * attempt, FEISHU_RETRY_MAX_DELAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
