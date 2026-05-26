import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { BadVPNParser, type BadVPNPacket } from './badvpn-protocol.js';
import { PacketQueue } from './queue.js';

/**
 * badvpn-udpgw server — runs on 127.0.0.1:7300 for SocksDroid
 * Receives UDP packets tunneled through badvpn protocol over TCP
 * Applies burst delay and forwards to actual UDP destinations
 */
export class BadVPNServer {
  private server: net.Server | null = null;
  private udpSocket: dgram.Socket | null = null;
  private connections: Map<string, BadVPNConnection> = new Map();

  constructor(private queue: PacketQueue) {}

  /**
   * Start badvpn-udpgw server
   */
  public async listen(port: number = 7300): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        console.log(`[BadVPN] 🚀 badvpn-udpgw server listening on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }

  /**
   * Handle new connection from SocksDroid
   */
  private handleConnection(socket: net.Socket): void {
    const connId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[BadVPN] ↗ New connection: ${connId}`);

    const conn = new BadVPNConnection(socket, this.queue, this.udpSocket || undefined);
    this.connections.set(connId, conn);

    socket.on('data', (data) => conn.handleData(data));
    socket.on('end', () => {
      console.log(`[BadVPN] ↙ Connection closed: ${connId}`);
      conn.close();
      this.connections.delete(connId);
    });
    socket.on('error', (err) => {
      console.error(`[BadVPN] ✗ Error on ${connId}: ${err.message}`);
      conn.close();
      this.connections.delete(connId);
    });
  }

  /**
   * Stop badvpn server
   */
  public close(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

class BadVPNConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private responseSocket: dgram.Socket;

  constructor(
    private socket: net.Socket,
    private queue: PacketQueue,
    existingUdp?: dgram.Socket,
  ) {
    // Create UDP socket for sending responses
    if (existingUdp) {
      this.responseSocket = existingUdp;
    } else {
      this.responseSocket = dgram.createSocket('udp4');
    }
  }

  /**
   * Handle incoming badvpn data
   */
  public handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length > 0) {
      const result = BadVPNParser.parse(this.buffer);
      if (!result) break;

      const { packet, consumed } = result;
      this.buffer = this.buffer.subarray(consumed);

      this.processBadVPNPacket(packet);
    }
  }

  /**
   * Process parsed badvpn packet
   */
  private processBadVPNPacket(pkt: BadVPNPacket): void {
    console.log(
      `[BadVPN] 📦 Packet: ${pkt.addr}:${pkt.port} (${pkt.payload.length} bytes)`,
    );

    // Queue the packet with burst delay
    this.queue.push({
      dir: 'out',
      payload: pkt.payload,
      destAddr: pkt.addr,
      destPort: pkt.port,
      relay: this.responseSocket,
    });
  }

  /**
   * Close connection
   */
  public close(): void {
    this.socket.destroy();
    // Don't destroy responseSocket if it was passed in (shared)
  }
}
