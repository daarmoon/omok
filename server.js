'use strict';
/*
 * OMOK — 실시간 1:1 오목 서버
 *   node server.js   →  http://localhost:3000
 * 정적 파일(public/) + WebSocket(/ws) 을 한 포트에서 같이 서비스합니다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Rules = require('./public/rules.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const N = Rules.N;

const ROOM_IDLE_MS = 30 * 60 * 1000;   // 아무도 없는 방은 30분 뒤 정리
const MAX_ROOMS = 1000;
const TIMER_OPTIONS = [0, 15, 30, 60];
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

/* ───────────────────────── 정적 파일 ───────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname); }
  catch { res.writeHead(400); return res.end('bad request'); }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`ok rooms=${rooms.size}`);
  }
  if (pathname === '/') pathname = '/index.html';

  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

/* ───────────────────────── 방(Room) ───────────────────────── */
const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom({ rule, timer }) {
  const room = {
    code: newCode(),
    rule: rule === 'no33' ? 'no33' : 'free',
    timer: TIMER_OPTIONS.includes(Number(timer)) ? Number(timer) : 0,
    seats: { b: null, w: null },        // { pid, name, score }
    sockets: new Set(),                 // 이 방에 붙어 있는 모든 소켓(관전자 포함)
    moves: [],                          // [[x,y], ...]  짝수 인덱스 = 흑
    board: Rules.emptyBoard(),
    status: 'waiting',                  // waiting | playing | ended
    result: null,                       // { winner, reason, line }
    deadline: null,
    timerHandle: null,
    undoPending: null,                  // 'b' | 'w'
    rematch: { b: false, w: false },
    game: 0,
    chat: [],
    emptySince: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const other = (s) => (s === 'b' ? 'w' : 'b');
const turnOf = (room) => (room.moves.length % 2 === 0 ? 'b' : 'w');
const colorNum = (s) => (s === 'b' ? 1 : 2);

function seatOf(room, pid) {
  if (room.seats.b && room.seats.b.pid === pid) return 'b';
  if (room.seats.w && room.seats.w.pid === pid) return 'w';
  return 'spec';
}

function isOnline(room, pid) {
  for (const ws of room.sockets) if (ws.ctx && ws.ctx.pid === pid) return true;
  return false;
}

function clearTimer(room) {
  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerHandle = null;
  room.deadline = null;
}

function armTimer(room) {
  clearTimer(room);
  if (!room.timer || room.status !== 'playing') return;
  room.deadline = Date.now() + room.timer * 1000;
  room.timerHandle = setTimeout(() => {
    if (room.status !== 'playing') return;
    const loser = turnOf(room);
    sysChat(room, `${nameOf(room, loser)} 님의 시간이 초과되었습니다`);
    endGame(room, other(loser), 'timeout');
    broadcast(room);
  }, room.timer * 1000 + 300); // 네트워크 지연 감안 0.3초 여유
}

function startGame(room) {
  room.game += 1;
  room.moves = [];
  room.board = Rules.emptyBoard();
  room.status = 'playing';
  room.result = null;
  room.undoPending = null;
  room.rematch = { b: false, w: false };
  armTimer(room);
  sysChat(room, `${room.game}국 시작 — 흑 ${room.seats.b.name} vs 백 ${room.seats.w.name}`);
}

function endGame(room, winner, reason, line = null) {
  room.status = 'ended';
  room.result = { winner, reason, line };
  room.undoPending = null;
  room.rematch = { b: false, w: false };
  clearTimer(room);
  if (winner && room.seats[winner]) room.seats[winner].score += 1;
}

function nameOf(room, seat) {
  return room.seats[seat] ? room.seats[seat].name : (seat === 'b' ? '흑' : '백');
}

function sysChat(room, text) {
  pushChat(room, { seat: 'sys', name: '', text, ts: Date.now() });
}

function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 60) room.chat.shift();
  for (const ws of room.sockets) send(ws, { t: 'chat', msg });
}

/* ───────────────────────── 상태 전송 ───────────────────────── */
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function publicPlayer(room, p) {
  return p ? { name: p.name, online: isOnline(room, p.pid), score: p.score } : null;
}

