import { ATYP_IPV4, ATYP_DOMAIN, ATYP_IPV6 } from './constants.js';

export interface ParsedUDPHeader {
  destAddr: string;
  destPort: number;
  payload: Buffer;
}

export function parseUDPHeader(buf: Buffer): ParsedUDPHeader | null {
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
      if (!len || buf.length < 5 + len + 2) return null;
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

export function buildUDPHeader(addr: string, port: number): Buffer {
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
