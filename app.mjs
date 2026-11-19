/**
 * One window onto OGS: sign in, pick a board and a clock, the server finds an opponent, play to the end,
 * see the result and the territory. Nothing else: no chat, no analysis, no lists of games.
 */
import { isLegal, replay, startPosition } from './rules.mjs';
import {
  clockText, decodePoints, encodeMove, encodePoints, groupStones, matchRequest, pointOf, rankText, scoredOwners,
  sizes, speedName, speeds, systemName, systems, territory, timeControlText, timeControls, timeLeft,
} from './ogs.mjs';
import { createSocket } from './socket.mjs';
import { createBackend } from './backend.mjs';
import { listenForSound, playStone, setSoundOn, soundOn } from './sound.mjs';

const root = document.getElementById('app');
/** A live game; correspondence games, with a day per move, stay on the site. */
const liveLimit = 3600;

/** `{ user: { id, username, ranking }, jwt }` once signed in. */
let session = null;
let choice = { size: 9, speed: 'rapid', system: 'byoyomi' };
/** 'loading', 'login', 'lobby' or 'game'. */
let screen = 'loading';
let socket = null;
let online = false;
/** The quick match request while the server looks for an opponent: `{ uuid, since }`. */
let search = null;
/**
 * The game on the board: `data` is OGS's `gamedata`, `moves` its moves as points (null is a pass),
 * `removed` the stones marked dead after both passed, `pending` our move the server has not confirmed yet.
 */
let game = null;
let note = '';
let busy = false;
let resignAsked = false;
let ghost = null;
/** A finger is down on the board: its ghost stone gets guide lines. */
let aiming = false;
/** What is typed in the sign-in form: the form is drawn anew while the service answers. */
const draft = { username: '', password: '' };

/** The sign-in: the Mac service, or the page alone on GitHub Pages. */
const backend = createBackend();
/** The build of the page-only version, to tell whether the phone runs the latest. */
const version = document.querySelector('meta[name="online-version"]')?.content ?? '';

/* The socket. */
function connect() {
  socket?.close();
  online = false;
  socket = createSocket({
    jwt: session.jwt,
    onConnect() {
      online = true;
      // After a drop the server forgets what we watched: ask for the game again.
      if (game) socket.send('game/connect', { game_id: game.id, chat: false });
      // A request may not survive the drop: ask again under the same id, the server knows it if it kept it.
      if (search) socket.send('automatch/find_match', matchRequest(choice, search.uuid));
      render();
    },
    onDrop() {
      online = false;
      render();
    },
  });
  socket.on('automatch/start', ({ uuid, game_id: id }) => {
    if (search && uuid !== search.uuid) return;
    search = null;
    joinGame(id);
  });
  socket.on('automatch/cancel', ({ uuid }) => {
    if (!search || (uuid !== null && uuid !== search.uuid)) return;
    search = null;
    render();
  });
  // A request still open on the server after the window was closed and opened again.
  socket.on('automatch/entry', (entry) => {
    if (game || search) return;
    search = { uuid: entry.uuid, since: Date.now() };
    render();
  });
  // A live game already going, after the window was closed and opened again.
  socket.on('active_game', (entry) => {
    if (game || entry.phase === 'finished' || !(entry.time_per_move > 0 && entry.time_per_move < liveLimit)) return;
    if (entry.black?.id !== session.user.id && entry.white?.id !== session.user.id) return;
    search = null;
    joinGame(entry.id);
  });
}

