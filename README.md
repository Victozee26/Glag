# UDP Burst Proxy — Free Fire Edition

Routes Free Fire's UDP traffic through a SOCKS5 proxy that holds all packets
for a configurable window, then dumps them all at once (burst release).

**Features:** 
- TCP passthrough (real-time, no queueing)
- UDP burst delay (configurable hold window)
- **NEW:** badvpn-udpgw protocol support for UDP packet forwarding

```
Free Fire App
     ↓
SocksDroid (SOCKS5 on :1080)
     ├─→ TCP: real-time passthrough
     ├─→ UDP: burst-delayed relay
     └─→ badvpn (:7300): packet extraction + forwarding
     ↓
This proxy on 127.0.0.1:1080
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

- **TCP Passthrough**: Real-time tunneling with no queueing
- **UDP Burst**: Hold all packets for `--hold` ms, release simultaneously
- **badvpn-udpgw Protocol**: Intercepts SocksDroid UDP forwarding on `:7300`, extracts destination IP:port from each packet, routes to correct game servers with burst delay

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

### Packet Flow

**TCP**: SOCKS5 CONNECT → Bidirectional tunnel → Real-time forwarding

**UDP**: SOCKS5 UDP_ASSOC → Queue creation → Hold packets → Burst release (all at once)

**badvpn**: SocksDroid sends `CONNECT → 127.0.0.1:7300` → Proxy intercepts → Parses packet frame to extract destination IP:port → Queues with burst delay → Routes to game server

### Packet Frame Format (badvpn)
```
[4 bytes: header] [1 byte: type] [4 bytes: IPv4] [2 bytes: port (BE)] [payload]
Example: eb04028e 00 8efb9d77 01bb c700...
         (header)  (type) (142.251.157.119) (443)
```

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

- `src/server.ts` — SOCKS5 server, TCP relay, badvpn handler
- `src/connection.ts` — Client connection state machine
- `src/queue.ts` — UDP burst queue and timer
- `src/relay/tcp-relay.ts` — TCP tunnel manager
- `src/relay/udp-relay.ts` — UDP relay socket handler
- `src/badvpn-protocol.ts` — badvpn protocol parser
- `src/config.ts` — CLI args
- `src/socks5/` — SOCKS5 protocol (auth, commands)

---

## Architecture

| Mode | Command | Handler | Behavior |
|------|---------|---------|----------|
| TCP | CONNECT (0x01) | `TCPRelay` | Real-time bidirectional tunnel |
| UDP | UDP_ASSOC (0x03) | `PacketQueue` | Hold → Burst release |
| badvpn | CONNECT → 127.0.0.1:7300 | `handleBadVPNConnection()` | Parse dest IP:port → Queue → Burst |

All three modes work simultaneously. SocksDroid detects which one to use based on the app's traffic patterns.
