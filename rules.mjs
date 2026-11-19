/**
 * Go rules on a flat board: captures, no suicide, simple ko. A point is `y * size + x` from the
 * top-left corner, `null` is a pass; 1 is black, 2 is white. The server judges every move; these rules
 * only draw the board and keep the mouse off points where a stone cannot go.
 */

/** A board with stones set before the first move (handicap), and the side that moves first. */
export function startPosition(size, { black = [], white = [], toPlay = 1 } = {}) {
  const board = new Array(size * size).fill(0);
  for (const point of black) board[point] = 1;
  for (const point of white) board[point] = 2;
  return { size, board, toPlay, captured: { 1: 0, 2: 0 }, before: null, passes: 0, last: null };
}

export function neighbors(point, size) {
  const x = point % size;
  const list = [];
  if (x > 0) list.push(point - 1);
  if (x < size - 1) list.push(point + 1);
  if (point >= size) list.push(point - size);
  if (point < size * (size - 1)) list.push(point + size);
  return list;
}

/** Stones of the group on `start` and whether it has a liberty. */
export function groupOf(board, start, size) {
  const color = board[start];
  const stones = new Set([start]);
  const stack = [start];
  let free = false;
  while (stack.length) {
    for (const point of neighbors(stack.pop(), size)) {
      if (board[point] === 0) free = true;
      else if (board[point] === color && !stones.has(point)) {
        stones.add(point);
        stack.push(point);
      }
    }
  }
  return { stones, free };
}

/**
 * The position after `point` is played by the side to move, or by `color` when given (free handicap
 * stones are several black moves in a row); an illegal move throws with the reason.
 */
export function play(position, point, color = position.toPlay) {
  const { size } = position;
  const next = { size, board: [...position.board], toPlay: 3 - color, captured: { ...position.captured }, before: position.board, passes: 0, last: point };
  if (point === null) return { ...next, passes: position.passes + 1 };
  if (!Number.isInteger(point) || point < 0 || point >= size * size) throw new Error('Ход за пределами доски.');
  if (position.board[point]) throw new Error('Точка занята.');
  next.board[point] = color;
  for (const near of neighbors(point, size)) {
    if (next.board[near] !== 3 - color) continue;
    const { stones, free } = groupOf(next.board, near, size);
    if (free) continue;
    for (const stone of stones) next.board[stone] = 0;
    next.captured[color] += stones.size;
  }
  if (!groupOf(next.board, point, size).free) throw new Error('Самоубийственный ход запрещён.');
  // Simple ko: a move may not bring back the board as it was before the opponent's last move.
  if (position.before?.every((value, i) => value === next.board[i])) throw new Error('Ко: сначала сыграй в другом месте.');
  return next;
}

export function isLegal(position, point) {
  try {
    play(position, point);
    return true;
  } catch {
    return false;
  }
}

/** Every move from the start, passes included; the first `blackFirst` moves are all black's. */
export function replay(size, moves, start = {}, blackFirst = 0) {
  return moves.reduce((position, point, index) => play(position, point, index < blackFirst ? 1 : position.toPlay), startPosition(size, start));
}
