import pino, { type LoggerOptions } from 'pino';

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info') {
  const options: LoggerOptions = {
    level,
    redact: {
      paths: [
        'app_secret',
        'appSecret',
        'feishu.app_secret',
        'config.feishu.app_secret',
        'encrypt_key',
        'verification_token',
        'feishu.encrypt_key',
        'feishu.verification_token',
        'config.feishu.encrypt_key',
        'config.feishu.verification_token',
        'access_token',
        'refresh_token',
        'tenant_access_token',
        'authorization',
        'Authorization',
        'headers.authorization',
        'headers.Authorization',
        'req.headers.authorization',
        'req.headers.Authorization',
        'err.config.headers.Authorization',
        'err.config.headers.authorization',
      ],
      censor: '<redacted>',
    },
  };
  if (process.env.NODE_ENV !== 'test') {
    options.transport = {
      target: 'pino/file',
      options: { destination: 1 },
    };
  }
  return pino(options);
}

export type Logger = ReturnType<typeof createLogger>;
