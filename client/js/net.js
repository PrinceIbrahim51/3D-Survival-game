// WebSocket connection to the game server.
//
// - Connects on demand (when the player presses Play), not at page load.
// - While in a lobby or match it survives drops: it reconnects and resumes the
//   same session, so the player keeps their seat.
// - Some hosts cut long-lived connections (serverless functions have a time
//   limit). The server announces that limit and this client moves to a fresh
//   socket shortly before it, without interrupting play.

const RESUME_WINDOW_MS = 15000;
const HANDOVER_MARGIN_S = 25;

export class Net {
  constructor() {
    this.ws = null;
    this.retired = null; // previous socket, kept briefly for in-flight messages
    this.handlers = new Map();
    this.connected = false;
    this.pending = null; // promise of a connection attempt in progress
    this.sid = null;
    this.ttl = 0;
    this.ping = null;
    this.keep = false; // true while in a lobby or match
    this.reconnecting = false;
    this.handoverTimer = 0;
    this.pingTimer = setInterval(() => {
      if (this.connected) this.send({ t: 'ping', c: performance.now() });
    }, 2000);
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  emit(type, msg) {
    const fn = this.handlers.get(type);
    if (fn) fn(msg);
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ws`;
  }

  // Resolves once a session is established.
  connect() {
    if (this.connected) return Promise.resolve();
    if (!this.pending) {
      this.pending = this.open(null).finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  // Opens a socket. resume: null (new session), 'hard' (after a drop) or
  // 'soft' (planned hand-over while the old socket still works).
  open(resume) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url());
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch { /* not open yet */ }
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('timeout'), 8000);
      const adopt = (msg) => {
        settled = true;
        clearTimeout(timer);
        const old = this.ws;
        this.ws = ws;
        this.sid = msg.sid;
        this.ttl = msg.ttl || 0;
        this.connected = true;
        if (old && old !== ws) {
          this.retired = old;
          setTimeout(() => {
            if (this.retired === old) this.retired = null;
            try {
              old.close();
            } catch { /* already closed */ }
          }, 1500);
        }
        this.scheduleHandover();
        resolve(msg);
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.t) {
          case 'hello':
            if (resume) ws.send(JSON.stringify({ t: 'resume', sid: this.sid, soft: resume === 'soft' }));
            else adopt(msg);
            return;
          case 'resumed':
            adopt(msg);
            return;
          case 'gone':
            fail('gone');
            return;
          case 'pong':
            if (ws === this.ws) this.ping = Math.round(performance.now() - msg.c);
            return;
          default:
            if (ws === this.ws || ws === this.retired) this.emit(msg.t, msg);
        }
      };
      ws.onerror = () => fail('error');
      ws.onclose = () => {
        fail('closed');
        if (ws === this.ws) this.lost();
      };
    });
  }

  scheduleHandover() {
    clearTimeout(this.handoverTimer);
    if (!this.ttl) return;
    const wait = Math.max(15, this.ttl - HANDOVER_MARGIN_S) * 1000;
    this.handoverTimer = setTimeout(() => this.handover(), wait);
  }

  async handover() {
    if (!this.connected) return;
    if (!this.keep) {
      this.close(); // idle in a menu: no need to hold a connection at all
      return;
    }
    try {
      await this.open('soft');
    } catch {
      // Could not move yet (for example the request reached another server
      // instance). Try again while the current socket is still alive.
      if (this.connected) this.handoverTimer = setTimeout(() => this.handover(), 3000);
    }
  }

  // The active socket closed unexpectedly.
  async lost() {
    this.ws = null;
    this.connected = false;
    this.ping = null;
    clearTimeout(this.handoverTimer);
    if (!this.keep || !this.sid || this.reconnecting) {
      if (!this.keep) this.sid = null;
      return;
    }
    this.reconnecting = true;
    this.emit('reconnecting');
    const deadline = performance.now() + RESUME_WINDOW_MS;
    let delay = 300;
    let gone = 0;
    while (performance.now() < deadline && this.keep) {
      try {
        await this.open('hard');
        this.reconnecting = false;
        this.emit('reconnected');
        return;
      } catch (err) {
        // "gone" usually means the session expired, but on a multi-instance
        // host it can also mean we reached a different instance: retry a few times.
        if (err.message === 'gone' && ++gone >= 4) break;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.6, 2500);
    }
    this.reconnecting = false;
    this.sid = null;
    if (this.keep) this.emit('lost');
  }

  setKeep(keep) {
    this.keep = keep;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // Deliberately end the session (back in the menus for a while).
  close() {
    clearTimeout(this.handoverTimer);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.sid = null;
    this.ping = null;
    if (ws) {
      try {
        ws.close();
      } catch { /* already closed */ }
    }
  }
}
