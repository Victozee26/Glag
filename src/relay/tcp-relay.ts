import * as net from 'node:net';

/**
 * TCP relay socket manager — handles bidirectional TCP tunneling
 */
export class TCPRelay {
  private clientSocket: net.Socket;
  private serverSocket: net.Socket | null = null;
  private connected = false;

  constructor(clientSocket: net.Socket) {
    this.clientSocket = clientSocket;
  }

  /**
   * Connect to destination server
   */
  public connect(destAddr: string, destPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.serverSocket = net.createConnection(
        { host: destAddr, port: destPort },
        () => {
          this.connected = true;

          const socket = this.serverSocket;
          if (!socket) return;

          // Forward client → server
          this.clientSocket.on('data', (data) => {
            if (socket && !socket.destroyed) {
              socket.write(data);
            }
          });

          // Forward server → client
          socket.on('data', (data) => {
            if (!this.clientSocket.destroyed) {
              this.clientSocket.write(data);
            }
          });

          // Handle server close
          socket.on('close', () => {
            if (!this.clientSocket.destroyed) {
              this.clientSocket.destroy();
            }
          });

          // Handle server error
          socket.on('error', (err) => {
            console.error(`[TCP-RELAY] Server error: ${err.message}`);
            if (!this.clientSocket.destroyed) {
              this.clientSocket.destroy();
            }
          });

          // Handle client close during tunnel
          this.clientSocket.on('close', () => {
            if (socket && !socket.destroyed) {
              socket.destroy();
            }
          });

          resolve();
        },
      );

      this.serverSocket.on('error', (err) => {
        reject(err);
      });

      // Timeout
      const timeout = setTimeout(() => {
        if (this.serverSocket && !this.connected) {
          this.serverSocket.destroy();
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      this.serverSocket.once('connect', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Close relay and cleanup
   */
  public close(): void {
    if (this.serverSocket && !this.serverSocket.destroyed) {
      this.serverSocket.destroy();
    }
    this.serverSocket = null;
  }

  /**
   * Check if tunnel is active
   */
  public isConnected(): boolean {
    return (
      this.connected &&
      this.serverSocket !== null &&
      !this.serverSocket.destroyed
    );
  }
}
