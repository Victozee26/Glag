import * as dgram from 'node:dgram';
import { parseUDPHeader, buildUDPHeader } from '../socks5/udp.js';

export interface MessageHandler {
  (msg: Buffer, rinfo: dgram.RemoteInfo): void;
}

interface AddressInfo {
  port: number;
}

/**
 * UDP relay socket manager — handles binding, message reception, and sending
 */
export class UDPRelay {
  private socket: dgram.Socket;
  private messageHandler: MessageHandler | null = null;

  constructor() {
    this.socket = dgram.createSocket('udp4');
  }

  /**
   * Bind relay socket to random port on localhost
   */
  public bind(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket.on('error', (err) => {
        reject(err);
      });

      this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        if (this.messageHandler) {
          this.messageHandler(msg, rinfo);
        }
      });

      this.socket.bind(0, '0.0.0.0', () => {
        const port = (this.socket.address() as AddressInfo).port;
        resolve(port);
      });
    });
  }

  /**
   * Set handler for incoming messages
   */
  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Send packet to destination
   */
  public send(payload: Buffer, port: number, addr: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(payload, port, addr, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Close relay socket
   */
  public close(): void {
    this.socket.close();
  }

  /**
   * Get relay port
   */
  public getPort(): number {
    return (this.socket.address() as AddressInfo).port;
  }

  /**
   * Get underlying socket (for PacketQueue)
   */
  public getSocket(): dgram.Socket {
    return this.socket;
  }
}

export interface RelayedMessage {
  direction: 'inbound' | 'outbound';
  payload: Buffer;
  destAddr?: string;
  destPort?: number;
  clientAddr?: string;
  clientPort?: number;
}

/**
 * Relay message router — separates inbound/outbound and parses SOCKS5 headers
 */
export class RelayRouter {
  /**
   * Route inbound message from upstream back to client with SOCKS5 header
   */
  public static routeInbound(
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
  ): RelayedMessage {
    const hdr = buildUDPHeader(rinfo.address, rinfo.port);
    const wrapped = Buffer.concat([hdr, msg]);

    return {
      direction: 'inbound',
      payload: wrapped,
      destAddr: rinfo.address,
      destPort: rinfo.port,
    };
  }

  /**
   * Route outbound message from client to upstream (parse SOCKS5 header)
   */
  public static routeOutbound(msg: Buffer): RelayedMessage | null {
    const parsed = parseUDPHeader(msg);
    if (!parsed) return null;

    return {
      direction: 'outbound',
      payload: parsed.payload,
      destAddr: parsed.destAddr,
      destPort: parsed.destPort,
    };
  }
}