/* The game. */
const gameEvents = ['gamedata', 'move', 'clock', 'phase', 'removed_stones', 'removed_stones_accepted', 'error'];
function joinGame(id) {
  if (game?.id === id) return;
  leaveGame();
  game = { id, data: null, moves: [], removed: new Set(), removedText: '', clock: null, pending: false, accepted: false, unsubscribe: [] };
  game.unsubscribe = gameEvents.map((event) => socket.on(`game/${id}/${event}`, (data) => onGameEvent(event, data)));
  socket.send('game/connect', { game_id: id, chat: false });
  screen = 'game';
  note = '';
  resignAsked = false;
  ghost = null;
  render();
}
function leaveGame() {
  if (!game) return;
  for (const off of game.unsubscribe) off();
  socket?.send('game/disconnect', { game_id: game.id });
  game = null;
}
/** Asks for the whole game again, when what we hold no longer fits what the server says. */
function resync() {
  if (!game) return;
  socket.send('game/disconnect', { game_id: game.id });
  socket.send('game/connect', { game_id: game.id, chat: false });
}
const boardSize = () => game?.data?.width ?? choice.size;
function setRemoved(text) {
  game.removedText = typeof text === 'string' ? text : '';
  game.removed = new Set(Array.isArray(text) ? text.map((move) => pointOf([move.x, move.y], boardSize())).filter((point) => point !== null) : decodePoints(game.removedText, boardSize()));
  game.accepted = false;
}
function onGameEvent(event, data) {
  const size = boardSize();
  if (event === 'gamedata') {
    game.data = data;
    game.moves = (data.moves ?? []).map((move) => pointOf(move, data.width));
    game.clock = data.clock ?? null;
    game.pending = false;
    setRemoved(data.removed ?? '');
    const mine = data.players?.[myColor() === 1 ? 'black' : 'white'];
    game.accepted = Boolean(game.removedText && mine?.accepted_stones === game.removedText);
  } else if (!game.data) {
    return;
  } else if (event === 'move') {
    const index = data.move_number - 1;
    const point = pointOf(data.move, size);
    if (index < game.moves.length) {
      // Our own move coming back.
      game.moves[index] = point;
      game.moves.length = index + 1;
      game.pending = false;
    } else if (index === game.moves.length) {
      game.moves.push(point);
      if (point !== null) playStone();
    } else {
      resync();
      return;
    }
  } else if (event === 'clock') {
    game.clock = data;
  } else if (event === 'phase') {
    game.data.phase = data;
    if (data === 'play') setRemoved('');
    // The result comes with fresh game data; if it does not, ask for it.
    if (data === 'finished') setTimeout(() => { if (game && !game.data.outcome) resync(); }, 1500);
  } else if (event === 'removed_stones') {
    if ('all_removed' in data) setRemoved(data.all_removed);
  } else if (event === 'removed_stones_accepted') {
    if (data.player_id === session.user.id) game.accepted = true;
    if (data.phase === 'finished') Object.assign(game.data, { phase: 'finished', score: data.score, winner: data.winner, outcome: data.outcome });
  } else if (event === 'error') {
    note = `OGS: ${data}`;
    resync();
  }
  if (game.data.phase !== 'play') ghost = null;
  render();
}
function myColor() {
  const players = game?.data?.players;
  if (!players) return 0;
  if (players.black?.id === session.user.id) return 1;
  if (players.white?.id === session.user.id) return 2;
  return 0;
}
function gamePosition() {
  const { data } = game;
  const size = data.width;
  const start = {
    black: decodePoints(data.initial_state?.black, size),
    white: decodePoints(data.initial_state?.white, size),
    toPlay: data.initial_player === 'white' ? 2 : 1,
  };
  try {
    return replay(size, game.moves, start, data.free_handicap_placement ? data.handicap ?? 0 : 0);
  } catch {
    return startPosition(size, start);
  }
}
/** Whose move: the server's clock says it; before the first clock, the board does. */
function colorToMove(position) {
  const { clock, data } = game;
  if (clock?.current_player) return clock.current_player === data.players.black.id ? 1 : 2;
  return position.toPlay;
}
const yourTurn = (position) => game?.data?.phase === 'play' && online && !game.pending && myColor() !== 0 && colorToMove(position) === myColor();

function userMove(point) {
  const position = gamePosition();
  if (!yourTurn(position)) return;
  if (point !== null && !isLegal(position, point)) return;
  socket.send('game/move', { game_id: game.id, move: encodeMove(point, game.data.width) });
  game.moves.push(point);
  game.pending = true;
  if (point !== null) playStone();
  note = '';
  ghost = null;
  resignAsked = false;
  render();
}
function resign() {
  if (!resignAsked) {
    resignAsked = true;
    render();
    return;
  }
  resignAsked = false;
  socket.send('game/resign', { game_id: game.id });
}
/** A click on a stone after both passed marks its whole group dead, or alive again. */
function toggleDead(point) {
  const position = gamePosition();
  if (!position.board[point]) return;
  const group = groupStones(position.board, point, position.size);
  const dead = group.every((stone) => game.removed.has(stone));
  socket.send('game/removed_stones/set', { game_id: game.id, removed: !dead, stones: encodePoints(group, position.size) });
}
function acceptScore() {
  socket.send('game/removed_stones/accept', { game_id: game.id, stones: game.removedText, strict_seki_mode: false });
}
function backToPlay() {
  socket.send('game/removed_stones/reject', { game_id: game.id });
}

