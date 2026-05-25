import {
  SOCKS5_VERSION,
  AUTH_NONE,
  CMD_UDP_ASSOC,
  REPLY_OK,
  REPLY_CMD_UNSUP,
  ATYP_IPV4,
} from './constants.js';

export type ProtocolState = 'auth' | 'cmd' | 'associated';

export interface AuthResponse {
  version: number;
  method: number;
}

export interface CmdResponse {
  success: boolean;
  relayPort?: number;
  localIP?: string;
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
   * Process command request (expecting UDP_ASSOC)
   */
  public handleCmd(buf: Buffer): CmdResponse | null {
    if (buf[0] !== SOCKS5_VERSION) {
      return { success: false };
    }

    const cmd = buf[1];
    if (cmd !== CMD_UDP_ASSOC) {
      return { success: false };
    }

    this.state = 'associated';
    return { success: true };
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

  public getState(): ProtocolState {
    return this.state;
  }
}
