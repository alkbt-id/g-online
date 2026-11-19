/**
 * Where the sign-in lives. Two builds of the same page:
 * - the service on the Mac (`server.mjs`): it keeps OGS's session; the Mac window can also sign in on OGS's
 *   own page (Apple, Google…);
 * - the page alone (GitHub Pages, `<html data-mode="local">`): it signs in with the OGS password straight
 *   from the browser and keeps only OGS's game token, which lasts 30 days.
 * Both give the page `{ user: { id, username, ranking }, jwt }` for the game socket.
 */
const ogs = 'https://online-go.com';

export function createBackend() {
  return document.documentElement.dataset.mode === 'local' ? localBackend() : serviceBackend();
}

/** OGS's English answers, the common ones in Russian. */
function ogsError(value, status) {
  const error = value?.error ?? value?.detail;
  const text = (Array.isArray(error) ? error.join(' ') : error) || `OGS ответил ${status}`;
  return /incorrect username or password/i.test(text) ? 'Неверное имя или пароль.' : text;
}
/** A fresh rank after a game: OGS's public player record. */
async function rankOf(id) {
  const response = await fetch(`${ogs}/api/v1/players/${id}`);
  if (!response.ok) throw new Error(`OGS ответил ${response.status}`);
  return (await response.json()).ranking;
}

function serviceBackend() {
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method,
      headers: { 'x-online': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `сервис ответил ${response.status}`);
    return value;
  }
  return {
    /** The Mac app opens OGS's own sign-in page; a plain browser has no such bridge. */
    siteSignIn: window.webkit?.messageHandlers?.ogsSignIn ?? null,
    load: () => api('/api/session'),
    signIn: (username, password) => api('/api/login', { method: 'POST', body: { username, password } }),
    signOut: () => api('/api/logout', { method: 'POST' }),
    saveChoice: (choice) => api('/api/choice', { method: 'PUT', body: choice }),
    rankOf,
  };
}

const sessionKey = 'online-session';
const choiceKey = 'online-choice';
const read = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: this visit only */ } };
/** When the game token runs out, seconds since 1970, from its middle part. */
function expiry(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part)).exp ?? 0;
  } catch {
    return 0;
  }
}
/** A day before the token runs out the page asks to sign in again: never in the middle of a game. */
const margin = 24 * 3600;

function localBackend() {
  return {
    siteSignIn: null,
    async load() {
      const saved = read(sessionKey);
      const fresh = saved?.user && saved.jwt && expiry(saved.jwt) - margin > Date.now() / 1000;
      return { ...(fresh ? saved : { user: null }), choice: read(choiceKey) };
    },
    async signIn(username, password) {
      // OGS lets other sites sign in by password; the answer carries the game token. No cookies cross over.
      const response = await fetch(`${ogs}/api/v0/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(ogsError(value, response.status));
      if (value?.redirect) throw new Error('Пароль не подошёл. У аккаунта есть вход через Apple, Google или другой сайт; если пароля на OGS ещё нет, задай его: online-go.com → Sign in → «Forgot password?».');
      const user = value?.user;
      if (!user || user.anonymous || !value.user_jwt) throw new Error('OGS не принял вход.');
      const session = { user: { id: user.id, username: user.username, ranking: user.ranking }, jwt: value.user_jwt };
      write(sessionKey, session);
      return session;
    },
    async signOut() {
      try { localStorage.removeItem(sessionKey); } catch { /* nothing kept */ }
    },
    async saveChoice(choice) { write(choiceKey, choice); },
    rankOf,
  };
}
