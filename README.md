# UDP Burst Proxy — Free Fire Edition

Routes Free Fire's UDP traffic through a SOCKS5 proxy that holds all packets
for a configurable window, then dumps them all at once (burst release).

```
Free Fire App
     ↓
SocksDroid (intercepts all traffic, no root)
     ↓
This proxy on 127.0.0.1:1080  ← BURST HAPPENS HERE
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

## CLI Flags

| Flag     | Default | Description                                    |
|----------|---------|------------------------------------------------|
| `--port` | `1080`  | SOCKS5 TCP port SocksDroid connects to         |
| `--hold` | `2000`  | How long (ms) to hold packets before burst     |

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

## What "Burst" Means

Every `--hold` ms, ALL queued packets are dumped at once:

```
t=0ms   → Packet 1 arrives → queued
t=300ms → Packet 2 arrives → queued
t=900ms → Packet 3 arrives → queued
t=2000ms → BURST: Packets 1,2,3 all released together
t=2001ms → new window starts
```

This affects BOTH directions:
- **Outgoing** (your actions → server): your inputs pile up, then slam the server
- **Incoming** (server → you): game state updates pile up, then slam your screen

Result: rubber-banding, delayed hit registration, sudden position jumps.

---

## Troubleshooting

**Port already in use**
```bash
# Use a different port
npx ts-node src/proxy.ts --port 1081 --hold 2000
```

**SocksDroid not connecting**
- Make sure the proxy is running BEFORE toggling SocksDroid on
- Check Termux isn't being killed by battery optimization
- Disable battery optimization for Termux in Android settings

**No packets showing in terminal**
- SocksDroid must be ON and pointed at correct port
- Start Free Fire after proxy is running
- Some devices need SocksDroid to be granted VPN permission first
