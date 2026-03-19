import http from 'node:http';
import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logging.js';
import type { BridgeConfig } from '../config/schema.js';
import { FeiqueService } from '../bridge/service.js';
import { extractCardAction, extractIncomingMessage, shouldAllowChat } from './extractors.js';
import { waitForShutdownSignal } from '../runtime/shutdown.js';
import type { ServiceReadinessProbe } from '../observability/readiness.js';

export interface WebhookBridgeHandle {
  address: {
    host: string;
    port: number;
  };
  close(): Promise<void>;
}

export async function createWebhookBridgeServer(input: {
  config: BridgeConfig;
  service: FeiqueService;
  logger: Logger;
  readiness?: ServiceReadinessProbe;
}): Promise<WebhookBridgeHandle> {
  const eventDispatcher = new lark.EventDispatcher({
    encryptKey: input.config.feishu.encrypt_key,
    verificationToken: input.config.feishu.verification_token,
  }).register({
    'im.message.receive_v1': async (payload: unknown) => {
      const message = extractIncomingMessage(payload);
      if (!message) {
        return;
      }
      if (message.sender_type && message.sender_type !== 'user') {
        input.logger.info({ chatId: message.chat_id, senderType: message.sender_type, messageId: message.message_id }, 'Ignoring non-user message');
        return;
      }
      if (!shouldAllowChat(input.config.feishu, message.chat_id, message.chat_type)) {
        input.logger.info({ chatId: message.chat_id }, 'Ignoring message from disallowed chat');
        return;
      }
      await input.service.handleIncomingMessage(message);
    },
  });

  const cardDispatcher = new lark.CardActionHandler(
    {
      encryptKey: input.config.feishu.encrypt_key,
      verificationToken: input.config.feishu.verification_token,
    },
    async (payload: unknown) => {
      const action = extractCardAction(payload);
      if (!action) {
        return {
          header: {
            title: { tag: 'plain_text', content: '无法处理卡片事件' },
          },
          elements: [],
        };
      }
      return input.service.handleCardAction(action);
    },
  );

  const eventHandler = lark.adaptDefault(input.config.feishu.event_path, eventDispatcher, { autoChallenge: true });
  const cardHandler = lark.adaptDefault(input.config.feishu.card_path, cardDispatcher);

  const server = http.createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    if (request.url === '/healthz' || request.url === '/readyz') {
      const readiness = input.readiness?.snapshot() ?? {
        ok: true,
        ready: true,
        service: input.config.service.name,
        transport: 'webhook',
        stage: 'ready',
        startupWarnings: 0,
        startupErrors: 0,
        timestamp: new Date().toISOString(),
      };
      response.statusCode = request.url === '/readyz' ? (readiness.ready ? 200 : 503) : (readiness.ok ? 200 : 503);
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          ...readiness,
          event_path: input.config.feishu.event_path,
          card_path: input.config.feishu.card_path,
        }),
      );
      return;
    }

    if (request.url.startsWith(input.config.feishu.event_path)) {
      eventHandler(request, response);
      return;
    }

    if (request.url.startsWith(input.config.feishu.card_path)) {
      cardHandler(request, response);
      return;
    }

    response.statusCode = 404;
    response.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.config.feishu.port, input.config.feishu.host, () => {
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : input.config.feishu.port;
  input.logger.info(
    {
      host: input.config.feishu.host,
      port,
      eventPath: input.config.feishu.event_path,
      cardPath: input.config.feishu.card_path,
    },
    'Feishu webhook bridge started',
  );
  input.readiness?.markReady({
    host: input.config.feishu.host,
    port,
    eventPath: input.config.feishu.event_path,
    cardPath: input.config.feishu.card_path,
  });

  return {
    address: {
      host: input.config.feishu.host,
      port,
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function startWebhookBridge(input: {
  config: BridgeConfig;
  service: FeiqueService;
  logger: Logger;
  readiness?: ServiceReadinessProbe;
}): Promise<NodeJS.Signals> {
  const server = await createWebhookBridgeServer(input);
  return waitForShutdownSignal({
    logger: input.logger,
    onShutdown: async (signal) => {
      input.readiness?.markStopping({ signal, port: server.address.port });
      await server.close();
      input.readiness?.markStopped({ signal, port: server.address.port });
      input.logger.info({ signal, port: server.address.port }, 'Feishu webhook bridge stopped');
    },
  });
}
