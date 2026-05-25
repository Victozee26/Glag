import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import * as dgram from 'node:dgram';
import { ProxyServer } from '../src/server.js';
import { PacketQueue } from '../src/queue.js';
import type { Config } from '../src/config.js';

const PROXY_PORT = 10800;
const HOLD_MS = 500;

describe('UDP Burst Proxy E2E', () => {
  let server: ProxyServer;
  let queue: PacketQueue;

  beforeAll(async () => {
    const config: Config = {
      port: PROXY_PORT,
      holdMs: HOLD_MS,
    };
    queue = new PacketQueue(config.holdMs);
    queue.startBurstTimer();
    server = new ProxyServer(config, queue);
    await server.listen();
  });

  afterAll(async () => {
    await server.stop();
    queue.stop();
  });

  it('should handle SOCKS5 handshake and TCP CONNECT with domain name', async () => {
    // 1. Setup mock TCP target
    const targetServer = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`ECHO: ${data.toString()}`);
      });
    });
    const targetPort = await new Promise<number>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        resolve((targetServer.address() as net.AddressInfo).port);
      });
    });

    // 2. Connect client to proxy
    const client = net.createConnection({ port: PROXY_PORT, host: '127.0.0.1' });
    
    await new Promise<void>((resolve) => {
      // 3. Handshake
      client.write(Buffer.from([0x05, 0x01, 0x00])); // VER, NMETHODS, METHODS
      client.once('data', (data) => {
        expect(data[0]).toBe(0x05); // VER
        expect(data[1]).toBe(0x00); // NO AUTH
        
        // 4. CONNECT to localhost via domain
        const domain = 'localhost';
        const cmd = Buffer.alloc(7 + domain.length);
        cmd[0] = 0x05; // VER
        cmd[1] = 0x01; // CMD: CONNECT
        cmd[2] = 0x00; // RSV
        cmd[3] = 0x03; // ATYP: DOMAIN
        cmd[4] = domain.length;
        cmd.write(domain, 5);
        cmd.writeUInt16BE(targetPort, 5 + domain.length);
        client.write(cmd);
        
        client.once('data', (data) => {
          expect(data[0]).toBe(0x05); // VER
          expect(data[1]).toBe(0x00); // REP: SUCCESS
          
          // 5. Send data
          client.write('Hello Proxy');
          client.once('data', (data) => {
            expect(data.toString()).toBe('ECHO: Hello Proxy');
            client.destroy();
            targetServer.close();
            resolve();
          });
        });
      });
    });
  });

  it('should handle UDP ASSOCIATE and burst packets', async () => {
    // 1. Setup mock UDP target
    const udpTarget = dgram.createSocket('udp4');
    const receivedMessages: string[] = [];
    const targetPort = await new Promise<number>((resolve) => {
      udpTarget.on('message', (msg) => {
        receivedMessages.push(msg.toString());
      });
      udpTarget.bind(0, '127.0.0.1', () => {
        resolve(udpTarget.address().port);
      });
    });

    // 2. SOCKS5 Handshake & UDP ASSOCIATE
    const clientTcp = net.createConnection({ port: PROXY_PORT, host: '127.0.0.1' });
    const relayInfo = await new Promise<{ port: number, host: string }>((resolve) => {
      clientTcp.write(Buffer.from([0x05, 0x01, 0x00]));
      clientTcp.once('data', () => {
        clientTcp.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // UDP ASSOCIATE
        clientTcp.once('data', (data) => {
          const port = data.readUInt16BE(8);
          const host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
          resolve({ port, host });
        });
      });
    });

    // 3. Send UDP packets to relay
    const clientUdp = dgram.createSocket('udp4');
    const sendPacket = (msg: string) => {
      const payload = Buffer.from(msg);
      // SOCKS5 UDP Header: RSV(2), FRAG(1), ATYP(1), ADDR(4), PORT(2)
      const header = Buffer.from([0x00, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]);
      header.writeUInt16BE(targetPort, 8);
      const pkt = Buffer.concat([header, payload]);
      clientUdp.send(pkt, relayInfo.port, relayInfo.host);
    };

    const startTime = Date.now();
    sendPacket('Pkt 1');
    sendPacket('Pkt 2');
    sendPacket('Pkt 3');

    // 4. Verify bursting
    await new Promise((r) => setTimeout(r, HOLD_MS / 2));
    expect(receivedMessages.length).toBe(0); // Should be held

    await new Promise((r) => setTimeout(r, HOLD_MS));
    expect(receivedMessages.length).toBe(3); // Should be released
    expect(receivedMessages).toContain('Pkt 1');
    expect(receivedMessages).toContain('Pkt 3');

    clientTcp.destroy();
    clientUdp.close();
    udpTarget.close();
  });

  it('should reject unsupported commands', async () => {
    const client = net.createConnection({ port: PROXY_PORT, host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      client.write(Buffer.from([0x05, 0x01, 0x00]));
      client.once('data', () => {
        client.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // BIND (unsupported)
        client.once('data', (data) => {
          expect(data[1]).toBe(0x07); // CMD_UNSUPPORTED
          client.destroy();
          resolve();
        });
      });
    });
  });
});
