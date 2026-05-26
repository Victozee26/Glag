#!/usr/bin/env tsx

import { parseArgs } from './config.js';
import { PacketQueue } from './queue.js';
import { ProxyServer } from './server.js';

const config = parseArgs();

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║      UDP BURST PROXY — Free Fire         ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`  Port       : ${config.port}`);
console.log(`  Hold (ms)  : ${config.holdMs}ms`);
console.log(`  Mode       : Burst — hold all → release all`);
console.log('');
console.log('  SocksDroid → 127.0.0.1:' + config.port);
console.log('');

const queue = new PacketQueue(config.holdMs);

const server = new ProxyServer(config, queue);
server.listen().catch((err) => {
  console.error('[FATAL] Failed to start server:', err.message);
  process.exit(1);
});
