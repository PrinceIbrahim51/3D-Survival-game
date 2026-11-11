// Thin WebSocket wrapper with automatic reconnect to the lobby.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.connected = false;
    this.retry = 0;
    this.ping = null;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  emit(type, msg) {
    const fn = this.handlers.get(type);
    if (fn) fn(msg);
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('open');
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - msg.c);
        return;
      }
      this.emit(msg.t, msg);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.emit('close', was);
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(), 500 * this.retry);
    };
    ws.onerror = () => {};
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}
