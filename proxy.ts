#!/usr/bin/env ts-node

/**
 * UDP Burst Proxy — Free Fire Edition
 *
 * How it works:
 *   SocksDroid → this proxy (SOCKS5 on 127.0.0.1:PORT) → Free Fire servers
 *
 * All UDP packets are held in a queue for --hold ms,
 * then ALL dumped at once (burst). Both directions affected.
 *
 * Usage:
 *   npx ts-node src/proxy.ts --port 1080 --hold 2000
 */

import * as net from 'net';
import * as dgram from 'dgram';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface Config {
  port: number;    // SOCKS5 TCP listen port
  holdMs: number;  // ms to hold packets before burst-releasing
}

function parseArgs(): Config {
  const raw = process.argv.slice(2);
  let port = 1080;
  let holdMs = 2000;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--port' && raw[i + 1]) {
      port = parseInt(raw[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('[CONFIG] Invalid --port. Use 1–65535.');
        process.exit(1);
      }
    }
    if (raw[i] === '--hold' && raw[i + 1]) {
      holdMs = parseInt(raw[i + 1], 10);
      if (isNaN(holdMs) || holdMs < 0) {
        console.error('[CONFIG] Invalid --hold. Use positive ms e.g. 2000');
        process.exit(1);
      }
    }
  }

  return { port, holdMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKS5 Constants
// ─────────────────────────────────────────────────────────────────────────────

const SOCKS5_VERSION   = 0x05;
const AUTH_NONE        = 0x00;
const CMD_UDP_ASSOC    = 0x03;
const REPLY_OK         = 0x00;
const REPLY_CMD_UNSUP  = 0x07;
const ATYP_IPV4        = 0x01;
const ATYP_DOMAIN      = 0x03;
const ATYP_IPV6        = 0x04;

// ─────────────────────────────────────────────────────────────────────────────
// Packet Queue Types
// ─────────────────────────────────────────────────────────────────────────────

interface OutboundPkt {
  dir: 'out';
  payload: Buffer;       // raw game data, no SOCKS5 header
  destAddr: string;
  destPort: number;
  relay: dgram.Socket;
}

interface InboundPkt {
  dir: 'in';
  payload: Buffer;       // already re-wrapped with SOCKS5 UDP header
  clientAddr: string;
  clientPort: number;
  relay: dgram.Socket;
}

type QueuedPkt = OutboundPkt | InboundPkt;

// ─────────────────────────────────────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────────────────────────────────────

const config = parseArgs();
const queue: QueuedPkt[] = [];
let totalBursts = 0;
let totalPackets = 0;

// ─────────────────────────────────────────────────────────────────────────────
// SOCKS5 UDP Header: Parse
// ─────────────────────────────────────────────────────────────────────────────
//
//  +-----+------+------+----------+----------+---------+
//  | RSV | FRAG | ATYP | DST.ADDR | DST.PORT |  DATA   |
//  +-----+------+------+----------+----------+---------+
//  |  2  |  1   |  1   | variable |    2     | variable|
//  +-----+------+------+----------+----------+---------+

interface ParsedUDPHeader {
  destAddr: string;
  destPort: number;
  payload: Buffer;
}

function parseUDPHeader(buf: Buffer): ParsedUDPHeader | null {
  if (buf.length < 10) return null;

  // Fragmentation not supported — drop fragmented packets
  if (buf[2] !== 0x00) return null;

  const atyp = buf[3];
  let destAddr: string;
  let offset: number;

  switch (atyp) {
    case ATYP_IPV4: {
      if (buf.length < 10) return null;
      destAddr = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      offset = 8;
      break;
    }
    case ATYP_DOMAIN: {
      const len = buf[4];
      if (buf.length < 5 + len + 2) return null;
      destAddr = buf.slice(5, 5 + len).toString('utf8');
      offset = 5 + len;
      break;
    }
    case ATYP_IPV6: {
      if (buf.length < 22) return null;
      const parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
      }
      destAddr = parts.join(':');
      offset = 20;
      break;
    }
    default:
      return null;
  }

  const destPort = buf.readUInt16BE(offset);
  const payload = buf.slice(offset + 2);
  return { destAddr, destPort, payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKS5 UDP Header: Build (for wrapping responses back to client)
// ─────────────────────────────────────────────────────────────────────────────

function buildUDPHeader(addr: string, port: number): Buffer {
  const ipv4Parts = addr.split('.').map(Number);
  const isIPv4 =
    ipv4Parts.length === 4 && ipv4Parts.every((n) => n >= 0 && n <= 255);

  if (isIPv4) {
    const hdr = Buffer.alloc(10);
    hdr[0] = 0x00; hdr[1] = 0x00;  // RSV
    hdr[2] = 0x00;                  // FRAG
    hdr[3] = ATYP_IPV4;
    ipv4Parts.forEach((b, i) => { hdr[4 + i] = b; });
    hdr.writeUInt16BE(port, 8);
    return hdr;
  }

  // Domain fallback
  const domBuf = Buffer.from(addr, 'utf8');
  const hdr = Buffer.alloc(5 + domBuf.length + 2);
  hdr[0] = 0x00; hdr[1] = 0x00;
  hdr[2] = 0x00;
  hdr[3] = ATYP_DOMAIN;
  hdr[4] = domBuf.length;
  domBuf.copy(hdr, 5);
  hdr.writeUInt16BE(port, 5 + domBuf.length);
  return hdr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Burst Release Timer
// Fires every holdMs. Dumps all queued packets at once.
// ─────────────────────────────────────────────────────────────────────────────

function startBurstTimer(): void {
  setInterval(() => {
    if (queue.length === 0) return;

    const batch = queue.splice(0, queue.length);
    totalBursts++;
    totalPackets += batch.length;

    const outCount = batch.filter((p) => p.dir === 'out').length;
    const inCount  = batch.filter((p) => p.dir === 'in').length;

    process.stdout.write(
      `\r[BURST #${totalBursts}] 💥 Released ${batch.length} pkts ` +
      `(↑${outCount} out / ↓${inCount} in) | Total: ${totalPackets}   `
    );

    for (const pkt of batch) {
      if (pkt.dir === 'out') {
        pkt.relay.send(pkt.payload, pkt.destPort, pkt.destAddr, (err) => {
          if (err) logError(`[OUT] Send failed: ${err.message}`);
        });
      } else {
        pkt.relay.send(pkt.payload, pkt.clientPort, pkt.clientAddr, (err) => {
          if (err) logError(`[IN] Send failed: ${err.message}`);
        });
      }
    }
  }, config.holdMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKS5 TCP Client Handler
// Each connecting client gets its own UDP relay socket
// ─────────────────────────────────────────────────────────────────────────────

function handleClient(tcp: net.Socket): void {
  type State = 'auth' | 'cmd' | 'associated';
  let state: State = 'auth';

  let relay: dgram.Socket | null = null;
  let clientUDPAddr: string | null = null;
  let clientUDPPort: number | null = null;

  const clientId = `${tcp.remoteAddress}:${tcp.remotePort}`;
  console.log(`\n[TCP] ↗ New client: ${clientId}`);

  tcp.on('data', (buf: Buffer) => {
    try {
      // ── Step 1: Auth handshake ──────────────────────────────────────────
      if (state === 'auth') {
        if (buf[0] !== SOCKS5_VERSION) {
          logError(`[AUTH] Bad version: ${buf[0]}`);
          tcp.destroy();
          return;
        }
        // Accept with no auth required
        tcp.write(Buffer.from([SOCKS5_VERSION, AUTH_NONE]));
        state = 'cmd';
        return;
      }

      // ── Step 2: Command request ─────────────────────────────────────────
      if (state === 'cmd') {
        if (buf[0] !== SOCKS5_VERSION) {
          tcp.destroy();
          return;
        }

        const cmd = buf[1];

        // We ONLY support UDP ASSOCIATE
        if (cmd !== CMD_UDP_ASSOC) {
          console.log(`[CMD] Unsupported command: 0x${cmd.toString(16)}`);
          tcp.write(Buffer.from([
            SOCKS5_VERSION, REPLY_CMD_UNSUP, 0x00,
            ATYP_IPV4, 0, 0, 0, 0, 0, 0
          ]));
          tcp.destroy();
          return;
        }

        // Spin up UDP relay
        relay = dgram.createSocket('udp4');

        relay.on('error', (err) => {
          logError(`[RELAY] Socket error: ${err.message}`);
        });

        relay.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          if (!relay) return;

          // First packet locks in client's UDP address
          if (clientUDPAddr === null) {
            clientUDPAddr = rinfo.address;
            clientUDPPort = rinfo.port;
            console.log(`\n[UDP] Client UDP locked: ${clientUDPAddr}:${clientUDPPort}`);
          }

          const isFromClient = rinfo.address === clientUDPAddr;

          if (isFromClient) {
            // ── Outgoing: client → game server ───────────────────────────
            const parsed = parseUDPHeader(msg);
            if (!parsed) return;

            queue.push({
              dir: 'out',
              payload: parsed.payload,
              destAddr: parsed.destAddr,
              destPort: parsed.destPort,
              relay,
            });
          } else {
            // ── Incoming: game server → client ────────────────────────────
            if (!clientUDPAddr || !clientUDPPort) return;

            const hdr = buildUDPHeader(rinfo.address, rinfo.port);
            const wrapped = Buffer.concat([hdr, msg]);

            queue.push({
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

          // Reply to client with relay address
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

      // state === 'associated': TCP connection just keeps UDP session alive
      // SocksDroid holds this TCP conn open; if it closes, session ends

    } catch (err) {
      logError(`[HANDLER] Unhandled: ${(err as Error).message}`);
      tcp.destroy();
    }
  });

  tcp.on('close', () => {
    console.log(`\n[TCP] ↘ Client disconnected: ${clientId}`);
    relay?.close();
    relay = null;
  });

  tcp.on('error', (err) => {
    logError(`[TCP] ${clientId}: ${err.message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function logError(msg: string): void {
  console.error(`\n${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║      UDP BURST PROXY — Free Fire         ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`  Port       : ${config.port}`);
console.log(`  Hold (ms)  : ${config.holdMs}ms`);
console.log(`  Mode       : Burst — hold all → release all`);
console.log('');
console.log('  SocksDroid → 127.0.0.1:' + config.port);
console.log('');

startBurstTimer();

const server = net.createServer(handleClient);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${config.port} is already in use. Change with --port`);
  } else {
    console.error('[SERVER] Fatal:', err.message);
  }
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[PROXY] ✅ Listening on 127.0.0.1:${config.port}`);
  console.log('[PROXY] Waiting for SocksDroid...\n');
});
