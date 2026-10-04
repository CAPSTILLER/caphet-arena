import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

/** Start a local HTTP server for an app. Port 0 picks a free port. */
export function startServer(app: Hono, port = 0): Promise<{ url: string; port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        port: info.port,
        close: () =>
          new Promise<void>((res) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
