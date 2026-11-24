import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SignalingService, type SocketData } from './app';

/* --------------------------------------------------------------------------
   Meldrift signaling service

   Environment:
     MELDRIFT_PORT   default 8787
     MELDRIFT_HOST   default 127.0.0.1 (set 0.0.0.0 only behind TLS/proxy)
     MELDRIFT_DATA   default ./data/meldrift.db
     MELDRIFT_TRUST_PROXY   set 1 only behind a proxy you control, so
                            X-Forwarded-For is used for rate limiting
   -------------------------------------------------------------------------- */

const port = Number(process.env.MELDRIFT_PORT ?? 8787);
const hostname = process.env.MELDRIFT_HOST ?? '127.0.0.1';
const dataPath = resolve(process.env.MELDRIFT_DATA ?? './data/meldrift.db');

mkdirSync(dirname(dataPath), { recursive: true });
const service = new SignalingService(dataPath, {
  trustProxy: process.env.MELDRIFT_TRUST_PROXY === '1',
});

const server = Bun.serve<SocketData>({ 
  port,
  hostname,
  maxRequestBodySize: 64 * 1024,
  async fetch(request, bunServer) {
    return (await service.handle(request, bunServer)) ?? new Response('Not found', { status: 404 });
  },
  websocket: {
    idleTimeout: 90,
    maxPayloadLength: 64 * 1024,
    open(socket) {
      service.onOpen(socket);
    },
    message(socket, message) {
      service.onMessage(socket, message as string | Buffer);
    },
    close(socket) {
      service.onClose(socket);
    },
  },
  error(error) {
    console.error('[meldrift] unhandled', error);
    return new Response('Server error', { status: 500 });
  },
});

console.log(`Meldrift signaling listening on http://${server.hostname}:${server.port}`);
console.log(`Database: ${dataPath}`);

function shutdown(): void {
  console.log('Shutting down Meldrift signaling…');
  server.stop(true);
  service.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