function stateFor(room, pid) {
  let spectators = 0;
  for (const ws of room.sockets) if (ws.ctx && seatOf(room, ws.ctx.pid) === 'spec') spectators++;
  return {
    t: 'state',
    room: room.code,
    rule: room.rule,
    timer: room.timer,
    status: room.status,
    game: room.game,
    you: seatOf(room, pid),
    players: { b: publicPlayer(room, room.seats.b), w: publicPlayer(room, room.seats.w) },
    spectators,
    moves: room.moves,
    turn: turnOf(room),
    result: room.result,
    turnEndsIn: room.status === 'playing' && room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    undoPending: room.undoPending,
    rematch: room.rematch,
  };
}

function broadcast(room) {
  for (const ws of room.sockets) if (ws.ctx) send(ws, stateFor(room, ws.ctx.pid));
}

/* ───────────────────────── 입장 / 퇴장 ───────────────────────── */
function cleanName(s) {
  const name = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return name || '플레이어' + Math.floor(100 + Math.random() * 900);
}

function detach(ws) {
  const ctx = ws.ctx;
  if (!ctx || !ctx.room) return;
  const room = ctx.room;
  room.sockets.delete(ws);
  ws.ctx = null;
  if (room.sockets.size === 0) room.emptySince = Date.now();
  broadcast(room);
}

function joinRoom(ws, room, pid, rawName, preferSeat) {
  if (ws.ctx && ws.ctx.room) detach(ws);
  const name = cleanName(rawName);
  ws.ctx = { room, pid };
  room.sockets.add(ws);

  let seat = seatOf(room, pid);
  if (seat !== 'spec') {
    room.seats[seat].name = name; // 재접속
  } else {
    let empty = null;
    if (preferSeat && !room.seats[preferSeat]) empty = preferSeat;
    else if (!room.seats.b) empty = 'b';
    else if (!room.seats.w) empty = 'w';

    if (empty) {
      room.seats[empty] = { pid, name, score: 0 };
      seat = empty;
      sysChat(room, `${name} 님이 ${empty === 'b' ? '흑' : '백'}으로 입장했습니다`);
      if (room.seats.b && room.seats.w) startGame(room);
    } else {
      // 같은 닉네임의 오프라인 플레이어가 있으면 자리를 이어받음 (브라우저를 바꿨을 때 등)
      for (const s of ['b', 'w']) {
        const p = room.seats[s];
        if (p && p.name === name && !isOnline(room, p.pid)) {
          p.pid = pid; ws.ctx.pid = pid; seat = s;
          sysChat(room, `${name} 님이 다시 접속했습니다`);
          break;
        }
      }
    }
  }

  send(ws, { t: 'joined', room: room.code, seat });
  send(ws, { t: 'chat_history', list: room.chat });
  broadcast(room);
}

function leaveRoom(ws) {
  const ctx = ws.ctx;
  if (!ctx || !ctx.room) return;
  const room = ctx.room;
  const seat = seatOf(room, ctx.pid);
  if (seat !== 'spec') {
    const name = room.seats[seat].name;
    if (room.status === 'playing') endGame(room, other(seat), 'left');
    // 같은 플레이어의 다른 탭도 같이 내보냄
    for (const s of [...room.sockets]) {
      if (s !== ws && s.ctx && s.ctx.pid === ctx.pid) { room.sockets.delete(s); s.ctx = null; send(s, { t: 'left' }); }
    }
    room.seats[seat] = null;
    room.rematch = { b: false, w: false };
    if (room.status !== 'ended') room.status = 'waiting';
    sysChat(room, `${name} 님이 나갔습니다`);
  }
  send(ws, { t: 'left' });
  detach(ws);
}

/* ───────────────────────── 메시지 처리 ───────────────────────── */
function err(ws, msg, code) { send(ws, { t: 'error', msg, code }); }

