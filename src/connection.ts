import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { SOCKS5Handler } from './socks5/handler.js';
import { UDPRelay, RelayRouter } from './relay/udp-relay.js';
import { TCPRelay } from './relay/tcp-relay.js';
import { PacketQueue } from './queue.js';

/**
 * TCP connection handler — manages lifecycle and state for one client
 */
export class ClientConnection {
  private socks5: SOCKS5Handler;
  private tcpRelay: TCPRelay | null = null;
  private udpRelay: UDPRelay | null = null;
  private clientUDPAddr: string | null = null;
  private clientUDPPort: number | null = null;
  private mode: 'tcp' | 'udp' | null = null;

  constructor(
    private tcp: net.Socket,
    private queue: PacketQueue,
  ) {
    this.socks5 = new SOCKS5Handler();
  }

  /**
   * Handle incoming TCP data and manage protocol handshake
   */
  public async handleData(buf: Buffer): Promise<void> {
    try {
      const state = this.socks5.getState();

      if (state === 'auth') {
        const authResp = this.socks5.handleAuth(buf);
        if (!authResp) {
          console.error(`[AUTH] Bad version: ${buf[0]}`);
          this.tcp.destroy();
          return;
        }
        this.tcp.write(this.socks5.buildAuthResponse());
        return;
      }

      if (state === 'cmd') {
        const cmdResp = this.socks5.handleCmd(buf);
        if (!cmdResp || !cmdResp.success) {
          const cmd = buf[1] ?? 0;
          console.log(`[CMD] Unsupported command: 0x${cmd.toString(16)}`);
          this.tcp.write(this.socks5.buildCmdRejection());
          this.tcp.destroy();
          return;
        }

        // Route based on command type
        if (cmdResp.type === 'tcp') {
          await this.setupTCPRelay(cmdResp.destAddr!, cmdResp.destPort!);
        } else if (cmdResp.type === 'udp') {
          await this.setupUDPRelay();
        }
        return;
      }
    } catch (err) {
      console.error(`[HANDLER] Unhandled: ${(err as Error).message}`);
      this.tcp.destroy();
    }
  }

  /**
   * Setup UDP relay socket and respond to client
   */
  private async setupUDPRelay(): Promise<void> {
    this.udpRelay = new UDPRelay();

    try {
      const relayPort = await this.udpRelay.bind();
      const localIP = (this.tcp.localAddress ?? '127.0.0.1').replace(
        '::ffff:',
        '',
      );

      this.udpRelay.onMessage((msg, rinfo) => {
        this.handleRelayMessage(msg, rinfo);
      });

      this.tcp.write(this.socks5.buildCmdSuccess(relayPort, localIP));

      const clientId = `${this.tcp.remoteAddress}:${this.tcp.remotePort}`;
      console.log(`[UDP] Relay ready on port ${relayPort} for ${clientId}`);
    } catch (err) {
      console.error(`[RELAY] Bind failed: ${(err as Error).message}`);
      this.tcp.destroy();
    }
  }

  /**
   * Setup TCP relay and respond to client
   */
  private async setupTCPRelay(
    destAddr: string,
    destPort: number,
  ): Promise<void> {
    this.tcpRelay = new TCPRelay(this.tcp);
    this.mode = 'tcp';

    try {
      await this.tcpRelay.connect(destAddr, destPort);

      const localIP = (this.tcp.localAddress ?? '127.0.0.1').replace(
        '::ffff:',
        '',
      );
      const localPort = this.tcp.localPort ?? 0;

      this.tcp.write(this.socks5.buildTCPSuccess(localIP, localPort));

      const clientId = `${this.tcp.remoteAddress}:${this.tcp.remotePort}`;
      console.log(
        `[TCP] Tunnel established: ${clientId} → ${destAddr}:${destPort}`,
      );
    } catch (err) {
      console.error(`[TCP] Connection failed: ${(err as Error).message}`);
      this.tcp.destroy();
    }
  }

  /**
   * Handle UDP message from relay — route inbound/outbound
   */
  private handleRelayMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!this.udpRelay) return;

    // Lock client address on first message
    if (this.clientUDPAddr === null) {
      this.clientUDPAddr = rinfo.address;
      this.clientUDPPort = rinfo.port;
      console.log(
        `[UDP] Client UDP locked: ${this.clientUDPAddr}:${this.clientUDPPort}`,
      );
    }

    const isFromClient = rinfo.address === this.clientUDPAddr;

    if (isFromClient) {
      const routed = RelayRouter.routeOutbound(msg);
      if (!routed) return;

      const { destAddr, destPort } = routed;
      if (!destAddr || destPort === undefined) return;

      this.queue.push({
        dir: 'out',
        payload: routed.payload,
        destAddr,
        destPort,
        relay: this.udpRelay.getSocket(),
      });
    } else {
      if (!this.clientUDPAddr || !this.clientUDPPort) return;

      const routed = RelayRouter.routeInbound(msg, rinfo);

      this.queue.push({
        dir: 'in',
        payload: routed.payload,
        clientAddr: this.clientUDPAddr,
        clientPort: this.clientUDPPort,
        relay: this.udpRelay.getSocket(),
      });
    }
  }

  /**
   * Cleanup when client disconnects
   */
  public close(): void {
    const clientId = `${this.tcp.remoteAddress}:${this.tcp.remotePort}`;
    console.log(`[TCP] ↘ Client disconnected: ${clientId}`);
    this.tcpRelay?.close();
    this.udpRelay?.close();
    this.tcpRelay = null;
    this.udpRelay = null;
  }

  /**
   * Handle TCP errors
   */
  public handleError(err: Error): void {
    const clientId = `${this.tcp.remoteAddress}:${this.tcp.remotePort}`;
    console.error(`[TCP] ${clientId}: ${err.message}`);
  }
}

