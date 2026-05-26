import * as net from 'node:net';
import * as dgram from 'node:dgram';

declare module 'socks5server' {
  interface CMD_REPLY {
    (code: number, addr?: string, port?: number): void;
  }

  interface SocksServer extends NodeJS.EventEmitter {
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
  }

  export function createServer(): SocksServer & {
    on(event: 'tcp', listener: (socket: net.Socket, address: string, port: number, CMD_REPLY: CMD_REPLY) => void): any;
    on(event: 'udp', listener: (socket: dgram.Socket, clientAddr: string, clientPort: number, CMD_REPLY: CMD_REPLY) => void): any;
    on(event: 'error', listener: (err: Error) => void): any;
    on(event: 'client_error', listener: (socket: any, err: Error) => void): any;
    on(event: 'socks_error', listener: (socket: any, err: Error) => void): any;
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
  };

  export class socksServer extends NodeJS.EventEmitter implements SocksServer {}
}
