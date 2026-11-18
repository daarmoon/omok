/*
 * 오목 규칙 모듈 — 서버(Node)와 브라우저가 같은 코드를 씁니다.
 * 보드 값: 0 = 빈칸, 1 = 흑, 2 = 백.  board[y][x]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OmokRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N = 15;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  const inside = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

  function emptyBoard() {
    return Array.from({ length: N }, () => new Array(N).fill(0));
  }

  function boardFromMoves(moves) {
    const b = emptyBoard();
    moves.forEach(([x, y], i) => { b[y][x] = i % 2 === 0 ? 1 : 2; });
    return b;
  }

  // (x,y)에서 (dx,dy) 방향으로 같은 색이 몇 개 이어지는지 (자기 자신 제외)
  function run(board, x, y, dx, dy, c) {
    let n = 0, i = x + dx, j = y + dy;
    while (inside(i, j) && board[j][i] === c) { n++; i += dx; j += dy; }
    return n;
  }

  // 방금 둔 (x,y)로 5목 이상이 됐으면 그 줄의 좌표 배열, 아니면 null
  function fiveLine(board, x, y, c) {
    for (const [dx, dy] of DIRS) {
      const a = run(board, x, y, -dx, -dy, c);
      const b = run(board, x, y, dx, dy, c);
      if (a + b + 1 >= 5) {
        const line = [];
        for (let k = -a; k <= b; k++) line.push([x + k * dx, y + k * dy]);
        return line;
      }
    }
    return null;
  }

  // (x,y)에 c가 놓인 상태에서, 이 방향으로 "열린 3"이 생겼는지.
  // 정의: 같은 줄의 빈칸 하나를 더 채웠을 때 양끝이 비어 있는 "열린 4"(_XXXX_)가 되면 열린 3.
  function isOpenThree(board, x, y, dx, dy, c) {
    const before = run(board, x, y, -dx, -dy, c) + run(board, x, y, dx, dy, c) + 1;
    if (before >= 4) return false; // 이미 4 이상이면 3이 아님
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const ex = x + k * dx, ey = y + k * dy;
      if (!inside(ex, ey) || board[ey][ex] !== 0) continue;
      board[ey][ex] = c;
      const a = run(board, x, y, -dx, -dy, c);
      const b = run(board, x, y, dx, dy, c);
      let open = false;
      if (a + b + 1 === 4) {
        const lx = x - (a + 1) * dx, ly = y - (a + 1) * dy;
        const rx = x + (b + 1) * dx, ry = y + (b + 1) * dy;
        open = inside(lx, ly) && board[ly][lx] === 0 && inside(rx, ry) && board[ry][rx] === 0;
      }
      board[ey][ex] = 0;
      if (open) return true;
    }
    return false;
  }

  // 금수 판정. rule: 'free' | 'no33'
  // no33: 흑·백 모두 열린 3을 동시에 두 개 이상 만드는 수 금지 (단, 그 수로 5목이 되면 허용)
  function isForbidden(board, x, y, c, rule) {
    if (rule !== 'no33') return false;
    if (!inside(x, y) || board[y][x] !== 0) return false;
    board[y][x] = c;
    let forbidden = false;
    if (!fiveLine(board, x, y, c)) {
      let threes = 0;
      for (const [dx, dy] of DIRS) if (isOpenThree(board, x, y, dx, dy, c)) threes++;
      forbidden = threes >= 2;
    }
    board[y][x] = 0;
    return forbidden;
  }

  return { N, DIRS, inside, emptyBoard, boardFromMoves, fiveLine, isForbidden };
});