/* Quick match. */
function findMatch() {
  if (!online) return;
  search = { uuid: crypto.randomUUID(), since: Date.now() };
  socket.send('automatch/find_match', matchRequest(choice, search.uuid));
  render();
}
function cancelMatch() {
  if (search) socket.send('automatch/cancel', { uuid: search.uuid });
  search = null;
  render();
}
async function newGame() {
  leaveGame();
  screen = 'lobby';
  note = '';
  render();
  // The rating moved after the game: take the fresh rank.
  try {
    const ranking = await backend.rankOf(session.user.id);
    if (typeof ranking === 'number') session.user = { ...session.user, ranking };
    render();
  } catch { /* the old rank stays */ }
}
function choose(key, value) {
  choice = { ...choice, [key]: value };
  backend.saveChoice(choice).catch(() => {});
  render();
}

/* Sign in and out. */
async function signIn() {
  const { username, password } = draft;
  busy = true;
  note = '';
  render();
  try {
    session = await backend.signIn(username.trim(), password);
    draft.password = '';
    screen = 'lobby';
    connect();
  } catch (error) {
    note = error.message;
  }
  busy = false;
  render();
}
async function signOut() {
  if (search) cancelMatch();
  leaveGame();
  socket?.close();
  socket = null;
  online = false;
  session = null;
  screen = 'login';
  note = '';
  render();
  await backend.signOut().catch(() => {});
}

