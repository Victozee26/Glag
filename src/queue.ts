import * as dgram from 'node:dgram';

export interface OutboundPkt {
  dir: 'out';
  payload: Buffer;       // raw game data, no SOCKS5 header
  destAddr: string;
  destPort: number;
  relay: dgram.Socket;
}

export interface InboundPkt {
  dir: 'in';
  payload: Buffer;       // already re-wrapped with SOCKS5 UDP header
  clientAddr: string;
  clientPort: number;
  relay: dgram.Socket;
}

export type QueuedPkt = OutboundPkt | InboundPkt;

export class PacketQueue {
  private queue: QueuedPkt[] = [];
  private totalBursts = 0;
  private totalPackets = 0;

  private timer: NodeJS.Timeout | null = null;

  constructor(private holdMs: number) {}

  public push(pkt: QueuedPkt): void {
    this.queue.push(pkt);
  }

  public startBurstTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.queue.length === 0) return;

      const batch = this.queue.splice(0, this.queue.length);
      this.totalBursts++;
      this.totalPackets += batch.length;

      const outCount = batch.filter((p) => p.dir === 'out').length;
      const inCount  = batch.filter((p) => p.dir === 'in').length;

      process.stdout.write(
        `\r[BURST #${this.totalBursts}] 💥 Released ${batch.length} pkts ` +
        `(↑${outCount} out / ↓${inCount} in) | Total: ${this.totalPackets}   `
      );

      for (const pkt of batch) {
        if (pkt.dir === 'out') {
          pkt.relay.send(pkt.payload, pkt.destPort, pkt.destAddr, (err) => {
            if (err) console.error(`\n[OUT] Send failed: ${err.message}`);
          });
        } else {
          pkt.relay.send(pkt.payload, pkt.clientPort, pkt.clientAddr, (err) => {
            if (err) console.error(`\n[IN] Send failed: ${err.message}`);
          });
        }
      }
    }, this.holdMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
  }
}
