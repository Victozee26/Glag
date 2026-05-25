import * as net from 'node:net';
import { ClientConnection } from './connection.js';
import { PacketQueue } from './queue.js';
import type { Config } from './config.js';

/**
 * TCP server — manages client connections
 */
export class ProxyServer {
  private server: net.Server;

  constructor(
    private config: Config,
    private queue: PacketQueue,
  ) {
    this.server = net.createServer((tcp) => {
      this.handleNewClient(tcp);
    });
  }

  public listen(): void {
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[SERVER] Port ${this.config.port} is already in use. Change with --port`,
        );
      } else {
        console.error('[SERVER] Fatal:', err.message);
      }
      process.exit(1);
    });

    this.server.listen(this.config.port, '127.0.0.1', () => {
      console.log(`[PROXY] ✅ Listening on 127.0.0.1:${this.config.port}`);
      console.log('[PROXY] Waiting for SocksDroid...\n');
    });
  }

  /**
   * Handle new TCP client connection
   */
  private handleNewClient(tcp: net.Socket): void {
    const clientId = `${tcp.remoteAddress}:${tcp.remotePort}`;
    console.log(`\n[TCP] ↗ New client: ${clientId}`);

    const conn = new ClientConnection(tcp, this.queue);

    tcp.on('data', (buf: Buffer) => {
      void conn.handleData(buf);
    });

    tcp.on('close', () => {
      conn.close();
    });

    tcp.on('error', (err) => {
      conn.handleError(err);
    });
  }
}