function handle(ws, m) {
  if (!m || typeof m !== 'object') return;
  const pid = typeof m.pid === 'string' ? m.pid.slice(0, 64) : null;

  if (m.t === 'create') {
    if (!pid) return;
    if (rooms.size >= MAX_ROOMS) return err(ws, '서버에 방이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const room = createRoom({ rule: m.rule, timer: m.timer });
    let prefer = m.color === 'b' || m.color === 'w' ? m.color : (Math.random() < 0.5 ? 'b' : 'w');
    return joinRoom(ws, room, pid, m.name, prefer);
  }

  if (m.t === 'join') {
    if (!pid) return;
    const room = rooms.get(String(m.room || '').toUpperCase().trim());
    if (!room) return err(ws, '방을 찾을 수 없습니다. 코드를 확인해 주세요.', 'NO_ROOM');
    return joinRoom(ws, room, pid, m.name);
  }

  const ctx = ws.ctx;
  if (!ctx || !ctx.room) return;
  const room = ctx.room;
  const seat = seatOf(room, ctx.pid);
  const isPlayer = seat === 'b' || seat === 'w';

  switch (m.t) {
    case 'move': {
      if (!isPlayer) return;
      if (room.status !== 'playing') return err(ws, '지금은 둘 수 없습니다.');
      if (turnOf(room) !== seat) return err(ws, '상대 차례입니다.');
      const x = m.x, y = m.y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Rules.inside(x, y)) return;
      if (room.board[y][x] !== 0) return err(ws, '이미 돌이 있는 자리입니다.');
      const c = colorNum(seat);
      if (Rules.isForbidden(room.board, x, y, c, room.rule)) return err(ws, '쌍삼 금지 자리입니다.', 'FORBIDDEN');
      room.board[y][x] = c;
      room.moves.push([x, y]);
      room.undoPending = null;
      const line = Rules.fiveLine(room.board, x, y, c);
      if (line) {
        endGame(room, seat, 'five', line);
        sysChat(room, `${nameOf(room, seat)} 님 승리! (${room.moves.length}수)`);
      } else if (room.moves.length >= N * N) {
        endGame(room, null, 'draw');
        sysChat(room, '판이 가득 찼습니다 — 무승부');
      } else {
        armTimer(room);
      }
      return broadcast(room);
    }

    case 'undo_req': {
      if (!isPlayer || room.status !== 'playing' || room.undoPending) return;
      const myMoves = room.moves.filter((_, i) => (i % 2 === 0 ? 'b' : 'w') === seat).length;
      if (!myMoves) return err(ws, '되돌릴 내 수가 없습니다.');
      room.undoPending = seat;
      sysChat(room, `${nameOf(room, seat)} 님이 무르기를 요청했습니다`);
      return broadcast(room);
    }

    case 'undo_res': {
      if (!isPlayer || !room.undoPending || room.undoPending === seat || room.status !== 'playing') return;
      const req = room.undoPending;
      room.undoPending = null;
      if (m.accept) {
        const lastBy = (room.moves.length - 1) % 2 === 0 ? 'b' : 'w';
        const n = lastBy === req ? 1 : 2; // 요청자의 마지막 수까지 되돌림
        for (let i = 0; i < n && room.moves.length; i++) {
          const [x, y] = room.moves.pop();
          room.board[y][x] = 0;
        }
        armTimer(room);
        sysChat(room, '무르기가 수락되었습니다');
      } else {
        sysChat(room, '무르기가 거절되었습니다');
      }
      return broadcast(room);
    }

    case 'resign': {
      if (!isPlayer || room.status !== 'playing') return;
      sysChat(room, `${nameOf(room, seat)} 님이 기권했습니다`);
      endGame(room, other(seat), 'resign');
      return broadcast(room);
    }

    case 'rematch': {
      if (!isPlayer || room.status !== 'ended' || !room.seats.b || !room.seats.w) return;
      room.rematch[seat] = true;
      if (room.rematch.b && room.rematch.w) {
        // 재대국은 흑·백을 바꿔서
        [room.seats.b, room.seats.w] = [room.seats.w, room.seats.b];
        startGame(room);
      } else {
        sysChat(room, `${nameOf(room, seat)} 님이 재대국을 원합니다`);
      }
      return broadcast(room);
    }

    case 'chat': {
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (!text) return;
      const name = isPlayer ? room.seats[seat].name : '관전자';
      return pushChat(room, { seat, name, text, ts: Date.now() });
    }

    case 'leave':
      return leaveRoom(ws);
  }
}

/* ───────────────────────── WebSocket ───────────────────────── */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = null;
  ws.bucket = { t: Date.now(), n: 0 };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    // 간단한 도배 방지: 초당 25개 초과 메시지는 무시
    const now = Date.now();
    if (now - ws.bucket.t > 1000) ws.bucket = { t: now, n: 0 };
    if (++ws.bucket.n > 25) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    try { handle(ws, m); } catch (e) { console.error('handle error', e); }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// 끊긴 연결 감지 + 빈 방 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.sockets.size === 0 && now - room.emptySince > ROOM_IDLE_MS) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 25000).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  ● OMOK 서버 실행 중 → http://localhost:${PORT}\n`);
  try {
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`    같은 와이파이에서: http://${n.address}:${PORT}`);
    }
  } catch {}
  console.log('');
});
