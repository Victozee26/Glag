/// <reference path="../types/socks5server.d.ts" />

import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as dgram from 'node:dgram';
const require = createRequire(import.meta.url);
const socks5server = require('socks5server') as any;
import { TCPRelay } from './relay/tcp-relay.js';
import { RelayRouter } from './relay/udp-relay.js';
import { PacketQueue } from './queue.js';
import type { Config } from './config.js';

/**
 * SOCKS5 server using socks5server library — manages client connections
 */
export class ProxyServer {
  private server: any;

  constructor(
    private config: Config,
    private queue: PacketQueue,
  ) {
    this.server = socks5server.createSocksServer();

    // Handle TCP CONNECT requests
    this.server.on(
      'tcp',
      (socket: net.Socket, address: string, port: number, CMD_REPLY: any) => {
        this.handleTCPRequest(socket, address, port, CMD_REPLY);
      },
    );

    // Handle UDP ASSOCIATE requests
    this.server.on(
      'udp',
      (socket: dgram.Socket, clientAddr: string, clientPort: number, CMD_REPLY: any) => {
        this.handleUDPRequest(socket, clientAddr, clientPort, CMD_REPLY);
      },
    );

    // Error handling
    this.server.on('error', (err: any) => {
      console.error('[SERVER] Fatal error:', err.message);
    });

    this.server.on('client_error', (socket: any, err: any) => {
      console.error(`[CLIENT] Error: ${err.message}`);
    });

    this.server.on('socks_error', (socket: any, err: any) => {
      console.error(`[SOCKS] Error: ${err.message}`);
    });
  }

  public listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, '127.0.0.1', () => {
        console.log(`[PROXY] ✅ Listening on 127.0.0.1:${this.config.port}`);
        console.log('[PROXY] Waiting for SocksDroid...\n');
        resolve();
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(
            `[SERVER] Port ${this.config.port} is already in use. Change with --port`,
          );
        } else {
          console.error('[SERVER] Fatal:', err.message);
        }
        reject(err);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /**
   * Handle TCP CONNECT request from socks5server
   */
  private handleTCPRequest(
    socket: net.Socket,
    address: string,
    port: number,
    CMD_REPLY: any,
  ): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`\n[TCP] ↗ New connection: ${clientId} → ${address}:${port}`);

    const relay = new TCPRelay(socket);
    relay
      .connect(address, port)
      .then(() => {
        console.log(`[TCP] ✅ Connected to ${address}:${port}`);
        CMD_REPLY(0, address, port);

        // Forward client → server
        socket.on('data', (data: Buffer) => {
          relay.send(data);
        });

        socket.on('close', () => {
          console.log(`[TCP] ↙ Client disconnected: ${clientId}`);
          relay.close();
        });

        socket.on('error', (err) => {
          console.error(`[TCP] Socket error: ${err.message}`);
          relay.close();
        });
      })
      .catch((err) => {
        console.error(`[TCP] ❌ Connection failed: ${err.message}`);
        CMD_REPLY(1);
        socket.destroy();
      });
  }

  /**
   * Handle UDP ASSOCIATE request from socks5server
   */
  private handleUDPRequest(
    socket: dgram.Socket,
    clientAddr: string,
    clientPort: number,
    CMD_REPLY: any,
  ): void {
    const relayAddr = socket.address();
    console.log(`\n[UDP] ↗ UDP ASSOCIATE from ${clientAddr}:${clientPort}`);
    console.log(`[UDP] ✅ Relay socket bound to 127.0.0.1:${relayAddr.port}`);

    // Reply success
    CMD_REPLY(0, '127.0.0.1', relayAddr.port);

    // Start burst timer once UDP is established
    this.queue.startBurstTimer();

    // Track client for bidirectional communication
    let lockedClientAddr: string | null = null;
    let lockedClientPort: number | null = null;

    // Handle incoming UDP packets on relay socket
    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const normalizedAddr = rinfo.address.replace('::ffff:', '');

      // Lock client address on first message
      if (lockedClientAddr === null) {
        lockedClientAddr = normalizedAddr;
        lockedClientPort = rinfo.port;
        console.log(
          `[UDP] ✓ Client UDP locked: ${lockedClientAddr}:${lockedClientPort}`,
        );
      }

      const isFromClient =
        normalizedAddr === lockedClientAddr && rinfo.port === lockedClientPort;

      if (isFromClient) {
        // Outbound: from client to game server (parse SOCKS5 header)
        console.log(`[UDP] ↗ Outbound from client (${msg.length} bytes)`);
        const routed = RelayRouter.routeOutbound(msg);
        if (!routed) {
          console.error(
            `[UDP-RX] Failed to parse SOCKS5 header from ${normalizedAddr}:${rinfo.port}`,
          );
          return;
        }

        if (!routed.destAddr || routed.destPort === undefined) {
          console.error(`[UDP-RX] Missing destination in parsed packet`);
          return;
        }

        console.log(
          `[UDP] → Queueing outbound: ${routed.destAddr}:${routed.destPort} (${routed.payload.length} bytes)`,
        );

        this.queue.push({
          dir: 'out',
          payload: routed.payload,
          destAddr: routed.destAddr,
          destPort: routed.destPort,
          relay: socket,
        });
      } else {
        // Inbound: from game server back to client (wrap with SOCKS5 header)
        console.log(
          `[UDP] ↙ Inbound from upstream: ${normalizedAddr}:${rinfo.port} (${msg.length} bytes)`,
        );

        if (lockedClientAddr === null || lockedClientPort === null) {
          console.error(`[UDP] Client address not locked yet`);
          return;
        }

        const routed = RelayRouter.routeInbound(msg, rinfo);
        console.log(
          `[UDP] ← Queueing inbound: to client (${routed.payload.length} bytes)`,
        );

        this.queue.push({
          dir: 'in',
          payload: routed.payload,
          clientAddr: lockedClientAddr,
          clientPort: lockedClientPort,
          relay: socket,
        });
      }
    });

    socket.on('error', (err) => {
      console.error(`[UDP] Socket error: ${err.message}`);
    });
  }
}
