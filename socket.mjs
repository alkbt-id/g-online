/**
 * The OGS realtime socket. Messages are JSON arrays: `[command, data, id]` from us — the id asks for an
 * answer, which comes back as `[id, data, error]`; the server's own events are `[event, data]`.
 * Pings every ten seconds keep the line and give the server's time; a dropped line comes back by itself,
 * signs in again and tells `onConnect`, so the game can ask for its state anew.
 */
const url = 'wss://online-go.com/';
const pingEvery = 10_000;
const retryDelays = [500, 1000, 2000, 4000, 8000];
/** No answer to pings for this long: the line is dead, though it may say it is open (a phone back from sleep). */
const silenceLimit = 25_000;

export function createSocket({ jwt, onConnect, onDrop }) {
  const handlers = new Map();
  const waiting = new Map();
  let socket = null;
  let nextId = 1;
  let tries = 0;
  let closed = false;
  let lastHeard = 0;
  /** Server time minus our time, ms: the clocks run on server time. */
  let drift = 0;
  let latency = 0;

  function send(command, data) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify([command, data]));
  }
  function request(command, data) {
    return new Promise((resolve, reject) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        reject(new Error('нет связи с OGS'));
        return;
      }
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify([command, data, id]));
    });
  }
  function ping() {
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastHeard > silenceLimit) {
      restart();
      return;
    }
    send('net/ping', { client: Date.now(), drift, latency });
  }
  /** A new line at once; the old one is dropped without waiting for it to close. */
  function restart() {
    const old = socket;
    open();
    onDrop?.();
    old?.close();
  }
  function emit(event, data) {
    for (const handler of handlers.get(event) ?? []) handler(data);
  }

  function open() {
    const current = new WebSocket(url);
    socket = current;
    let pinger = null;
    current.addEventListener('open', async () => {
      tries = 0;
      lastHeard = Date.now();
      pinger = setInterval(() => { if (socket === current) ping(); }, pingEvery);
      ping();
      try {
        await request('authenticate', { jwt, client: 'g-spot-online', client_version: '0.1.0', language: 'ru' });
      } catch { /* the drop handler reconnects */ }
      onConnect?.();
    });
    current.addEventListener('message', (event) => {
      if (socket !== current) return;
      lastHeard = Date.now();
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const [head, data, error] = message;
      if (typeof head === 'number') {
        const entry = waiting.get(head);
        waiting.delete(head);
        if (!entry) return;
        if (error) entry.reject(new Error(error.message ?? error.error ?? String(error)));
        else entry.resolve(data);
        return;
      }
      if (head === 'net/pong') {
        const now = Date.now();
        latency = now - data.client;
        drift = data.server - (data.client + now) / 2;
        return;
      }
      emit(head, data);
    });
    current.addEventListener('close', () => {
      clearInterval(pinger);
      for (const entry of waiting.values()) entry.reject(new Error('связь с OGS прервалась'));
      waiting.clear();
      if (socket !== current || closed) return;
      onDrop?.();
      setTimeout(open, retryDelays[Math.min(tries++, retryDelays.length - 1)]);
    });
  }
  open();

  return {
    send,
    request,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    /** Our clock moved to the server's: the time the clocks count from. */
    serverNow: () => Date.now() + drift,
    /** The page is seen again: a line silent too long is replaced, a closed one is opened now. */
    wake() {
      if (closed) return;
      if (socket?.readyState === WebSocket.OPEN) ping();
      else if (socket?.readyState !== WebSocket.CONNECTING) restart();
    },
    connected: () => socket?.readyState === WebSocket.OPEN,
    close() {
      closed = true;
      socket?.close();
    },
  };
}
