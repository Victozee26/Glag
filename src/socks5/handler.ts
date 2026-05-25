import {
  SOCKS5_VERSION,
  AUTH_NONE,
  CMD_CONNECT,
  CMD_UDP_ASSOC,
  REPLY_OK,
  REPLY_CMD_UNSUP,
  ATYP_IPV4,
  ATYP_DOMAIN,
} from './constants.js';

export type ProtocolState = 'auth' | 'cmd' | 'associated';

export type CommandType = 'tcp' | 'udp';

export interface AuthResponse {
  version: number;
  method: number;
}

export interface CmdResponse {
  success: boolean;
  type?: CommandType;
  relayPort?: number;
  localIP?: string;
  destAddr?: string;
  destPort?: number;
}

/**
 * SOCKS5 protocol handler — manages auth and command handshakes
 */
export class SOCKS5Handler {
  private state: ProtocolState = 'auth';

  /**
   * Process authentication request
   */
  public handleAuth(buf: Buffer): AuthResponse | null {
    if (buf[0] !== SOCKS5_VERSION) {
      return null;
    }
    this.state = 'cmd';
    return { version: SOCKS5_VERSION, method: AUTH_NONE };
  }

  /**
   * Process command request (TCP CONNECT or UDP_ASSOC)
   */
  public handleCmd(buf: Buffer): CmdResponse | null {
    if (buf[0] !== SOCKS5_VERSION) {
      return { success: false };
    }

    const cmd = buf[1];

    // TCP CONNECT
    if (cmd === CMD_CONNECT) {
      const parsed = this.parseTCPConnect(buf);
      if (!parsed) return { success: false };
      this.state = 'associated';
      return { success: true, type: 'tcp', ...parsed };
    }

    // UDP ASSOCIATE
    if (cmd === CMD_UDP_ASSOC) {
      this.state = 'associated';
      return { success: true, type: 'udp' };
    }

    return { success: false };
  }

  /**
   * Parse SOCKS5 TCP CONNECT request
   */
  private parseTCPConnect(
    buf: Buffer,
  ): { destAddr: string; destPort: number } | null {
    if (buf.length < 6) return null;

    const atyp = buf[3];

    if (atyp === ATYP_IPV4) {
      // IPv4: format is [ver:1][cmd:1][rsv:1][atyp:1][addr:4][port:2]
      if (buf.length < 10) return null;
      const destAddr = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      const destPort = buf.readUInt16BE(8);
      return { destAddr, destPort };
    }

    if (atyp === ATYP_DOMAIN) {
      // Domain: [ver:1][cmd:1][rsv:1][atyp:1][len:1][domain:len][port:2]
      const len = buf[4];
      if (!len || buf.length < 5 + len + 2) return null;
      const destAddr = buf.toString('ascii', 5, 5 + len);
      const destPort = buf.readUInt16BE(5 + len);
      return { destAddr, destPort };
    }

    return null;
  }

  /**
   * Build auth response buffer
   */
  public buildAuthResponse(): Buffer {
    return Buffer.from([SOCKS5_VERSION, AUTH_NONE]);
  }

  /**
   * Build command rejection buffer
   */
  public buildCmdRejection(): Buffer {
    return Buffer.from([
      SOCKS5_VERSION,
      REPLY_CMD_UNSUP,
      0x00,
      ATYP_IPV4,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
  }

  /**
   * Build successful UDP association response
   */
  public buildCmdSuccess(relayPort: number, localIP: string): Buffer {
    const ipBytes = localIP.split('.').map(Number);
    const reply = Buffer.alloc(10);

    reply[0] = SOCKS5_VERSION;
    reply[1] = REPLY_OK;
    reply[2] = 0x00;
    reply[3] = ATYP_IPV4;
    ipBytes.forEach((b, i) => {
      reply[4 + i] = b;
    });
    reply.writeUInt16BE(relayPort, 8);

    return reply;
  }

  /**
   * Build successful TCP connection response
   */
  public buildTCPSuccess(localIP: string, localPort: number): Buffer {
    const ipBytes = localIP.split('.').map(Number);
    const reply = Buffer.alloc(10);

    reply[0] = SOCKS5_VERSION;
    reply[1] = REPLY_OK;
    reply[2] = 0x00;
    reply[3] = ATYP_IPV4;
    ipBytes.forEach((b, i) => {
      reply[4 + i] = b;
    });
    reply.writeUInt16BE(localPort, 8);

    return reply;
  }

  public getState(): ProtocolState {
    return this.state;
  }
}
