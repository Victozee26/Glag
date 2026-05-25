import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { 
  SOCKS5_VERSION, 
  AUTH_NONE, 
  CMD_UDP_ASSOC, 
  REPLY_OK, 
  REPLY_CMD_UNSUP, 
  ATYP_IPV4 
} from './socks5/constants.js';
import { parseUDPHeader, buildUDPHeader } from './socks5/udp.js';
import { PacketQueue } from './queue.js';
import type { Config } from './config.js';

export class ProxyServer {
  private server: net.Server;

  constructor(private config: Config, private queue: PacketQueue) {
    this.server = net.createServer((tcp) => this.handleClient(tcp));
  }

  public listen(): void {
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[SERVER] Port ${this.config.port} is already in use. Change with --port`);
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

  private handleClient(tcp: net.Socket): void {
    type State = 'auth' | 'cmd' | 'associated';
    let state: State = 'auth';

    let relay: dgram.Socket | null = null;
    let clientUDPAddr: string | null = null;
    let clientUDPPort: number | null = null;

    const clientId = `${tcp.remoteAddress}:${tcp.remotePort}`;
    console.log(`\n[TCP] ↗ New client: ${clientId}`);

    tcp.on('data', (buf: Buffer) => {
      try {
        if (state === 'auth') {
          if (buf[0] !== SOCKS5_VERSION) {
            console.error(`\n[AUTH] Bad version: ${buf[0]}`);
            tcp.destroy();
            return;
          }
          tcp.write(Buffer.from([SOCKS5_VERSION, AUTH_NONE]));
          state = 'cmd';
          return;
        }

        if (state === 'cmd') {
          if (buf[0] !== SOCKS5_VERSION) {
            tcp.destroy();
            return;
          }

          const cmd = buf[1];
          if (cmd === undefined || cmd !== CMD_UDP_ASSOC) {
            console.log(`[CMD] Unsupported command: 0x${cmd?.toString(16)}`);
            tcp.write(Buffer.from([
              SOCKS5_VERSION, REPLY_CMD_UNSUP, 0x00,
              ATYP_IPV4, 0, 0, 0, 0, 0, 0
            ]));
            tcp.destroy();
            return;
          }

          relay = dgram.createSocket('udp4');
          relay.on('error', (err) => {
            console.error(`\n[RELAY] Socket error: ${err.message}`);
          });

          relay.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
            if (!relay) return;

            if (clientUDPAddr === null) {
              clientUDPAddr = rinfo.address;
              clientUDPPort = rinfo.port;
              console.log(`\n[UDP] Client UDP locked: ${clientUDPAddr}:${clientUDPPort}`);
            }

            const isFromClient = rinfo.address === clientUDPAddr;

            if (isFromClient) {
              const parsed = parseUDPHeader(msg);
              if (!parsed) return;

              this.queue.push({
                dir: 'out',
                payload: parsed.payload,
                destAddr: parsed.destAddr,
                destPort: parsed.destPort,
                relay,
              });
            } else {
              if (!clientUDPAddr || !clientUDPPort) return;

              const hdr = buildUDPHeader(rinfo.address, rinfo.port);
              const wrapped = Buffer.concat([hdr, msg]);

              this.queue.push({
                dir: 'in',
                payload: wrapped,
                clientAddr: clientUDPAddr,
                clientPort: clientUDPPort,
                relay,
              });
            }
          });

          relay.bind(0, '0.0.0.0', () => {
            const relayPort = (relay as dgram.Socket).address().port;
            const localIP   = (tcp.localAddress ?? '127.0.0.1').replace('::ffff:', '');
            const ipBytes   = localIP.split('.').map(Number);

            const reply = Buffer.alloc(10);
            reply[0] = SOCKS5_VERSION;
            reply[1] = REPLY_OK;
            reply[2] = 0x00;
            reply[3] = ATYP_IPV4;
            ipBytes.forEach((b, i) => { reply[4 + i] = b; });
            reply.writeUInt16BE(relayPort, 8);

            tcp.write(reply);
            state = 'associated';

            console.log(`[UDP] Relay ready on port ${relayPort} for ${clientId}`);
          });
        }
      } catch (err) {
        console.error(`\n[HANDLER] Unhandled: ${(err as Error).message}`);
        tcp.destroy();
      }
    });

    tcp.on('close', () => {
      console.log(`\n[TCP] ↘ Client disconnected: ${clientId}`);
      relay?.close();
      relay = null;
    });

    tcp.on('error', (err) => {
      console.error(`\n[TCP] ${clientId}: ${err.message}`);
    });
  }
}