/* The board. */
const svgSpace = 'http://www.w3.org/2000/svg';
const cell = 64;
const edge = cell * 0.6;
const stoneRadius = cell * 0.47;
const center = (index) => edge + index * cell;
const inks = { 1: '#0e0f11', 2: '#f7f6f1' };
function starPoints(size) {
  const near = size < 13 ? 2 : 3;
  const lines = size === 19 ? [near, 9, size - 1 - near] : [near, size - 1 - near];
  const points = lines.flatMap((y) => lines.map((x) => y * size + x));
  if (size !== 19) points.push(((size - 1) / 2) * (size + 1));
  return points;
}

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(svgSpace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
function stoneNode(point, color, size, opacity = 1) {
  const x = center(point % size);
  const y = center(Math.floor(point / size));
  const group = svgNode('g', { opacity });
  group.append(svgNode('circle', { cx: x + 1, cy: y + 2.5, r: stoneRadius, fill: '#28190a', opacity: 0.35 }));
  group.append(svgNode('circle', { cx: x, cy: y, r: stoneRadius, fill: `url(#stone-${color})` }));
  return group;
}
/** `owners`: whose each point is at the end; `dead`: stones marked dead; `ghost`: the stone under the mouse. */
function drawBoard(svg, shown, { owners = null, dead = null, ghostColor = 0 } = {}) {
  const { size } = shown;
  const side = edge * 2 + cell * (size - 1);
  svg.replaceChildren();
  const defs = svgNode('defs');
  for (const [color, stops] of [[1, [['0%', '#5b5e63'], ['55%', '#1c1d20'], ['100%', '#0e0f11']]], [2, [['0%', '#ffffff'], ['60%', '#efede6'], ['100%', '#c8c5ba']]]]) {
    const gradient = svgNode('radialGradient', { id: `stone-${color}`, cx: '36%', cy: '30%', r: '75%' });
    for (const [offset, ink] of stops) gradient.append(svgNode('stop', { offset, 'stop-color': ink }));
    defs.append(gradient);
  }
  svg.append(defs, svgNode('rect', { width: side, height: side, rx: 10, fill: '#ddb56c' }));
  const first = center(0);
  const last = center(size - 1);
  let lines = '';
  for (let i = 0; i < size; i++) lines += `M${first} ${center(i)}H${last}M${center(i)} ${first}V${last}`;
  svg.append(svgNode('path', { d: lines, stroke: '#6e5228', 'stroke-width': 2, fill: 'none' }));
  for (const point of starPoints(size)) svg.append(svgNode('circle', { cx: center(point % size), cy: center(Math.floor(point / size)), r: 5.5, fill: '#5a4320' }));
  shown.board.forEach((color, point) => {
    if (color) svg.append(stoneNode(point, color, size, dead?.has(point) || (owners?.[point] && owners[point] !== color) ? 0.45 : 1));
  });
  // A finger carrying a stone also lights its row and column: on a phone the points are small.
  if (ghost !== null && ghostColor && aiming) {
    const x = center(ghost % size);
    const y = center(Math.floor(ghost / size));
    svg.append(svgNode('path', { d: `M${first} ${y}H${last}M${x} ${first}V${last}`, stroke: '#fff4d6', 'stroke-width': 5, 'stroke-opacity': 0.75, fill: 'none' }));
  }
  if (ghost !== null && ghostColor) svg.append(stoneNode(ghost, ghostColor, size, 0.5));
  if (owners) {
    owners.forEach((owner, point) => {
      // A live stone of the owner's own color needs no mark.
      if (!owner || shown.board[point] === owner) return;
      const mark = cell * (shown.board[point] ? 0.3 : 0.36);
      svg.append(svgNode('rect', { x: center(point % size) - mark / 2, y: center(Math.floor(point / size)) - mark / 2, width: mark, height: mark, fill: inks[owner], stroke: inks[3 - owner], 'stroke-opacity': 0.5, 'stroke-width': 1.2 }));
    });
  }
  if (shown.last !== null && !owners && shown.board[shown.last]) {
    const point = shown.last;
    svg.append(svgNode('circle', { cx: center(point % size), cy: center(Math.floor(point / size)), r: stoneRadius * 0.55, fill: 'none', stroke: inks[3 - shown.board[point]], 'stroke-width': 3 }));
  }
}
/**
 * A finger aims this far above itself, so it does not cover the stone it carries: at least 40 screen pixels,
 * about a fingertip, however small the points are, and never less than three quarters of a point.
 */
const fingerLift = { pixels: 40, cells: 0.75 };
function pointAt(svg, event, size, lifted = false) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const lift = lifted && event.pointerType === 'touch' ? Math.max(cell * fingerLift.cells, fingerLift.pixels / Math.abs(matrix.a)) : 0;
  const x = Math.round((local.x - edge) / cell);
  const y = Math.round((local.y - lift - edge) / cell);
  return x >= 0 && y >= 0 && x < size && y < size ? y * size + x : null;
}
function boardView() {
  const shown = game?.data ? gamePosition() : startPosition(boardSize());
  const { size } = shown;
  const side = edge * 2 + cell * (size - 1);
  const svg = svgNode('svg', { id: 'board', viewBox: `0 0 ${side} ${side}`, role: 'img', 'aria-label': `Доска ${size} × ${size}` });
  const phase = game?.data?.phase;
  let options = {};
  if (phase === 'finished') options = { owners: game.data.score ? scoredOwners(game.data.score, size) : null };
  else if (phase === 'stone removal') options = { owners: territory(shown.board, game.removed, size), dead: game.removed };
  const playing = game?.data && yourTurn(shown);
  const marking = phase === 'stone removal' && myColor() !== 0 && online;
  if (playing) options.ghostColor = myColor();
  drawBoard(svg, shown, options);
  svg.classList.toggle('active', Boolean(playing || marking));
  if (playing) {
    // A mouse shows the ghost stone on hover. A finger shows it while pressed, above itself, and drags it
    // about; the stone lands where the ghost is when the finger lifts, and a ghost off the board puts nothing.
    let pressed = false;
    const showGhost = (event) => {
      const point = pointAt(svg, event, size, true);
      const next = point !== null && isLegal(shown, point) ? point : null;
      if (next === ghost) return;
      ghost = next;
      drawBoard(svg, shown, options);
    };
    svg.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      pressed = true;
      aiming = event.pointerType !== 'mouse';
      try { svg.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
      showGhost(event);
    });
    svg.addEventListener('pointermove', (event) => {
      if (pressed || event.pointerType === 'mouse') showGhost(event);
    });
    svg.addEventListener('pointerup', (event) => {
      if (!pressed) return;
      pressed = false;
      aiming = false;
      const point = pointAt(svg, event, size, true);
      if (point !== null) userMove(point);
      else if (ghost !== null) {
        ghost = null;
        drawBoard(svg, shown, options);
      }
    });
    const drop = () => {
      pressed = false;
      aiming = false;
      if (ghost === null) return;
      ghost = null;
      drawBoard(svg, shown, options);
    };
    svg.addEventListener('pointercancel', drop);
    svg.addEventListener('pointerleave', (event) => {
      if (!pressed && event.pointerType === 'mouse') drop();
    });
  } else if (marking) {
    svg.addEventListener('click', (event) => {
      const point = pointAt(svg, event, size);
      if (point !== null) toggleDead(point);
    });
  }
  const area = el('div', 'board-area');
  area.append(svg);
  return area;
}

