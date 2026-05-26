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
import { BadVPNParser } from './badvpn-protocol.js';

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

    // Special case: CONNECT to 127.0.0.1:7300 → badvpn-udpgw protocol
    if (address === '127.0.0.1' && port === 7300) {
      console.log(`[TCP] ↪ CONNECT → 127.0.0.1:7300 — intercepting as badvpn-udpgw`);
      CMD_REPLY(0, address, port);

      // Enter badvpn mode: parse incoming data as badvpn packets
      this.handleBadVPNConnection(socket);
      return;
    }

    // Regular TCP relay for other destinations
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
   * Handle badvpn-udpgw protocol connection
   * 
   * Format (discovered by reverse-engineering SocksDroid):
   * [4 bytes: header/framing] [1 byte: type] [addr] [2 bytes: port (BE)] [payload]
   * 
   * For IPv4 type (0x00):
   * [4 bytes: header] [0x00] [4 bytes: IPv4] [2 bytes: port] [payload]
   */
  private handleBadVPNConnection(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[BadVPN] ✅ badvpn tunnel ready: ${clientId}`);

    let buffer = Buffer.alloc(0);
    const udpSocket = dgram.createSocket('udp4');
    let packetCount = 0;

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // Try to parse packets from buffer
      while (buffer.length >= 12) { // Minimum: 4 (header) + 1 (type) + 4 (IPv4) + 2 (port)
        const headerFrame = buffer[0];
        const frameLen = buffer[1]; // Might be part of length
        const typeOrLen = buffer[4];

        // Check if this looks like a valid packet start
        if (typeOrLen === 0x00) {
          // Likely IPv4 format: header(4) + type(1) + IPv4(4) + port(2) + payload
          if (buffer.length < 12) break;

          const ipBytes = buffer.subarray(5, 9);
          const destAddr = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
          const destPort = buffer.readUInt16BE(9);
          const payloadStart = 11;
          const payloadLen = buffer.length - payloadStart;

          // For now, assume single packet per frame (could implement length-prefixed)
          const payload = buffer.subarray(payloadStart);

          packetCount++;
          console.log(
            `[BadVPN] 📦 Packet #${packetCount}: ${destAddr}:${destPort} (${payloadLen} bytes) → queued for burst`,
          );

          // Queue the UDP packet with burst delay
          this.queue.push({
            dir: 'out',
            payload,
            destAddr,
            destPort,
            relay: udpSocket,
          });

          // Consume this packet from buffer
          buffer = buffer.subarray(payloadStart + payloadLen);
        } else {
          // Unknown format, skip byte and try again
          console.warn(`[BadVPN] Unknown packet type: 0x${(typeOrLen || 0).toString(16)}`);
          buffer = buffer.subarray(1);
        }
      }
    });

    socket.on('close', () => {
      console.log(`[BadVPN] ↙ Connection closed: ${clientId} (sent ${packetCount} packets)`);
      udpSocket.close();
    });

    socket.on('error', (err) => {
      console.error(`[BadVPN] ✗ Error: ${err.message}`);
      udpSocket.close();
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
