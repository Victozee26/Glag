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

  private buffer: Buffer = Buffer.alloc(0);

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
      const currentState = this.socks5.getState();

      if (currentState === 'associated') {
        if (this.mode === 'tcp' && this.tcpRelay) {
          this.tcpRelay.send(buf);
        }
        return;
      }

      this.buffer = Buffer.concat([this.buffer, buf]);

      while (this.buffer.length > 0) {
        const state = this.socks5.getState();

        if (state === 'auth') {
          const auth = this.socks5.handleAuth(this.buffer);
          if (!auth) break;

          this.buffer = this.buffer.subarray(auth.consumed);
          this.tcp.write(this.socks5.buildAuthResponse());
          continue;
        }

        if (state === 'cmd') {
          const cmd = this.socks5.handleCmd(this.buffer);
          if (!cmd) break;

          this.buffer = this.buffer.subarray(cmd.consumed);

          const cmdResp = cmd.resp;
          if (!cmdResp || !cmdResp.success) {
            this.tcp.write(this.socks5.buildCmdRejection());
            this.tcp.destroy();
            return;
          }

          if (cmdResp.type === 'tcp') {
            // Self-loop protection
            const localPort = this.tcp.localPort;
            if (
              (cmdResp.destAddr === '127.0.0.1' || cmdResp.destAddr === 'localhost') &&
              cmdResp.destPort === localPort
            ) {
              console.warn(`[TCP] Loop detected! Blocking connection to self.`);
              this.tcp.write(this.socks5.buildCmdRejection());
              this.tcp.destroy();
              return;
            }
            await this.setupTCPRelay(cmdResp.destAddr!, cmdResp.destPort!);
          } else if (cmdResp.type === 'udp') {
            await this.setupUDPRelay();
          }

          // If we have remaining data after association (unlikely for SOCKS5 but possible)
          if (this.buffer.length > 0 && this.socks5.getState() === 'associated') {
            if (this.mode === 'tcp' && this.tcpRelay) {
              this.tcpRelay.send(this.buffer);
              this.buffer = Buffer.alloc(0);
            }
          }
          break;
        }

        if (state === 'associated') {
          if (this.mode === 'tcp' && this.tcpRelay) {
            this.tcpRelay.send(this.buffer);
          }
          this.buffer = Buffer.alloc(0);
          break;
        }
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
    console.log(`[UDP] ℹ Setting up UDP relay...`);
    this.udpRelay = new UDPRelay();
    this.mode = 'udp';

    try {
      const relayPort = await this.udpRelay.bind();
      let localIP = (this.tcp.localAddress ?? '127.0.0.1').replace(
        '::ffff:',
        '',
      );

      // SOCKS5 response must be IPv4 for ATYP_IPV4
      if (localIP === '::1' || localIP.includes(':')) {
        localIP = '127.0.0.1';
      }

      this.udpRelay.onMessage((msg, rinfo) => {
        this.handleRelayMessage(msg, rinfo);
      });

      console.log(
        `[UDP] 📡 Responding to client: bind on ${localIP}:${relayPort}`,
      );
      this.tcp.write(this.socks5.buildCmdSuccess(relayPort, localIP));

      const clientId = `${this.tcp.remoteAddress}:${this.tcp.remotePort}`;
      console.log(`[UDP] ✓ Relay ready on port ${relayPort} for ${clientId}`);
    } catch (err) {
      console.error(`[UDP] ✗ Bind failed: ${(err as Error).message}`);
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

      let localIP = (this.tcp.localAddress ?? '127.0.0.1').replace(
        '::ffff:',
        '',
      );
      if (localIP === '::1' || localIP.includes(':')) {
        localIP = '127.0.0.1';
      }

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

    const normalizedAddr = rinfo.address.replace('::ffff:', '');
    console.log(
      `[UDP] 📦 Packet received: ${normalizedAddr}:${rinfo.port} (${msg.length} bytes)`,
    );

    // Lock client address on first message
    if (this.clientUDPAddr === null) {
      this.clientUDPAddr = normalizedAddr;
      this.clientUDPPort = rinfo.port;
      console.log(
        `[UDP] ✓ Client UDP locked: ${this.clientUDPAddr}:${this.clientUDPPort}`,
      );
    }

    const isFromClient =
      normalizedAddr === this.clientUDPAddr && rinfo.port === this.clientUDPPort;

    if (isFromClient) {
      console.log(`[UDP] ↗ Outbound from client (${msg.length} bytes)`);
      const routed = RelayRouter.routeOutbound(msg);
      if (!routed) {
        console.warn(`[UDP] ✗ Failed to parse outbound packet from client`);
        return;
      }

      const { destAddr, destPort } = routed;
      if (!destAddr || destPort === undefined) {
        console.warn(`[UDP] ✗ Missing destAddr or destPort`);
        return;
      }

      console.log(
        `[UDP] → Queueing outbound: ${destAddr}:${destPort} (payload: ${routed.payload.length} bytes)`,
      );
      this.queue.push({
        dir: 'out',
        payload: routed.payload,
        destAddr,
        destPort,
        relay: this.udpRelay.getSocket(),
      });
    } else {
      console.log(
        `[UDP] ↙ Inbound from upstream: ${normalizedAddr}:${rinfo.port}`,
      );
      if (!this.clientUDPAddr || !this.clientUDPPort) {
        console.warn(`[UDP] ✗ Client address not locked yet`);
        return;
      }

      const routed = RelayRouter.routeInbound(msg, rinfo);

      console.log(
        `[UDP] ← Queueing inbound: to client (payload: ${routed.payload.length} bytes)`,
      );
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

