import {
  SOCKS5_VERSION,
  AUTH_NONE,
  CMD_CONNECT,
  CMD_UDP_ASSOC,
  REPLY_OK,
  REPLY_CMD_UNSUP,
  ATYP_IPV4,
  ATYP_DOMAIN,
  ATYP_IPV6,
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
   * Returns { response, consumed }
   */
  public handleAuth(buf: Buffer): { resp: AuthResponse; consumed: number } | null {
    if (buf.length < 2) return null;
    if (buf[0] !== SOCKS5_VERSION) return null;

    const nMethods = buf[1]!;
    if (buf.length < 2 + nMethods) return null;

    this.state = 'cmd';
    return {
      resp: { version: SOCKS5_VERSION, method: AUTH_NONE },
      consumed: 2 + nMethods,
    };
  }

  /**
   * Process command request (TCP CONNECT or UDP_ASSOC)
   * Returns { response, consumed }
   */
  public handleCmd(buf: Buffer): { resp: CmdResponse; consumed: number } | null {
    if (buf.length < 6) return null;
    if (buf[0] !== SOCKS5_VERSION) return { resp: { success: false }, consumed: 1 };

    const cmd = buf[1]!;
    let consumed = 0;
    let cmdResp: CmdResponse | null = null;

    console.log(`[SOCKS5] Command received: 0x${cmd.toString(16).padStart(2, '0')}`);

    // TCP CONNECT
    if (cmd === CMD_CONNECT) {
      console.log(`[SOCKS5] → TCP CONNECT command`);
      const parsed = this.parseTCPConnect(buf);
      if (!parsed) return null;
      cmdResp = { success: true, type: 'tcp', ...parsed.data };
      consumed = parsed.consumed;
    }
    // UDP ASSOCIATE
    else if (cmd === CMD_UDP_ASSOC) {
      console.log(`[SOCKS5] → UDP ASSOCIATE command`);
      // UDP Assoc header is same as TCP Connect but addr/port are often 0
      const parsed = this.parseTCPConnect(buf);
      if (!parsed) return null;
      cmdResp = { success: true, type: 'udp' };
      consumed = parsed.consumed;
    } else {
      console.log(`[SOCKS5] ✗ Unknown command: 0x${cmd.toString(16).padStart(2, '0')}`);
      return { resp: { success: false }, consumed: 1 };
    }

    this.state = 'associated';
    return { resp: cmdResp, consumed };
  }

  /**
   * Parse SOCKS5 address/port structure
   */
  private parseTCPConnect(
    buf: Buffer,
  ): { data: { destAddr: string; destPort: number }; consumed: number } | null {
    const atyp = buf[3];

    if (atyp === ATYP_IPV4) {
      if (buf.length < 10) return null;
      const destAddr = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      const destPort = buf.readUInt16BE(8);
      return { data: { destAddr, destPort }, consumed: 10 };
    }

    if (atyp === ATYP_DOMAIN) {
      const len = buf[4];
      if (!len || buf.length < 5 + len + 2) return null;
      const destAddr = buf.toString('ascii', 5, 5 + len);
      const destPort = buf.readUInt16BE(5 + len);
      return { data: { destAddr, destPort }, consumed: 7 + len };
    }

    if (atyp === ATYP_IPV6) {
      if (buf.length < 22) return null;
      const parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
      }
      const destAddr = parts.join(':');
      const destPort = buf.readUInt16BE(20);
      return { data: { destAddr, destPort }, consumed: 22 };
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
