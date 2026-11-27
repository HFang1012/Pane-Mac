// Plugin's own-network route: a small SOCKS5 proxy, one per plugged-in app, that sends that app's
// connections out of the network you picked (Wi-Fi, Ethernet, an iPhone over USB…) and can hold it to a speed.
//
// How it picks the network: every outgoing connection is bound to that network's own address. macOS routes a
// connection bound to an address out of the interface that owns it ("scoped routing", on by default), so the
// app's traffic leaves through that network even when another one is your Mac's main one.
//
// The app reaches the proxy because Chromium-based apps (Chrome, Brave, Edge, Arc, and Electron apps like
// Discord, Slack or VS Code) accept --proxy-server when they open. Pane reopens the app with it (asking first).
// Names are looked up by Pane, on your usual DNS. Calls and video chats that use UDP (WebRTC) may still go
// over your usual network: SOCKS here carries TCP only. The plugin menu says so.
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

// The Mac's networks: { device, name, ip } for each one that has an IPv4 address right now.
// Names come from networksetup ("Wi-Fi", "iPhone USB", "Thunderbolt Bridge"), devices from the system.
let portNames = { at: 0, map: new Map() };
function hardwareNames() {
  if (Date.now() - portNames.at < 60000) return Promise.resolve(portNames.map);
  return new Promise((resolve) => {
    execFile('networksetup', ['-listallhardwareports'], { timeout: 4000 }, (err, out) => {
      const map = new Map();
      if (!err) {
        for (const block of String(out).split(/\n\s*\n/)) {
          const name = /Hardware Port: (.+)/.exec(block)?.[1]?.trim();
          const dev = /Device: (\S+)/.exec(block)?.[1];
          if (name && dev) map.set(dev, name);
        }
      }
      portNames = { at: Date.now(), map };
      resolve(map);
    });
  });
}
async function networks() {
  const names = await hardwareNames();
  const out = [];
  for (const [dev, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|utun|awdl|llw|gif|stf|anpi|ap)\d/.test(dev)) continue; // loopback, VPN tunnels, AirDrop and friends
    const v4 = (addrs || []).find((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
    if (!v4) continue;
    out.push({ device: dev, name: names.get(dev) || (dev.startsWith('bridge') ? 'Bridge' : dev), ip: v4.address });
  }
  // The usual suspects first: Wi-Fi, then wired, then anything else.
  const rank = (n) => (/Wi-?Fi/i.test(n.name) ? 0 : /Ethernet|LAN/i.test(n.name) ? 1 : /iPhone|iPad/i.test(n.name) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}
const ipOf = (device) => {
  const v4 = (os.networkInterfaces()[device] || []).find((a) => a.family === 'IPv4' && !a.internal);
  return v4?.address || null;
};

// A shared allowance of bytes a second, for one direction of one app. Each chunk spends from it; when it's
// spent, the side sending more is paused until enough has trickled back in.
class Bucket {
  constructor() { this.rate = Infinity; this.tokens = 0; this.at = Date.now(); }
  setRate(r) { this.rate = r > 0 ? r : Infinity; this.tokens = Math.min(this.tokens, this.rate); }
  // How many ms to wait after spending n bytes (0 when there's room).
  spend(n) {
    if (this.rate === Infinity) return 0;
    const now = Date.now();
    this.tokens = Math.min(this.rate * 0.5, this.tokens + ((now - this.at) / 1000) * this.rate); // at most half a second of burst
    this.at = now;
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

// One proxy: listens on 127.0.0.1:port and dials out through `device`.
//   opts.fallback  when that network is gone, use the Mac's usual one instead of refusing
class Route {
  constructor({ port, device, fallback = true }) {
    this.port = port;
    this.device = device;
    this.fallback = fallback;
    this.down = new Bucket();
    this.up = new Bucket();
    this.bytes = { down: 0, up: 0 }; // running totals, turned into speeds by the engine
    this.conns = new Set();
    this.lastUse = 0;
    this.error = null;
    this.server = net.createServer((c) => this.accept(c));
    this.server.on('error', (err) => { this.error = err.code === 'EADDRINUSE' ? 'That port is taken.' : err.message; });
    this.server.listen(port, '127.0.0.1');
  }
  setSpeed(bytesPerSec) { this.down.setRate(bytesPerSec); this.up.setRate(bytesPerSec); }
  // Is the chosen network up right now?
  get ip() { return ipOf(this.device); }
  close() {
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    try { this.server.close(); } catch {}
  }
  accept(client) {
    this.conns.add(client);
    client.on('close', () => this.conns.delete(client));
    client.on('error', () => {});
    client.setNoDelay(true);
    let stage = 0, buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        // Greeting: VER NMETHODS METHODS… We only offer "no authentication" (it listens on 127.0.0.1 only).
        if (buf.length < 2) return;
        if (buf[0] !== 5) { client.destroy(); return; }
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0)) { client.end(Buffer.from([5, 0xff])); return; }
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        // Request: VER CMD RSV ATYP ADDR PORT. Only CONNECT.
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host, end;
        if (atyp === 1) { end = 4 + 4; if (buf.length < end + 2) return; host = [...buf.subarray(4, 8)].join('.'); }
        else if (atyp === 3) { const len = buf[4]; end = 5 + len; if (buf.length < end + 2) return; host = buf.subarray(5, end).toString(); }
        else if (atyp === 4) {
          end = 4 + 16; if (buf.length < end + 2) return;
          const h = buf.subarray(4, 20); host = Array.from({ length: 8 }, (_, i) => h.readUInt16BE(i * 2).toString(16)).join(':');
        } else { reply(8); return; }
        const port = buf.readUInt16BE(end);
        const rest = buf.subarray(end + 2);
        if (buf[1] !== 1) { reply(7); return; }
        client.removeListener('data', onData);
        client.pause();
        this.dial(client, host, port, atyp, rest, reply);
        stage = 2;
      }
    };
    const reply = (code) => {
      // VER REP RSV ATYP=IPv4 0.0.0.0:0
      try { client.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {}
      if (code !== 0) client.end();
    };
    client.on('data', onData);
  }
  dial(client, host, port, atyp, early, reply) {
    const local = this.ip;
    if (!local && !this.fallback) { reply(3); return; } // "network unreachable": the network you picked is off
    if (atyp === 4 && local) { reply(3); return; } // an IPv6 address can't leave from an IPv4 one
    const opts = { host, port };
    if (local) { opts.localAddress = local; opts.family = 4; }
    const remote = net.connect(opts);
    this.conns.add(remote);
    remote.setNoDelay(true);
    const fail = () => { reply(4); remote.destroy(); };
    remote.once('error', fail);
    remote.setTimeout(20000, () => remote.destroy());
    remote.once('connect', () => {
      remote.removeListener('error', fail);
      remote.setTimeout(0);
      remote.on('error', () => client.destroy());
      client.on('error', () => remote.destroy());
      remote.on('close', () => { this.conns.delete(remote); client.destroy(); });
      client.on('close', () => remote.destroy());
      reply(0);
      this.lastUse = Date.now();
      if (early.length) this.pipe(early, remote, client, this.up, 'up');
      this.flow(client, remote, this.up, 'up');
      this.flow(remote, client, this.down, 'down');
      client.resume();
    });
  }
  // Copy one direction, spending from that direction's allowance, pausing the source when it's spent.
  flow(from, to, bucket, dir) {
    from.on('data', (chunk) => this.pipe(chunk, to, from, bucket, dir));
  }
  pipe(chunk, to, from, bucket, dir) {
    this.bytes[dir] += chunk.length;
    this.lastUse = Date.now();
    const ok = to.write(chunk);
    const wait = bucket.spend(chunk.length);
    if (wait > 0 || !ok) {
      from.pause();
      const go = () => { if (!from.destroyed) from.resume(); };
      if (!ok) to.once('drain', () => (wait > 0 ? setTimeout(go, wait) : go()));
      else setTimeout(go, Math.min(wait, 2000));
    }
  }
}

// A free port, chosen once per app and kept, so the app's --proxy-server stays right across Pane restarts.
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', () => resolve(0));
  });
}

module.exports = { Route, networks, freePort, ipOf, _test: { Bucket } };
