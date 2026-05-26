export interface Config {
  port: number;    // SOCKS5 TCP listen port
  holdMs: number;  // ms to hold packets before burst-releasing
}

export function parseArgs(): Config {
  const raw = process.argv.slice(2);
  let port = 1080;
  let holdMs = 10;

  for (let i = 0; i < raw.length; i++) {
    const val = raw[i + 1];
    if (raw[i] === '--port') {
      if (!val) continue;
      port = parseInt(val, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('[CONFIG] Invalid --port. Use 1–65535.');
        process.exit(1);
      }
    }
    if (raw[i] === '--hold') {
      if (!val) continue;
      holdMs = parseInt(val, 10);
      if (isNaN(holdMs) || holdMs < 0) {
        console.error('[CONFIG] Invalid --hold. Use positive ms e.g. 2000');
        process.exit(1);
      }
    }
  }

  return { port, holdMs };
}
