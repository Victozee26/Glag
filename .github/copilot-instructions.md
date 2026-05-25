# Glag: UDP Burst Proxy Instructions

## Project Overview

**Glag** is a SOCKS5 UDP burst proxy for Free Fire. Core functionality:
- Accepts SOCKS5 TCP connections
- Queues UDP packets for configurable duration
- Bursts all packets simultaneously
- Runs on Termux with TypeScript/Node.js

## Code Style

- Keep it simple and readable
- Single responsibility per function
- Avoid premature abstraction
- Use TypeScript for type safety

## Before Editing

1. Understand how packets flow through the proxy
2. Check for side effects (timing, queueing, socket state)
3. Ask if unclear about expected behavior

## Testing

- Add tests for critical paths (packet queuing, burst timing)
- Test edge cases (socket errors, timeout edge cases)
- Keep tests fast and isolated