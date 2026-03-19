import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { ServiceReadinessProbe } from '../src/observability/readiness.js';
import { startMetricsServer } from '../src/observability/server.js';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe('metrics server readiness', () => {
  it('reports readiness state consistently across /healthz, /readyz, and /metrics', async () => {
    const readiness = new ServiceReadinessProbe('test-bridge');
    readiness.markStarting('long-connection');
    readiness.recordDoctorFindings([
      { level: 'warn', message: 'warn-1' },
      { level: 'error', message: 'error-1' },
    ]);

    const metrics = new MetricsRegistry();
    const server = await startMetricsServer({
      host: '127.0.0.1',
      port: 0,
      serviceName: 'test-bridge',
      logger,
      metrics,
      readiness,
    });
    handles.push(server);
    expect(server.address.port).toBeTypeOf('number');

    const healthStarting = await requestJson(`http://127.0.0.1:${server.address.port}/healthz`);
    const readyStarting = await requestJson(`http://127.0.0.1:${server.address.port}/readyz`);
    expect(healthStarting.statusCode).toBe(200);
    expect(readyStarting.statusCode).toBe(503);
    expect(readyStarting.body).toMatchObject({
      stage: 'starting',
      ready: false,
      startupWarnings: 1,
      startupErrors: 1,
    });

    readiness.recordDoctorFindings([{ level: 'warn', message: 'warn-1' }]);
    readiness.markReady({ transport: 'long-connection' });
    const readyLive = await requestJson(`http://127.0.0.1:${server.address.port}/readyz`);
    expect(readyLive.statusCode).toBe(200);
    expect(readyLive.body).toMatchObject({
      stage: 'ready',
      ready: true,
      startupWarnings: 1,
      startupErrors: 0,
    });

    const metricsOutput = await requestText(`http://127.0.0.1:${server.address.port}/metrics`);
    expect(metricsOutput.body).toContain('feique_service_ready 1');
    expect(metricsOutput.body).toContain('feique_service_live 1');
    expect(metricsOutput.body).toContain('feique_startup_warnings 1');
    expect(metricsOutput.body).toContain('feique_startup_errors 0');
  });
});

async function requestJson(url: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const result = await requestText(url);
  return {
    statusCode: result.statusCode,
    body: JSON.parse(result.body) as Record<string, unknown>,
  };
}

async function requestText(urlString: string): Promise<{ statusCode: number; body: string }> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}
