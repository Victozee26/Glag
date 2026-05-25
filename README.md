# UDP Burst Proxy — Free Fire Edition

Routes Free Fire's UDP traffic through a SOCKS5 proxy that holds all packets
for a configurable window, then dumps them all at once (burst release).

**Now with TCP passthrough:** TCP connections are tunneled in real-time without queueing.

```
Free Fire App
     ↓
SocksDroid (intercepts all traffic, no root)
     ↓
This proxy on 127.0.0.1:1080
     ├─→ TCP: real-time passthrough (no burst)
     └─→ UDP: BURST HAPPENS HERE
     ↓
Free Fire Game Servers
```

---

## Setup in Termux

### 1. Install Node.js
```bash
pkg update && pkg upgrade
pkg install nodejs
node --version   # should be v18+
```

### 2. Install dependencies
```bash
cd udp-burst-proxy
npm install
```

### 3. Run the proxy
```bash
npm start -- --port 1080 --hold 2000
```

---

## Features

### UDP Burst (Original)
Every `--hold` ms, all queued UDP packets are released simultaneously.

### TCP Passthrough (New)
TCP connections tunnel through in real-time with no queueing or delay.

---

## CLI Flags

| Flag     | Default | Description                                    |
|----------|---------|------------------------------------------------|
| `--port` | `1080`  | SOCKS5 TCP port SocksDroid connects to         |
| `--hold` | `2000`  | How long (ms) to hold UDP packets before burst |

### Examples

```bash
# Mild burst — 1 second hold
npm start -- --hold 1000

# Aggressive burst — 3 second hold (heavy packet dump)
npm start -- --hold 3000

# Different port
npm start -- --port 1234 --hold 2000
```

---

## Protocol Details

### UDP Burst Flow
```
1. UDP packets arrive → queued in memory
2. Every --hold ms → all queued packets burst simultaneously
3. Affects both inbound (server → client) and outbound (client → server)
4. Result: rubber-banding, delayed hit registration, position jumps
```

### TCP Passthrough Flow
```
1. TCP CONNECT request received → tunnel created immediately
2. Data flows bidirectionally with no queueing
3. Real-time communication (no delay)
4. Useful for control/signaling traffic
```

Both modes coexist: UDP uses burst logic, TCP bypasses it entirely.

---

## SocksDroid Configuration

1. Install **SocksDroid** from APK (not on Play Store)
2. Open SocksDroid → Add proxy:
   - **Host**: `127.0.0.1`
   - **Port**: `1080` (match your `--port`)
   - **Type**: SOCKS5
   - **Username/Password**: leave empty
3. Toggle SocksDroid ON
4. Open Free Fire → packets now burst through proxy

---

## Troubleshooting

**Port already in use**
```bash
# Use a different port
tsx src/index.ts --port 1081 --hold 2000
```

**SocksDroid not connecting**
- Make sure the proxy is running BEFORE toggling SocksDroid on
- Check Termux isn't being killed by battery optimization
- Disable battery optimization for Termux in Android settings

**No packets showing in terminal**
- SocksDroid must be ON and pointed at correct port
- Start Free Fire after proxy is running
- Some devices need SocksDroid to be granted VPN permission first

---

## Project Structure

- `src/index.ts` — Application entry point
- `src/server.ts` — TCP server and SOCKS5 handshake handler
- `src/connection.ts` — Client connection handler (routes to TCP/UDP)
- `src/queue.ts` — UDP packet queue management and burst timer logic
- `src/config.ts` — Command-line argument parsing
- `src/socks5/handler.ts` — SOCKS5 protocol negotiation (auth, commands)
- `src/socks5/constants.ts` — SOCKS5 protocol constants
- `src/relay/tcp-relay.ts` — TCP bidirectional tunneling (NEW)
- `src/relay/udp-relay.ts` — UDP relay socket management

---

## Architecture

### Dual-Mode Proxy

The proxy detects the SOCKS5 command and routes accordingly:

| Command | Mode | Behavior | Queueing |
|---------|------|----------|----------|
| `0x01` CONNECT | TCP | Bidirectional tunnel | None (real-time) |
| `0x03` UDP_ASSOC | UDP | Relay with burst | Yes (hold + release) |

### Connection Lifecycle

**TCP Mode:**
```
Client connects → SOCKS5 CONNECT → Tunnel created → Real-time data flow
```

**UDP Mode:**
```
Client connects → SOCKS5 UDP_ASSOC → Queue created → Hold packets → Burst release
```
