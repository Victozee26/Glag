/**
 * badvpn-udpgw protocol implementation
 * Used by SocksDroid for UDP tunneling over TCP
 *
 * Packet structure:
 * [1 byte: flags] [1 byte: rsv] [2 bytes: addr type] [variable: addr] [2 bytes: port] [2 bytes: length] [N bytes: data]
 *
 * Address types:
 * 0x04 = IPv4 (4 bytes)
 * 0x06 = IPv6 (16 bytes)
 * 0x03 = Domain name (1 byte length + domain)
 */

export interface BadVPNPacket {
  flags: number;
  addrType: number;
  addr: string;
  port: number;
  payload: Buffer;
}

export class BadVPNParser {
  /**
   * Parse incoming badvpn packet
   */
  static parse(data: Buffer): { packet: BadVPNPacket; consumed: number } | null {
    if (data.length < 7) return null; // minimum: flags(1) + rsv(1) + type(2) + port(2) + len(2)

    let offset = 0;
    const flags = data[offset++];
    const rsv = data[offset++];
    const addrType = data.readUInt16BE(offset);
    offset += 2;

    // Debug logging
    if (addrType > 0x06) {
      console.log(
        `[BadVPN-Debug] Invalid packet start: ${data.subarray(0, Math.min(16, data.length)).toString('hex')}`,
      );
    }

    let addr: string;
    let addrLen: number;

    if (addrType === 0x04) {
      // IPv4
      if (data.length < offset + 4) return null;
      addr = Array.from(data.subarray(offset, offset + 4)).join('.');
      addrLen = 4;
      offset += 4;
    } else if (addrType === 0x06) {
      // IPv6
      if (data.length < offset + 16) return null;
      const ipv6 = data.subarray(offset, offset + 16);
      addr = ipv6Array2String(ipv6);
      addrLen = 16;
      offset += 16;
    } else if (addrType === 0x03) {
      // Domain name
      if (data.length < offset + 1) return null;
      const domainLen: number = data[offset]!;
      if (data.length < offset + 1 + domainLen) return null;
      addr = data.subarray(offset + 1, offset + 1 + domainLen).toString('utf-8');
      addrLen = 1 + domainLen;
      offset += addrLen;
    } else {
      console.warn(`[BadVPN] Unknown address type: ${addrType}`);
      return null;
    }

    if (data.length < offset + 4) return null; // port(2) + len(2)

    const port = data.readUInt16BE(offset);
    offset += 2;
    const len = data.readUInt16BE(offset);
    offset += 2;

    if (data.length < offset + len) return null;

    const payload = data.subarray(offset, offset + len);
    offset += len;

    return {
      packet: {
        flags: flags || 0,
        addrType,
        addr,
        port,
        payload: Buffer.from(payload),
      },
      consumed: offset,
    };
  }

  /**
   * Build badvpn response packet
   */
  static buildResponse(
    addr: string,
    port: number,
    payload: Buffer,
  ): Buffer {
    const parts: Buffer[] = [];

    // flags (1 byte) - 0x00 for response
    parts.push(Buffer.from([0x00]));

    // rsv (1 byte)
    parts.push(Buffer.from([0x00]));

    // Determine address type
    const isIPv4 = /^(\d+\.){3}\d+$/.test(addr);
    const isIPv6 = addr.includes(':');

    if (isIPv4) {
      // IPv4
      parts.push(Buffer.from([0x00, 0x04])); // addr type
      const octets = addr.split('.').map((x) => parseInt(x));
      parts.push(Buffer.from(octets));
    } else if (isIPv6) {
      // IPv6
      parts.push(Buffer.from([0x00, 0x06])); // addr type
      parts.push(ipv6String2Buffer(addr));
    } else {
      // Domain name
      parts.push(Buffer.from([0x00, 0x03])); // addr type
      const domainBuf = Buffer.from(addr, 'utf-8');
      parts.push(Buffer.from([domainBuf.length]));
      parts.push(domainBuf);
    }

    // port (2 bytes, big-endian)
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port, 0);
    parts.push(portBuf);

    // length (2 bytes, big-endian)
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(payload.length, 0);
    parts.push(lenBuf);

    // payload
    parts.push(payload);

    return Buffer.concat(parts);
  }
}

/**
 * Convert IPv6 buffer to string
 */
function ipv6Array2String(buf: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(buf.readUInt16BE(i).toString(16));
  }
  return groups.join(':');
}

/**
 * Convert IPv6 string to buffer
 */
function ipv6String2Buffer(addr: string): Buffer {
  const buf = Buffer.alloc(16);
  const groups = addr.split(':').map((g) => g || '0');
  for (let i = 0; i < Math.min(groups.length, 8); i++) {
    buf.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2);
  }
  return buf;
}
