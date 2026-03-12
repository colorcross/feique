import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuClient } from '../src/feishu/client.js';
import type { BridgeConfig } from '../src/config/schema.js';

const { requestMock, clientCtorMock, wsClientCtorMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  clientCtorMock: vi.fn(),
  wsClientCtorMock: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    public constructor(...args: unknown[]) {
      clientCtorMock(...args);
    }

    public request = requestMock;
  },
  WSClient: class MockWsClient {
    public constructor(...args: unknown[]) {
      wsClientCtorMock(...args);
    }
  },
  Domain: { Feishu: 'Feishu' },
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { warn: 'warn' },
}));

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

const config: BridgeConfig['feishu'] = {
  app_id: 'app-id',
  app_secret: 'app-secret',
  dry_run: false,
  transport: 'long-connection',
  host: '0.0.0.0',
  port: 3333,
  event_path: '/webhook/event',
  card_path: '/webhook/card',
  allowed_chat_ids: [],
  allowed_group_ids: [],
};

const originalHttpsProxy = process.env.HTTPS_PROXY;
const originalHttpProxy = process.env.HTTP_PROXY;
const originalHttpsProxyLower = process.env.https_proxy;
const originalHttpProxyLower = process.env.http_proxy;

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
  clientCtorMock.mockClear();
  wsClientCtorMock.mockClear();
  logger.debug.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  restoreProxyEnv();
});

describe('FeishuClient', () => {
  it('retries transient HTTP failures and succeeds', async () => {
    requestMock
      .mockRejectedValueOnce({
        message: 'Too Many Requests',
        response: { status: 429, headers: { 'retry-after': '1' } },
      })
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'message-1' } });

    const client = new FeishuClient(config, logger);
    const promise = client.sendText('chat-1', 'hello');

    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toEqual({ message_id: 'message-1' });
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable API errors', async () => {
    requestMock.mockResolvedValueOnce({ code: 9999, msg: 'invalid app credential' });

    const client = new FeishuClient(config, logger);

    await expect(client.sendCard('chat-1', { type: 'status' })).rejects.toThrow('Feishu API error 9999: invalid app credential');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips outbound API calls when dry_run is enabled', async () => {
    const client = new FeishuClient(
      {
        ...config,
        dry_run: true,
      },
      logger,
    );

    await expect(client.sendText('chat-1', 'hello dry run')).resolves.toMatchObject({
      message_id: expect.stringContaining('dry-run-'),
      open_message_id: expect.stringContaining('dry-run-'),
    });
    expect(requestMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        receiveIdType: 'chat_id',
        receiveId: 'chat-1',
        msgType: 'text',
      }),
      'Skipped Feishu outbound send because dry_run is enabled',
    );
  });

  it('uses the native reply API when replyToMessageId is provided', async () => {
    requestMock.mockResolvedValueOnce({ code: 0, data: { message_id: 'reply-1', root_id: 'message-1' } });

    const client = new FeishuClient(config, logger);

    await expect(client.sendText('chat-1', 'reply body', { replyToMessageId: 'message-1' })).resolves.toEqual({
      message_id: 'reply-1',
      root_id: 'message-1',
    });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/open-apis/im/v1/messages/message-1/reply',
        data: expect.objectContaining({
          msg_type: 'text',
          content: JSON.stringify({ text: 'reply body' }),
          reply_in_thread: false,
        }),
      }),
    );
  });

  it('updates an existing message through the Feishu message update API', async () => {
    requestMock.mockResolvedValueOnce({ code: 0, data: { message_id: 'message-1', open_message_id: 'om-1' } });

    const client = new FeishuClient(config, logger);

    await expect(client.updateText('message-1', 'updated body')).resolves.toEqual({
      message_id: 'message-1',
      open_message_id: 'om-1',
    });

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        url: '/open-apis/im/v1/messages/message-1',
        data: expect.objectContaining({
          msg_type: 'text',
          content: JSON.stringify({ text: 'updated body' }),
        }),
      }),
    );
  });

  it('passes a proxy agent to WSClient when proxy env is configured', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1087';
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;

    const client = new FeishuClient(config, logger);
    client.createWsClient();

    expect(wsClientCtorMock).toHaveBeenCalledTimes(1);
    const options = wsClientCtorMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.appId).toBe('app-id');
    expect(options.appSecret).toBe('app-secret');
    expect(options.agent).toBeTruthy();
    expect(options.httpInstance).toBeTruthy();
  });

  it('creates the SDK client with a direct httpInstance so Feishu APIs bypass system proxy env', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1087';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1087';

    new FeishuClient(config, logger);

    expect(clientCtorMock).toHaveBeenCalledTimes(1);
    const options = clientCtorMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.httpInstance).toBeTruthy();
  });

  it('creates WSClient without agent when no proxy env is configured', () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;

    const client = new FeishuClient(config, logger);
    client.createWsClient();

    expect(wsClientCtorMock).toHaveBeenCalledTimes(1);
    expect(wsClientCtorMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        agent: expect.anything(),
      }),
    );
  });
});

function restoreProxyEnv(): void {
  setOptionalEnv('HTTPS_PROXY', originalHttpsProxy);
  setOptionalEnv('HTTP_PROXY', originalHttpProxy);
  setOptionalEnv('https_proxy', originalHttpsProxyLower);
  setOptionalEnv('http_proxy', originalHttpProxyLower);
}

function setOptionalEnv(key: 'HTTPS_PROXY' | 'HTTP_PROXY' | 'https_proxy' | 'http_proxy', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