/* The panel. */
const numberText = (value) => value.toLocaleString('ru-RU').replace('-', '−');
const sideName = { 1: 'Чёрные', 2: 'Белые' };
const sideKey = { 1: 'black', 2: 'white' };
function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}
function button(label, className, action, disabled = false) {
  const node = el('button', className, label);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
function field(label, input) {
  const box = el('label', 'field');
  box.append(el('span', 'field-label', label), input);
  return box;
}
/** A row of buttons, one of them pressed. */
function picker(label, options, current, pick) {
  const box = el('div', 'field');
  const row = el('div', 'segments');
  for (const [value, text] of options) {
    const node = button(text, value === current ? 'segment on' : 'segment', () => pick(value), Boolean(search));
    node.setAttribute('aria-pressed', String(value === current));
    row.append(node);
  }
  box.append(el('span', 'field-label', label), row);
  return box;
}
function rankBlock() {
  const rank = el('div', 'rank');
  rank.append(el('span', 'rank-label', `${session.user.username} · ранг на OGS`), el('span', 'rank-value', rankText(session.user.ranking) || '—'));
  return rank;
}

const { siteSignIn } = backend;
function loginPanel(side) {
  if (siteSignIn) {
    const box = el('section', 'login');
    box.append(el('p', 'title', 'Вход в OGS'),
      button('Войти через сайт OGS', 'primary', () => siteSignIn.postMessage(null)),
      el('p', 'muted small', 'Откроется страница входа online-go.com: Apple, Google или пароль — как обычно. Окно закроется само, когда вход получится.'));
    side.append(box, el('p', 'muted small divider', 'Или по имени и паролю OGS:'));
  }
  const form = el('form', 'login');
  const username = Object.assign(el('input'), { name: 'username', autocomplete: 'username', required: true, spellcheck: false });
  const password = Object.assign(el('input'), { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  username.setAttribute('autocapitalize', 'off');
  for (const input of [username, password]) {
    input.value = draft[input.name];
    input.addEventListener('input', () => { draft[input.name] = input.value; });
  }
  const submit = Object.assign(el('button', siteSignIn ? 'outline' : 'primary', busy ? 'Вхожу…' : 'Войти'), { type: 'submit', disabled: busy });
  if (!siteSignIn) form.append(el('p', 'title', 'Вход в OGS'));
  form.append(field('Имя на online-go.com', username), field('Пароль', password), submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    signIn();
  });
  const kept = document.documentElement.dataset.mode === 'local' ? 'Вход остаётся на 30 дней или до «выйти».' : 'Вход остаётся до «выйти».';
  side.append(form, el('p', 'muted small', `Пароль уходит только на online-go.com и нигде не хранится. ${kept}`));
  if (!siteSignIn) queueMicrotask(() => (draft.username ? password : username).focus());
}

function lobbyPanel(side) {
  side.append(rankBlock());
  const { size, speed, system } = choice;
  side.append(
    picker('Доска', sizes.map((value) => [value, `${value} × ${value}`]), size, (value) => choose('size', value)),
    picker('Скорость', speeds.map((value) => [value, speedName[value]]), speed, (value) => choose('speed', value)),
    picker('Часы', systems.map((value) => [value, systemName[value]]), system, (value) => choose('system', value)),
    el('p', 'time-text', timeControlText(timeControls[size][speed][system])),
  );
  if (search) {
    side.append(el('p', 'status', 'Ищу соперника…'), el('p', 'muted small', 'Соперник твоего ранга, ±3 ступени, партия на равных.'), button('Отменить', 'outline', cancelMatch));
  } else {
    side.append(button('Найти соперника', 'primary', findMatch, !online));
  }
}

/** A player's row: stone, name and rank, clock; the clock is filled by `tickClocks`. */
function playerRow(color) {
  const player = game.data.players[sideKey[color]];
  const position = gamePosition();
  const row = el('div', 'player');
  const head = el('div', 'player-head');
  const you = color === myColor();
  const name = el('span', 'name', you ? 'Ты' : player.username);
  name.title = player.username;
  head.append(el('span', `stone-mark ${sideKey[color]}`), name, el('span', 'player-rank', rankText(player.rank)));
  // The clock gets a line of its own: with it beside the name, a long name had no room.
  const line = el('div', 'player-line');
  const clock = el('span', 'clock');
  clock.dataset.color = String(color);
  line.append(clock, el('span', 'prisoners', `пленные ${position.captured[color]}`));
  row.append(head, line);
  return row;
}
function statusText(position) {
  const { phase } = game.data;
  if (phase === 'stone removal') {
    return game.accepted ? 'Счёт принят. Ждём соперника…' : 'Оба спасовали. Щелчок по группе отмечает её мёртвой или снова живой.';
  }
  if (game.pending) return 'Ход отправлен…';
  if (yourTurn(position)) return position.passes === 1 ? 'Соперник спасовал. Твой пас в ответ закончит партию.' : 'Твой ход';
  return 'Ход соперника';
}
function countTable(score) {
  const table = el('table', 'count');
  const rows = [
    ['', sideName[1], sideName[2]],
    ['Территория', score.black.territory, score.white.territory],
    ['Пленные', score.black.prisoners, score.white.prisoners],
    ['Коми', '', numberText(score.white.komi)],
    ['Итого', numberText(score.black.total), numberText(score.white.total)],
  ];
  rows.forEach((cells, index) => {
    const row = el('tr', index === rows.length - 1 ? 'total' : '');
    cells.forEach((value, column) => row.append(el(index === 0 || column === 0 ? 'th' : 'td', '', String(value))));
    table.append(row);
  });
  return table;
}
/** OGS's outcome in words: «5.5 points», «Resignation», «Timeout», «Cancellation», … */
function outcomeText(data, winnerColor) {
  const outcome = String(data.outcome ?? '');
  const points = outcome.match(/^([\d.]+) points?$/);
  if (points) return `${sideName[winnerColor]} +${numberText(Number(points[1]))}`;
  const loserIsYou = winnerColor && winnerColor !== myColor();
  if (/resign/i.test(outcome)) return loserIsYou ? 'Ты сдался' : 'Соперник сдался';
  if (/timeout/i.test(outcome)) return loserIsYou ? 'Твоё время вышло' : 'Время соперника вышло';
  if (/disconnect|abandon/i.test(outcome)) return loserIsYou ? 'Ты пропал со связи' : 'Соперник пропал со связи';
  return outcome;
}
function resultBlock() {
  const { data } = game;
  const winnerColor = data.winner === data.players.black.id || data.winner === 'black' ? 1 : data.winner === data.players.white.id || data.winner === 'white' ? 2 : 0;
  const block = el('section', 'result');
  const head = el('div', 'verdict-line');
  if (!winnerColor) {
    head.append(el('p', 'verdict', /cancel/i.test(data.outcome ?? '') ? 'Партия отменена' : 'Партия окончена'));
    if (data.outcome && !/cancel/i.test(data.outcome)) head.append(el('p', 'margin', String(data.outcome)));
  } else {
    const won = winnerColor === myColor();
    head.append(el('p', `verdict ${won ? 'won' : 'lost'}`, won ? 'Победа' : 'Поражение'), el('p', 'margin', outcomeText(data, winnerColor)));
  }
  block.append(head);
  if (data.score && /points?$/.test(data.outcome ?? '')) block.append(countTable(data.score));
  return block;
}
function gamePanel(side) {
  if (!game.data) {
    side.append(el('p', 'status', 'Открываю партию…'));
    return;
  }
  const position = gamePosition();
  const players = el('div', 'players');
  players.append(playerRow(1), playerRow(2));
  side.append(players);
  const { phase } = game.data;
  if (phase === 'finished') {
    side.append(resultBlock(), button('Новая партия', 'primary', newGame));
  } else if (phase === 'stone removal') {
    const actions = el('div', 'actions');
    actions.append(button('Вернуться к игре', 'outline', backToPlay, !online), button('Принять счёт', 'primary', acceptScore, !online || game.accepted));
    side.append(el('p', 'status', statusText(position)), actions);
  } else {
    const open = yourTurn(position);
    const actions = el('div', 'actions');
    actions.append(button('Пас', 'outline', () => userMove(null), !open),
      button(resignAsked ? 'Точно сдаться?' : 'Сдаться', resignAsked ? 'outline danger' : 'outline', resign, !online));
    side.append(el('p', 'status', statusText(position)), actions);
  }
}
function footer(side) {
  const control = game?.data?.time_control;
  const size = boardSize();
  const parts = [`${size} × ${size}`, 'японские правила'];
  if (game?.data) parts.push(`коми ${numberText(game.data.komi)}`);
  if (control?.speed) parts.push(speedName[control.speed] ?? control.speed);
  if (version) parts.push(`версия ${version}`);
  const rules = el('p', 'rules muted', parts.join(' · '));
  rules.append(' · ', button(soundOn() ? 'выключить звук' : 'включить звук', 'link', toggleSound));
  if (session && (!game || game.data?.phase === 'finished')) rules.append(' · ', button('выйти', 'link', signOut));
  side.append(rules);
}
function toggleSound() {
  setSoundOn(!soundOn());
  render();
}

function render() {
  if (screen === 'loading') {
    root.replaceChildren(el('p', 'loading muted', 'Открываю…'));
    return;
  }
  root.classList.toggle('over', game?.data?.phase === 'finished');
  const side = el('aside', 'side');
  if (screen === 'login') loginPanel(side);
  else if (screen === 'lobby') lobbyPanel(side);
  else gamePanel(side);
  if (session && !online) side.append(el('p', 'note', 'Нет связи с OGS, подключаюсь…'));
  if (note) side.append(el('p', 'note', note));
  footer(side);
  root.replaceChildren(boardView(), side);
  tickClocks();
}

/** The clocks run between messages: only their text changes, so the mouse's ghost stone stays. */
function tickClocks() {
  if (!game?.clock || !game.data) return;
  const control = game.data.time_control;
  const now = socket.serverNow();
  for (const node of root.querySelectorAll('.clock')) {
    const color = Number(node.dataset.color);
    const left = timeLeft(game.clock, color, control, now);
    if (!left) continue;
    let text = clockText(left.main);
    if (left.periods !== null) text = left.main > 0 ? `${text} + ${left.periods} × ${Math.round(game.clock[`${sideKey[color]}_time`].period_time)}` : `${clockText(left.period)} · ${left.periods}`;
    node.textContent = text;
    const finished = game.data.phase !== 'play';
    node.classList.toggle('running', left.running && !finished);
    node.classList.toggle('low', left.running && !finished && (left.periods === null || left.main === 0) && (left.main || left.period) < 10);
  }
}
setInterval(tickClocks, 100);

async function start() {
  listenForSound();
  // A phone puts the page to sleep in the background: on return the line to OGS is checked at once.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') socket?.wake();
  });
  try {
    const loaded = await backend.load();
    if (loaded.choice?.size) choice = { ...choice, ...loaded.choice };
    if (loaded.user) {
      session = loaded;
      screen = 'lobby';
      connect();
    } else {
      screen = 'login';
    }
  } catch (error) {
    screen = 'login';
    note = `Не получилось проверить вход: ${error.message}`;
  }
  render();
}
start();
