import * as dgram from 'node:dgram';

export interface OutboundPkt {
  dir: 'out';
  payload: Buffer;
  destAddr: string;
  destPort: number;
  relay: dgram.Socket;
}

export interface InboundPkt {
  dir: 'in';
  payload: Buffer;
  clientAddr: string;
  clientPort: number;
  relay: dgram.Socket;
}

export type QueuedPkt = OutboundPkt | InboundPkt;

/**
 * Send packets with error handling and logging
 */
export class PacketSender {
  public static sendOutbound(pkt: OutboundPkt): Promise<void> {
    return new Promise((resolve) => {
      pkt.relay.send(pkt.payload, pkt.destPort, pkt.destAddr, (err) => {
        if (err) console.error(`[OUT] Send failed: ${err.message}`);
        resolve();
      });
    });
  }

  public static sendInbound(pkt: InboundPkt): Promise<void> {
    return new Promise((resolve) => {
      pkt.relay.send(pkt.payload, pkt.clientPort, pkt.clientAddr, (err) => {
        if (err) console.error(`[IN] Send failed: ${err.message}`);
        resolve();
      });
    });
  }

  /**
   * Send all packets in batch
   */
  public static async sendBatch(packets: QueuedPkt[]): Promise<void> {
    const promises = packets.map((pkt) =>
      pkt.dir === 'out'
        ? PacketSender.sendOutbound(pkt)
        : PacketSender.sendInbound(pkt),
    );
    await Promise.all(promises);
  }
}
