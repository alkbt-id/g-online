/**
 * What the OGS server sends and expects, as plain functions: moves in letters, ranks, the time
 * controls of quick match, the clocks and the territory at the end. No network here.
 */
import { groupOf, neighbors } from './rules.mjs';

export const sizes = [9, 13, 19];
export const speeds = ['blitz', 'rapid', 'live'];
export const systems = ['byoyomi', 'fischer'];
export const speedName = { blitz: 'Блиц', rapid: 'Рапид', live: 'Живая' };
export const systemName = { byoyomi: 'Бёёми', fischer: 'Фишер' };

/**
 * The clocks OGS gives a quick match game, as its own site lists them (`SPEED_OPTIONS` in online-go.com):
 * Fischer — start time and the bonus per move; byo-yomi — main time, then periods of so many seconds.
 */
const fischer = (initial, increment) => ({ initial, increment });
const byoyomi = (main, periods, period) => ({ main, periods, period });
export const timeControls = {
  9: {
    blitz: { fischer: fischer(30, 5), byoyomi: byoyomi(30, 5, 10) },
    rapid: { fischer: fischer(120, 7), byoyomi: byoyomi(120, 5, 30) },
    live: { fischer: fischer(180, 10), byoyomi: byoyomi(300, 5, 30) },
  },
  13: {
    blitz: { fischer: fischer(30, 5), byoyomi: byoyomi(30, 5, 10) },
    rapid: { fischer: fischer(180, 7), byoyomi: byoyomi(180, 5, 30) },
    live: { fischer: fischer(300, 10), byoyomi: byoyomi(600, 5, 30) },
  },
  19: {
    blitz: { fischer: fischer(30, 5), byoyomi: byoyomi(30, 5, 10) },
    rapid: { fischer: fischer(300, 7), byoyomi: byoyomi(300, 5, 30) },
    live: { fischer: fischer(600, 10), byoyomi: byoyomi(1200, 5, 30) },
  },
};

/** Seconds as «30 с», «2 мин», «1 мин 30 с». */
export function durationText(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${rest} с`;
  return rest ? `${minutes} мин ${rest} с` : `${minutes} мин`;
}
/** A time control in words: «2 мин + 7 с за ход», «5 мин + 5 × 30 с». */
export function timeControlText(control) {
  if ('increment' in control) return `${durationText(control.initial)} + ${durationText(control.increment)} за ход`;
  return `${durationText(control.main)} + ${control.periods} × ${durationText(control.period)}`;
}

/** What `automatch/find_match` takes: one board, one speed, one clock; japanese rules, no handicap. */
export function matchRequest({ size, speed, system }, uuid, rankRange = 3) {
  return {
    uuid,
    size_speed_options: [{ size: `${size}x${size}`, speed, system }],
    lower_rank_diff: rankRange,
    upper_rank_diff: rankRange,
    rules: { condition: 'required', value: 'japanese' },
    handicap: { condition: 'required', value: 'disabled' },
  };
}

/** OGS ranks are numbers: 30 is 1 dan, 29 is 1 kyu, 20 is 10 kyu. */
export function rankText(rank) {
  if (typeof rank !== 'number' || !Number.isFinite(rank)) return '';
  const whole = Math.floor(rank);
  return whole < 30 ? `${30 - whole} кю` : `${whole - 29} дан`;
}

/* Moves. OGS counts x from the left and y from the top, as letters «a»…; a pass is «..» or (-1, -1). */
const letters = 'abcdefghijklmnopqrstuvwxyz';
export function encodeMove(point, size) {
  if (point === null) return '..';
  return letters[point % size] + letters[Math.floor(point / size)];
}
/** A move from `gamedata.moves` or a `move` event: `[x, y, time, …]`. */
export function pointOf(move, size) {
  const [x, y] = move;
  return x < 0 || y < 0 ? null : y * size + x;
}
/** Points from a letter string such as `initial_state.black` or `removed`: «aabb» is two points. */
export function decodePoints(text, size) {
  const points = [];
  for (let i = 0; i + 1 < (text ?? '').length; i += 2) {
    const x = letters.indexOf(text[i]);
    const y = letters.indexOf(text[i + 1]);
    if (x >= 0 && y >= 0 && x < size && y < size) points.push(y * size + x);
  }
  return points;
}
export const encodePoints = (points, size) => [...points].map((point) => encodeMove(point, size)).join('');

/* Clocks. */
/**
 * Time left for one player at server time `now` (ms), from the last `clock` message. The player to move
 * spends main time first, then byo-yomi periods; a Fischer clock has main time only.
 * Returns `{ main, periods, period }` in seconds: `periods` is null for Fischer.
 */
export function timeLeft(clock, color, control, now) {
  const time = color === 1 ? clock.black_time : clock.white_time;
  const playerId = color === 1 ? clock.black_player_id : clock.white_player_id;
  if (time === undefined || time === null) return null;
  const running = clock.current_player === playerId && !clock.pause?.paused && !clock.paused_since;
  let spent = running ? Math.max(0, (now - clock.last_move) / 1000) : 0;
  if (typeof time === 'number') return { main: Math.max(0, time - now / 1000), periods: null, period: 0, running };
  if (control?.system !== 'byoyomi') return { main: Math.max(0, time.thinking_time - spent), periods: null, period: 0, running };
  let main = time.thinking_time;
  if (main > 0 && spent <= main) return { main: main - spent, periods: time.periods, period: time.period_time, running };
  spent -= main;
  main = 0;
  let periods = time.periods;
  let period = time.period_time_left ?? time.period_time;
  while (periods > 0 && spent >= period) {
    spent -= period;
    periods--;
    period = time.period_time;
  }
  return { main: 0, periods, period: periods > 0 ? period - spent : 0, running };
}
/** Seconds on a clock face: «4:05», under ten seconds «7,3». */
export function clockText(seconds) {
  if (seconds < 10) return Math.max(0, seconds).toFixed(1).replace('.', ',');
  const whole = Math.ceil(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/* The end. */
/** All stones of the group on `point`, to mark dead or alive in one click. */
export const groupStones = (board, point, size) => [...groupOf(board, point, size).stones];

/**
 * Whose each point is once `dead` stones are taken off: an empty area touching only one color is that
 * color's, and so are the dead stones in it. 0 for neutral points and live stones.
 */
export function territory(board, dead, size) {
  const cleared = board.map((color, point) => (dead.has(point) ? 0 : color));
  const owners = new Array(board.length).fill(0);
  const seen = new Set();
  for (let start = 0; start < board.length; start++) {
    if (cleared[start] || seen.has(start)) continue;
    const area = [start];
    const borders = new Set();
    seen.add(start);
    for (let i = 0; i < area.length; i++) {
      for (const near of neighbors(area[i], size)) {
        if (cleared[near]) borders.add(cleared[near]);
        else if (!seen.has(near)) {
          seen.add(near);
          area.push(near);
        }
      }
    }
    if (borders.size !== 1) continue;
    const [owner] = borders;
    for (const point of area) owners[point] = owner;
  }
  return owners;
}
/** The territory OGS counted: `score.<side>.scoring_positions` as points. */
export function scoredOwners(score, size) {
  const owners = new Array(size * size).fill(0);
  for (const [color, side] of [[1, 'black'], [2, 'white']]) {
    for (const point of decodePoints(score?.[side]?.scoring_positions ?? '', size)) owners[point] = color;
  }
  return owners;
}
