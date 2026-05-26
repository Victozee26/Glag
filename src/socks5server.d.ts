import * as net from 'node:net';
import * as dgram from 'node:dgram';

declare module 'socks5server' {
  interface SocksServer extends NodeJS.EventEmitter {
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;

    on(
      event: 'tcp',
      listener: (socket: net.Socket, address: string, port: number, CMD_REPLY: (code: number, addr?: string, port?: number) => void) => void,
    ): this;

    on(
      event: 'udp',
      listener: (socket: dgram.Socket, clientAddr: string, clientPort: number, CMD_REPLY: (code: number, addr?: string, port?: number) => void) => void,
    ): this;

    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'client_error', listener: (socket: any, err: Error) => void): this;
    on(event: 'socks_error', listener: (socket: any, err: Error) => void): this;
  }

  export function createServer(): SocksServer;

  export class socksServer extends NodeJS.EventEmitter implements SocksServer {
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
  }
}
