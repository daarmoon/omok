(() => {
  'use strict';
  const Rules = window.OmokRules;
  const N = Rules.N;
  const $ = (s) => document.querySelector(s);

  /* ═════════════════════ 저장소 / 식별자 ═════════════════════ */
  const store = (area) => ({
    get(k, d) { try { const v = area.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { area.setItem(k, v); } catch {} },
  });
  const ls = store(window.localStorage);
  const ss = store(window.sessionStorage);
  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // 탭마다 다른 플레이어 ID → 같은 브라우저 탭 두 개로도 대국 테스트 가능. 새로고침해도 유지.
  let pid = ss.get('omok.pid');
  if (!pid) { pid = makeId(); ss.set('omok.pid', pid); }

  const nameInput = $('#name');
  nameInput.value = ls.get('omok.name', '');
  const myName = () => {
    const v = nameInput.value.trim();
    if (v) ls.set('omok.name', v);
    return v || ls.get('omok.name', '');
  };

  /* ═════════════════════ 네트워크 ═════════════════════ */
  let ws = null, wsOpen = false, retry = 0;
  const outbox = [];
  let currentRoom = null;

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      wsOpen = true; retry = 0;
      $('#conn').hidden = true;
      if (currentRoom) ws.send(JSON.stringify({ t: 'join', pid, name: myName(), room: currentRoom }));
      outbox.splice(0).forEach((m) => ws.send(JSON.stringify(m)));
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      wsOpen = false;
      if (currentRoom) $('#conn').hidden = false;
      setTimeout(connect, Math.min(4000, 300 * 2 ** retry++));
    };
  }
  // 무료 호스팅(Render 등)은 15분간 들어오는 메시지가 없으면 서버를 재우므로,
  // 방에 들어가 있는 동안은 4분마다 살아 있다는 신호를 보냅니다.
  setInterval(() => { if (currentRoom && wsOpen) ws.send(JSON.stringify({ t: 'ping', pid })); }, 4 * 60 * 1000);

  function send(m) {
    m.pid = pid;
    if (wsOpen) ws.send(JSON.stringify(m));
    else outbox.push(m);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        currentRoom = m.room;
        ss.set('omok.room', m.room);
        history.replaceState(null, '', '?room=' + m.room);
        showGame();
        break;
      case 'state': applyState(m); break;
      case 'chat_history': $('#chatLog').innerHTML = ''; m.list.forEach((c) => addChat(c, true)); break;
      case 'chat': addChat(m.msg); break;
      case 'error':
        if (m.code === 'NO_ROOM' && currentRoom) toast('서버가 다시 시작돼서 방이 사라졌어요. 새 방을 만들어 주세요.', true);
        else toast(m.msg, true);
        if (m.code === 'FORBIDDEN') sfx('deny');
        if (m.code === 'NO_ROOM') { currentRoom = null; ss.set('omok.room', ''); history.replaceState(null, '', location.pathname); showLobby(true); }
        break;
      case 'left':
        currentRoom = null; ss.set('omok.room', '');
        history.replaceState(null, '', location.pathname);
        showLobby(true);
        break;
    }
  }

  /* ═════════════════════ 화면 전환 ═════════════════════ */
  const params = new URLSearchParams(location.search);
  const pathCode = location.pathname.replace(/\//g, '');
  let inviteRoom = (params.get('room') || (/^[A-Za-z0-9]{4}$/.test(pathCode) ? pathCode : '')).toUpperCase().slice(0, 4);

  function showInvite(on) {
    $('#inviteBox').hidden = !on;
    $('#createBox').hidden = on;
    if (on) $('#inviteCode').textContent = inviteRoom;
  }
  function showGame() {
    $('#lobby').hidden = true;
    $('#game').hidden = false;
    requestAnimationFrame(layout);
  }
  function showLobby(resetInvite) {
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    closeModal();
    S = null;
    if (resetInvite) inviteRoom = '';
    showInvite(!!inviteRoom);
  }

  // 탭을 '복제'하면 sessionStorage(플레이어 ID)까지 복사돼서 두 탭이 같은 사람이 되어 버림.
  // 같은 ID를 쓰는 탭이 이미 열려 있으면 이 탭은 새 ID를 받는다.
  function checkDuplicateTab() {
    return new Promise((resolve) => {
      let bc;
      try { bc = new BroadcastChannel('omok-pid'); } catch { return resolve(); }
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      bc.onmessage = (e) => {
        const d = e.data || {};
        if (d.q === pid) bc.postMessage({ a: pid });
        if (d.a === pid && !settled) {
          pid = makeId(); ss.set('omok.pid', pid); ss.set('omok.room', '');
          done();
        }
      };
      bc.postMessage({ q: pid });
      setTimeout(done, 150);
    });
  }

  checkDuplicateTab().then(() => {
    showInvite(!!inviteRoom);
    // 새로고침했을 때는 바로 그 방으로 복귀
    if (inviteRoom && ss.get('omok.room', '') === inviteRoom) currentRoom = inviteRoom;
    connect();
  });

  /* ═════════════════════ 로비 이벤트 ═════════════════════ */
  const opts = { rule: 'free', timer: '0', color: 'random' };
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      opts[seg.dataset.name] = b.dataset.v;
    });
  });

  $('#create').onclick = () => {
    unlockAudio();
    send({ t: 'create', name: myName(), rule: opts.rule, timer: Number(opts.timer), color: opts.color });
  };
  $('#joinForm').onsubmit = (e) => {
    e.preventDefault();
    unlockAudio();
    const code = $('#code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('방 코드 4자리를 입력해 주세요', true);
    send({ t: 'join', name: myName(), room: code });
  };
  $('#joinInvite').onclick = () => { unlockAudio(); send({ t: 'join', name: myName(), room: inviteRoom }); };
  $('#cancelInvite').onclick = () => { inviteRoom = ''; history.replaceState(null, '', location.pathname); showInvite(false); };
  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (inviteRoom) $('#joinInvite').click(); else $('#create').click();
  });

  /* ═════════════════════ 게임 상태 ═════════════════════ */
  let S = null;                         // 서버에서 받은 마지막 상태
  let board = Rules.emptyBoard();
  let forbidden = new Set();            // 지금 내가 둘 수 없는 자리 "x,y"
  let deadlineAt = null;                // performance.now() 기준 마감 시각
  const anims = new Map();              // "x,y" → 착수 애니메이션 시작 시각
  let endAt = 0;                        // 승부가 난 시각 (승리 라인 애니메이션)
  let hover = null, pending = null;     // 마우스 호버 / 터치 1차 선택

  const other = (c) => (c === 'b' ? 'w' : 'b');
  const isPlayer = () => S && (S.you === 'b' || S.you === 'w');
  const canPlay = () => S && S.status === 'playing' && S.you === S.turn;
  const pname = (c) => (S.players[c] ? S.players[c].name : c === 'b' ? '흑' : '백');
  const REASON = { five: '다섯 줄 완성', resign: '기권', timeout: '시간 초과', left: '상대가 나감', draw: '판이 가득 참' };

  function applyState(s) {
    const prev = S;
    S = s;
    const sameGame = prev && prev.room === s.room && prev.game === s.game;
    board = Rules.boardFromMoves(s.moves);

    if (sameGame && s.moves.length === prev.moves.length + 1) {
      const [x, y] = s.moves[s.moves.length - 1];
      anims.set(x + ',' + y, performance.now());
      sfx(s.moves.length % 2 === 1 ? 'b' : 'w');
    } else if (!sameGame) {
      anims.clear();
      if (prev && s.status === 'playing') sfx('start');
    }

    if (s.status === 'ended' && !(sameGame && prev.status === 'ended')) {
      endAt = performance.now();
      if (prev) {
        const w = s.result && s.result.winner;
        setTimeout(() => sfx(!w ? 'end' : (s.you === 'spec' || w === s.you) ? 'win' : 'lose'), 380);
      }
    }

    if (!sameGame || prev.moves.length !== s.moves.length || prev.status !== s.status) {
      pending = null; $('#hint').hidden = true;
    }
    deadlineAt = s.turnEndsIn != null ? performance.now() + s.turnEndsIn : null;
    lastSec = null;

    forbidden = new Set();
    if (s.rule === 'no33' && canPlay()) {
      const c = s.you === 'b' ? 1 : 2;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (board[y][x] === 0 && Rules.isForbidden(board, x, y, c, s.rule)) forbidden.add(x + ',' + y);
      }
    }
    renderUI();
  }

  /* ═════════════════════ UI ═════════════════════ */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderUI() {
    const s = S, you = s.you;
    $('#roomCode').textContent = s.room;

    for (const c of ['b', 'w']) {
      const card = $('#p' + c), p = s.players[c];
      const nm = card.querySelector('.pname');
      nm.textContent = p ? p.name : '대기 중…';
      if (you === c) nm.append(el('span', 'badge-me', '나'));
      const meta = card.querySelector('.pmeta');
      meta.replaceChildren(el('span', 'dot' + (p && p.online ? '' : ' off')),
        document.createTextNode(c === 'b' ? '흑 · 선공' : '백'),
        ...(p && !p.online ? [document.createTextNode(' · 연결 끊김')] : []));
      card.querySelector('.pscore').textContent = p ? p.score : '';
      card.classList.toggle('turn', s.status === 'playing' && s.turn === c);
      card.classList.toggle('empty', !p);
    }

    // 상태 줄
    if (s.status === 'waiting') {
      setStatus(null, '상대를 기다리는 중 · 초대 링크를 보내세요');
    } else if (s.status === 'playing') {
      if (s.undoPending && s.undoPending === you) setStatus(you, '무르기 요청 중…');
      else if (you === s.turn) setStatus(you, '당신 차례입니다', 'mine');
      else if (you === 'spec') setStatus(s.turn, `${pname(s.turn)} 님 차례 (관전 중)`);
      else setStatus(s.turn, '상대가 생각하는 중…');
    } else {
      const w = s.result && s.result.winner;
      const reason = REASON[s.result && s.result.reason] || '';
      if (!w) setStatus(null, `무승부 · ${reason}`);
      else if (you === 'spec') setStatus(w, `${pname(w)} 님 승리 · ${reason}`, 'win');
      else setStatus(w, w === you ? `승리! · ${reason}` : `패배 · ${reason}`, w === you ? 'win' : '');
    }

    // 버튼
    const player = isPlayer();
    const myMoves = player ? s.moves.filter((_, i) => (i % 2 === 0 ? 'b' : 'w') === you).length : 0;
    $('#undo').hidden = $('#resign').hidden = !player || s.status !== 'playing';
    $('#undo').disabled = !(s.status === 'playing' && !s.undoPending && myMoves > 0);
    $('#resign').disabled = s.status !== 'playing';
    const canRematch = player && s.status === 'ended' && s.players.b && s.players.w;
    for (const b of [$('#rematch'), $('#ovRematch')]) {
      b.hidden = !canRematch;
      if (!canRematch) continue;
      b.disabled = !!s.rematch[you];
      const short = b.id === 'ovRematch';
      b.textContent = s.rematch[you] ? (short ? '대기 중…' : '상대를 기다리는 중…')
        : s.rematch[other(you)] ? '재대국 수락' : (short ? '재대국' : '재대국 (흑백 교대)');
    }

    // 무르기 요청 받음
    if (player && s.status === 'playing' && s.undoPending && s.undoPending !== you) {
      if (modalKind !== 'undo') openModal('상대가 무르기를 요청했습니다.', (ok) => send({ t: 'undo_res', accept: ok }), '수락', '거절', 'undo');
    } else if (modalKind === 'undo') closeModal();

    renderOverlay();
    $('#ruleMeta').textContent =
      `${s.rule === 'no33' ? '쌍삼 금지' : '자유룰'} · ${s.timer ? `수당 ${s.timer}초` : '시간 제한 없음'} · ${Math.max(1, s.game)}국째` +
      (s.spectators ? ` · 관전 ${s.spectators}명` : '');
  }

  let lastSec = null;
  function setStatus(gem, text, cls) {
    const st = $('#status');
    st.className = 'status' + (cls ? ' ' + cls : '');
    st.replaceChildren(...(gem && gem !== 'spec' ? [el('span', 'gem ' + gem)] : []), el('span', null, text), el('span', 'sec'));
    lastSec = null;
  }

  let ovMode = '', ovDismissed = '';
  $('#ovClose').onclick = () => { ovDismissed = ovMode; $('#overlay').hidden = true; };
  function renderOverlay() {
    const s = S, ov = $('#overlay');
    let mode = '';
    if (s.status === 'waiting') mode = 'wait';
    else if (s.status === 'ended') mode = 'result';
    const key = mode + ':' + s.game;
    if (!mode || key === ovDismissed) { ov.hidden = true; if (!mode) ovMode = ''; return; }
    if (key !== ovMode) { // 새로 뜰 때만 애니메이션
      ov.hidden = true; ov.className = 'overlay ' + mode; void ov.offsetWidth; ov.hidden = false; ovMode = key;
    }
    const gem = $('#ovGem');
    if (mode === 'wait') {
      gem.className = 'gem big ' + (isPlayer() ? s.you : 'b');
      $('#ovTitle').textContent = '상대를 기다리는 중';
      $('#ovSub').textContent = '친구에게 방 코드나 초대 링크를 보내세요';
      $('#ovCode').hidden = false; $('#ovCode').textContent = s.room;
      $('#ovCopy').hidden = false;
    } else {
      const w = s.result && s.result.winner;
      gem.className = 'gem big ' + (w || '');
      gem.hidden = !w;
      $('#ovTitle').textContent = !w ? '무승부' : s.you === 'spec' ? `${pname(w)} 님 승리` : w === s.you ? '승리!' : '패배';
      const opponentGone = isPlayer() && !s.players[other(s.you)];
      $('#ovSub').textContent = `${REASON[s.result.reason] || ''} · ${s.moves.length}수` +
        (opponentGone ? ' · 새 상대를 기다리는 중' : '');
      $('#ovCode').hidden = true;
      $('#ovCopy').hidden = !opponentGone;
    }
    if (mode === 'wait') gem.hidden = false;
  }

  /* 채팅 */
  function addChat(m, silent) {
    const log = $('#chatLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const row = el('div', 'msg ' + m.seat);
    if (m.seat === 'sys') row.textContent = m.text;
    else row.append(el('span', 'who', m.name), document.createTextNode(m.text));
    log.append(row);
    if (atBottom || !silent) log.scrollTop = log.scrollHeight;
    if (!silent && S && m.seat !== 'sys' && m.seat !== S.you) sfx('chat');
  }
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (!v) return;
    send({ t: 'chat', text: v });
    $('#chatInput').value = '';
  };

  /* 버튼 */
  $('#undo').onclick = () => send({ t: 'undo_req' });
  $('#resign').onclick = () => openModal('정말 기권할까요?', (ok) => ok && send({ t: 'resign' }), '기권', '취소', 'confirm');
  $('#rematch').onclick = $('#ovRematch').onclick = () => send({ t: 'rematch' });
  $('#copyLink').onclick = $('#ovCopy').onclick = shareInvite;
  $('#leave').onclick = () => {
    if (isPlayer() && S.status === 'playing') openModal('대국 중에 나가면 기권 처리됩니다.\n나갈까요?', (ok) => ok && send({ t: 'leave' }), '나가기', '취소', 'confirm');
    else send({ t: 'leave' });
  };
  let muted = ls.get('omok.muted', '0') === '1';
  const soundBtn = $('#sound');
  const paintSound = () => { soundBtn.textContent = muted ? '소리 끔' : '소리 켬'; soundBtn.setAttribute('aria-pressed', String(!muted)); };
  paintSound();
  soundBtn.onclick = () => { muted = !muted; ls.set('omok.muted', muted ? '1' : '0'); paintSound(); unlockAudio(); sfx('tick'); };

  async function shareInvite() {
    const url = location.origin + '/?room=' + S.room;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'OMOK · 오목 한 판', text: `오목 한 판 두자! 방 코드 ${S.room}`, url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('초대 링크를 복사했어요'); return; } catch {}
    const ta = el('textarea'); ta.value = url; ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    if (ok) toast('초대 링크를 복사했어요'); else window.prompt('이 링크를 친구에게 보내세요', url);
  }

  /* 모달 · 토스트 */
  let modalCb = null, modalKind = null;
  function openModal(text, cb, yes = '수락', no = '거절', kind = 'confirm') {
    $('#modalText').innerText = text;
    $('#modalYes').textContent = yes; $('#modalNo').textContent = no;
    modalCb = cb; modalKind = kind;
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; modalCb = null; modalKind = null; }
  $('#modalYes').onclick = () => { const cb = modalCb; closeModal(); cb && cb(true); };
  $('#modalNo').onclick = () => { const cb = modalCb; closeModal(); cb && cb(false); };

  function toast(text, isErr) {
    const t = el('div', 'toast' + (isErr ? ' err' : ''), text);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 2800);
  }

  /* ═════════════════════ 사운드 (WebAudio 합성 — 유리 돌 소리) ═════════════════════ */
  let AC = null, master = null;
  function unlockAudio() {
    try {
      if (!AC) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        AC = new C();
        master = AC.createGain(); master.gain.value = 0.9;
        const comp = AC.createDynamicsCompressor();
        master.connect(comp); comp.connect(AC.destination);
      }
      if (AC.state === 'suspended') AC.resume();
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);

  function tone(f, t, dur, vol, type = 'sine') {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function click(t, freq, vol) {
    const len = Math.floor(AC.sampleRate * 0.045);
    const buf = AC.createBuffer(1, len, AC.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    const src = AC.createBufferSource(), bp = AC.createBiquadFilter(), g = AC.createGain();
    src.buffer = buf; bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.2; g.gain.value = vol;
    src.connect(bp); bp.connect(g); g.connect(master); src.start(t);
  }
  function sfx(kind) {
    if (muted || !AC || AC.state !== 'running') return;
    const t = AC.currentTime + 0.01;
    switch (kind) {
      case 'b': click(t, 1100, 0.9); tone(1568, t, 0.55, 0.06); tone(2349, t, 0.35, 0.03); tone(523, t, 0.18, 0.05, 'triangle'); break;
      case 'w': click(t, 1700, 0.8); tone(1976, t, 0.55, 0.06); tone(2960, t, 0.35, 0.03); tone(659, t, 0.18, 0.05, 'triangle'); break;
      case 'win': [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, t + i * 0.09, 1.1, 0.06)); break;
      case 'lose': [784, 659, 523].forEach((f, i) => tone(f, t + i * 0.13, 0.8, 0.05)); break;
      case 'end': tone(880, t, 0.7, 0.05); break;
      case 'start': tone(1319, t, 0.4, 0.04); tone(1976, t + 0.08, 0.5, 0.04); break;
      case 'tick': tone(2600, t, 0.07, 0.03); break;
      case 'deny': tone(196, t, 0.18, 0.07, 'triangle'); break;
      case 'chat': tone(1320, t, 0.16, 0.025); tone(1760, t + 0.06, 0.16, 0.02); break;
    }
  }

  /* ═════════════════════ 판 렌더링 (Canvas) ═════════════════════ */
  const canvas = $('#board');
  const ctx = canvas.getContext('2d');
  let W = 0, DPR = 1, CELL = 0, PAD = 0, RAD = 0;
  let gridLayer = null, gridDark = null, SPR = null;
  const P = (i) => PAD + i * CELL;
  const TAU = Math.PI * 2;
  const DROP_MS = 420;

  function layout() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    DPR = Math.min(window.devicePixelRatio || 1, 3);
    W = Math.round(rect.width * DPR);
    canvas.width = W; canvas.height = W;
    CELL = W / 15.9;
    PAD = (W - CELL * (N - 1)) / 2;
    RAD = CELL * 0.46;
    gridLayer = makeGrid();
    // 흰 돌 너머로 비치는 격자는 어둡게 보여야 해서 색을 입힌 사본을 하나 더
    gridDark = makeCanvas(W);
    const gd = gridDark.getContext('2d');
    gd.drawImage(gridLayer, 0, 0);
    gd.globalCompositeOperation = 'source-in';
    gd.fillStyle = 'rgb(46,62,112)'; gd.fillRect(0, 0, W, W);
    SPR = { b: makeStone('b'), w: makeStone('w') };
  }
  new ResizeObserver(layout).observe(canvas);

  function makeCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = Math.ceil(size);
    return c;
  }

  function makeGrid() {
    const c = makeCanvas(W), g = c.getContext('2d');
    const lw = Math.max(1, Math.round(DPR));
    const snap = (v) => Math.round(v) + (lw % 2 ? 0.5 : 0);
    const a = snap(P(0)), z = snap(P(N - 1));

    // 은은하게 빛나는 격자
    g.save();
    g.shadowColor = 'rgba(130,150,255,0.6)'; g.shadowBlur = 6 * DPR;
    g.strokeStyle = 'rgba(190,204,255,0.21)'; g.lineWidth = lw;
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const v = snap(P(i));
      g.moveTo(a, v); g.lineTo(z, v);
      g.moveTo(v, a); g.lineTo(v, z);
    }
    g.stroke();
    g.restore();
    g.strokeStyle = 'rgba(205,215,255,0.38)'; g.lineWidth = lw * 1.5;
    g.strokeRect(a, a, z - a, z - a);

    // 화점
    for (const [x, y] of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) {
      const gr = g.createRadialGradient(P(x), P(y), 0, P(x), P(y), CELL * 0.34);
      gr.addColorStop(0, 'rgba(190,200,255,0.35)'); gr.addColorStop(1, 'rgba(190,200,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(P(x), P(y), CELL * 0.34, 0, TAU); g.fill();
      g.fillStyle = 'rgba(220,228,255,0.9)';
      g.beginPath(); g.arc(P(x), P(y), Math.max(2 * DPR, CELL * 0.07), 0, TAU); g.fill();
    }

    // 좌표 (희미하게)
    g.fillStyle = 'rgba(180,190,230,0.26)';
    g.font = `500 ${Math.round(CELL * 0.22)}px "Pretendard Variable", Pretendard, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const letters = 'ABCDEFGHJKLMNOP';
    for (let i = 0; i < N; i++) {
      g.fillText(letters[i], P(i), PAD * 0.4);
      g.fillText(String(N - i), PAD * 0.4, P(i));
    }
    return c;
  }

  /*
   * 돌 스프라이트: 반투명 유리 질감
   *  - body : 접지 그림자 + 반투명 본체 + 내부 투과광 + 무지갯빛 + 프레넬 림 + 하이라이트
   *  - glow : 판 위로 번지는 빛 (가산 합성)
   *  - l1/l2: 돌 안에서 천천히 움직이는 빛 (오팔/흑요석의 반짝임)
   */
  function makeStone(color) {
    const B = color === 'b', r = RAD;

    /* ── body ── */
    const body = makeCanvas(r * 2.7), SZ = body.width, c = SZ / 2, g = body.getContext('2d');

    // 접지 그림자 (돌 아래로 살짝 오른쪽-아래)
    let gr = g.createRadialGradient(c + r * 0.1, c + r * 0.18, r * 0.55, c + r * 0.1, c + r * 0.18, r * 1.25);
    gr.addColorStop(0, B ? 'rgba(0,0,6,0.55)' : 'rgba(0,0,12,0.42)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, SZ, SZ);
    // 돌 영역에서는 그림자를 지워서 반투명 본체 아래로 격자가 비치게
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill();
    g.globalCompositeOperation = 'source-over';

    g.save();
    g.beginPath(); g.arc(c, c, r, 0, TAU); g.clip();

    // 본체
    gr = g.createRadialGradient(c - r * 0.38, c - r * 0.42, r * 0.04, c, c, r * 1.02);
    if (B) {
      gr.addColorStop(0, 'rgba(104,98,150,0.86)');
      gr.addColorStop(0.32, 'rgba(42,39,72,0.78)');
      gr.addColorStop(0.72, 'rgba(13,12,30,0.84)');
      gr.addColorStop(1, 'rgba(4,4,12,0.94)');
    } else {
      gr.addColorStop(0, 'rgba(255,255,255,0.93)');
      gr.addColorStop(0.4, 'rgba(241,245,252,0.80)');
      gr.addColorStop(0.78, 'rgba(206,218,238,0.72)');
      gr.addColorStop(1, 'rgba(158,175,206,0.86)');
    }
    g.fillStyle = gr; g.fillRect(0, 0, SZ, SZ);

    // 내부 투과광 — 빛이 유리를 지나 반대편(오른쪽 아래)에서 모이는 느낌
    gr = g.createRadialGradient(c + r * 0.3, c + r * 0.36, 0, c + r * 0.3, c + r * 0.36, r * 0.92);
    if (B) {
      g.globalCompositeOperation = 'lighter';
      gr.addColorStop(0, 'rgba(128,100,255,0.58)');
      gr.addColorStop(0.45, 'rgba(82,62,205,0.22)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      gr.addColorStop(0, 'rgba(170,218,255,0.55)');
      gr.addColorStop(0.5, 'rgba(200,215,255,0.18)');
      gr.addColorStop(1, 'rgba(200,215,255,0)');
    }
    g.fillStyle = gr; g.fillRect(0, 0, SZ, SZ);
    if (!B) {
      gr = g.createRadialGradient(c - r * 0.12, c + r * 0.52, 0, c - r * 0.12, c + r * 0.52, r * 0.62);
      gr.addColorStop(0, 'rgba(255,186,226,0.34)'); gr.addColorStop(1, 'rgba(255,186,226,0)');
      g.fillStyle = gr; g.fillRect(0, 0, SZ, SZ);
    }

    // 무지갯빛 (오팔/흑요석 광택)
    if (g.createConicGradient) {
      const cg = g.createConicGradient(-0.6, c, c);
      const stops = B
        ? ['rgba(140,110,255,0.10)', 'rgba(90,170,255,0.08)', 'rgba(200,120,255,0.07)', 'rgba(100,140,255,0.09)', 'rgba(140,110,255,0.10)']
        : ['rgba(255,196,228,0.12)', 'rgba(176,228,255,0.14)', 'rgba(222,204,255,0.11)', 'rgba(188,255,232,0.09)', 'rgba(255,196,228,0.12)'];
      stops.forEach((s, i) => cg.addColorStop(i / 4, s));
      g.globalCompositeOperation = B ? 'lighter' : 'source-over';
      g.fillStyle = cg; g.fillRect(0, 0, SZ, SZ);
    }
    g.globalCompositeOperation = B ? 'lighter' : 'source-over';

    // 프레넬 림 — 가장자리가 밝게
    gr = g.createRadialGradient(c, c, r * 0.78, c, c, r);
    if (B) {
      gr.addColorStop(0, 'rgba(150,140,255,0)');
      gr.addColorStop(0.7, 'rgba(150,140,255,0.08)');
      gr.addColorStop(0.94, 'rgba(178,168,255,0.40)');
      gr.addColorStop(1, 'rgba(222,216,255,0.55)');
    } else {
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.75, 'rgba(255,255,255,0)');
      gr.addColorStop(0.93, 'rgba(255,255,255,0.32)');
      gr.addColorStop(1, 'rgba(118,138,176,0.55)');
    }
    g.fillStyle = gr; g.fillRect(0, 0, SZ, SZ);

    // 오른쪽 아래 굴절 반사 (초승달)
    const lg = g.createLinearGradient(c - r * 0.7, c - r * 0.7, c + r * 0.7, c + r * 0.7);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.55, 'rgba(255,255,255,0)');
    lg.addColorStop(1, B ? 'rgba(196,182,255,0.85)' : 'rgba(255,255,255,0.95)');
    g.strokeStyle = lg; g.lineWidth = r * 0.085; g.lineCap = 'round';
    g.shadowColor = B ? 'rgba(170,150,255,0.9)' : 'rgba(200,230,255,0.9)'; g.shadowBlur = r * 0.18;
    g.beginPath(); g.arc(c, c, r * 0.885, -0.12 * Math.PI, 0.62 * Math.PI); g.stroke();
    g.shadowBlur = 0;
    g.restore();
    g.globalCompositeOperation = 'source-over';

    // ── spec: 표면 반사 (투과되어 보이는 격자보다 위에 그려야 해서 따로 분리) ──
    const spec = makeCanvas(r * 2.7), sg = spec.getContext('2d');
    // 스펙큘러 하이라이트 (왼쪽 위)
    sg.save();
    sg.translate(c - r * 0.36, c - r * 0.44); sg.rotate(-0.65); sg.scale(1, 0.58);
    gr = sg.createRadialGradient(0, 0, 0, 0, 0, r * 0.48);
    gr.addColorStop(0, B ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.5, B ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.22)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = gr; sg.beginPath(); sg.arc(0, 0, r * 0.48, 0, TAU); sg.fill();
    sg.restore();
    // 작고 날카로운 반짝임
    gr = sg.createRadialGradient(c - r * 0.42, c - r * 0.48, 0, c - r * 0.42, c - r * 0.48, r * 0.1);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = gr; sg.beginPath(); sg.arc(c - r * 0.42, c - r * 0.48, r * 0.1, 0, TAU); sg.fill();
    // 반대편의 작은 창문 반사
    gr = sg.createRadialGradient(c + r * 0.44, c + r * 0.5, 0, c + r * 0.44, c + r * 0.5, r * 0.08);
    gr.addColorStop(0, B ? 'rgba(220,210,255,0.55)' : 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = gr; sg.beginPath(); sg.arc(c + r * 0.44, c + r * 0.5, r * 0.08, 0, TAU); sg.fill();

    /* ── glow ── */
    const glow = makeCanvas(r * 4.8), GS = glow.width / 2, gg = glow.getContext('2d');
    gr = gg.createRadialGradient(GS, GS, r * 0.55, GS, GS, r * 2.4);
    if (B) {
      gr.addColorStop(0, 'rgba(126,104,255,0.50)');
      gr.addColorStop(0.3, 'rgba(110,90,240,0.20)');
      gr.addColorStop(0.65, 'rgba(90,70,220,0.06)');
    } else {
      gr.addColorStop(0, 'rgba(214,234,255,0.52)');
      gr.addColorStop(0.3, 'rgba(180,214,255,0.19)');
      gr.addColorStop(0.65, 'rgba(160,200,255,0.06)');
    }
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    gg.fillStyle = gr; gg.fillRect(0, 0, glow.width, glow.height);

    /* ── 움직이는 내부 빛 ── */
    const light = (rgb, a) => {
      const L = makeCanvas(r * 1.1), h = L.width / 2, lg2 = L.getContext('2d');
      const q = lg2.createRadialGradient(h, h, 0, h, h, h);
      q.addColorStop(0, `rgba(${rgb},${a})`); q.addColorStop(1, `rgba(${rgb},0)`);
      lg2.fillStyle = q; lg2.fillRect(0, 0, L.width, L.height);
      return L;
    };
    const l1 = B ? light('170,145,255', 0.55) : light('150,214,255', 0.5);
    const l2 = B ? light('110,185,255', 0.42) : light('255,172,218', 0.42);

    return { body, spec, glow, l1, l2, B };
  }

  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!S || !SPR || !gridLayer || $('#game').hidden) return;
    const t = now / 1000;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(gridLayer, 0, 0);

    const win = S.status === 'ended' && S.result && S.result.line ? new Set(S.result.line.map(([x, y]) => x + ',' + y)) : null;
    const winT = win ? Math.min(1, (now - endAt) / 700) : 0;

    // 돌마다 애니메이션 진행도 계산
    const items = S.moves.map(([x, y], i) => {
      const key = x + ',' + y;
      let p = 1;
      if (anims.has(key)) {
        p = Math.min(1, (now - anims.get(key)) / DROP_MS);
        if (p >= 1) anims.delete(key);
      }
      return { x, y, key, col: i % 2 === 0 ? 'b' : 'w', p, e: easeOut(p), win: win && win.has(key) };
    });

    // 1) 빛 번짐 (가산 합성)
    ctx.globalCompositeOperation = 'lighter';
    for (const it of items) {
      const sp = SPR[it.col];
      let a = (it.col === 'b' ? 0.72 : 0.6) + 0.16 * Math.sin(t * 1.3 + it.x * 0.7 + it.y * 1.1);
      let sc = 1;
      if (it.win) { a = 1; sc = 1 + 0.4 * winT + 0.07 * Math.sin(t * 4); }
      if (it.p < 1) { a = a * it.e + (1 - it.e) * 1.2; sc *= 1 + (1 - it.e) * 0.7; }
      ctx.globalAlpha = Math.min(1, a);
      const s = sp.glow.width * sc;
      ctx.drawImage(sp.glow, P(it.x) - s / 2, P(it.y) - s / 2, s, s);
    }

    // 2) 돌 본체
    ctx.globalCompositeOperation = 'source-over';
    for (const it of items) {
      const sp = SPR[it.col];
      const sc = 1 + 0.22 * (1 - it.e);
      ctx.globalAlpha = Math.min(1, it.p * 2.4);
      const s = sp.body.width * sc;
      ctx.drawImage(sp.body, P(it.x) - s / 2, P(it.y) - s / 2, s, s);
    }

    // 2-b) 굴절: 돌 너머의 격자가 살짝 확대·어긋나 비쳐 보이게 (유리 렌즈 효과)
    for (const it of items) {
      const cx = P(it.x), cy = P(it.y);
      const rr = RAD * 0.94 * (1 + 0.22 * (1 - it.e));
      const sr = rr / 1.35;                         // 1.35배 확대
      const ox = RAD * 0.13, oy = RAD * 0.13;       // 시선 각도에 따른 어긋남
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.clip();
      ctx.globalCompositeOperation = it.col === 'b' ? 'lighter' : 'source-over';
      ctx.globalAlpha = (it.col === 'b' ? 0.62 : 0.5) * it.p;
      ctx.drawImage(it.col === 'b' ? gridLayer : gridDark, cx + ox - sr, cy + oy - sr, sr * 2, sr * 2, cx - rr, cy - rr, rr * 2, rr * 2);
      ctx.restore();
    }

    // 3) 돌 속에서 천천히 도는 빛
    const th = t * 0.45;
    for (const col of ['b', 'w']) {
      const sp = SPR[col];
      ctx.globalCompositeOperation = col === 'b' ? 'lighter' : 'source-over';
      const h = sp.l1.width / 2;
      for (const it of items) {
        if (it.col !== col) continue;
        const ph = th + (it.x + it.y) * 0.12;
        ctx.globalAlpha = (col === 'b' ? 0.7 : 0.55) * it.p * (it.win ? 1.3 : 1);
        ctx.drawImage(sp.l1, P(it.x) + Math.cos(ph) * RAD * 0.24 - h, P(it.y) + Math.sin(ph) * RAD * 0.24 - h);
        ctx.drawImage(sp.l2, P(it.x) + Math.cos(-ph * 1.3 + 2) * RAD * 0.2 - h, P(it.y) + Math.sin(-ph * 1.3 + 2) * RAD * 0.2 - h);
      }
    }

    // 3-b) 표면 반사광 (맨 위)
    ctx.globalCompositeOperation = 'source-over';
    for (const it of items) {
      const sp = SPR[it.col];
      const s = sp.spec.width * (1 + 0.22 * (1 - it.e));
      ctx.globalAlpha = Math.min(1, it.p * 2.4);
      ctx.drawImage(sp.spec, P(it.x) - s / 2, P(it.y) - s / 2, s, s);
    }

    // 4) 착수 파문
    ctx.globalCompositeOperation = 'lighter';
    for (const it of items) {
      if (it.p >= 1) continue;
      ctx.globalAlpha = 0.6 * (1 - it.e);
      ctx.strokeStyle = it.col === 'b' ? 'rgb(160,140,255)' : 'rgb(205,232,255)';
      ctx.lineWidth = Math.max(DPR, RAD * 0.09 * (1 - it.e));
      ctx.beginPath(); ctx.arc(P(it.x), P(it.y), RAD * (1 + 1.9 * it.e), 0, TAU); ctx.stroke();
    }

    // 5) 승리 라인 빛줄기
    if (win && winT > 0) {
      const line = S.result.line;
      const [x0, y0] = line[0], [x1, y1] = line[line.length - 1];
      const ax = P(x0), ay = P(y0), bx = ax + (P(x1) - ax) * winT, by = ay + (P(y1) - ay) * winT;
      const rgb = S.result.winner === 'b' ? '175,155,255' : '225,240,255';
      const pulse = 0.8 + 0.2 * Math.sin(t * 3);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = `rgba(${rgb},${0.16 * pulse})`; ctx.lineWidth = RAD * 1.1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = `rgba(${rgb},${0.55 * pulse})`; ctx.lineWidth = RAD * 0.16;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }

    // 6) 마지막 수 표시
    ctx.globalCompositeOperation = 'source-over';
    if (items.length) {
      const last = items[items.length - 1];
      const a = 0.65 + 0.35 * Math.sin(t * 3.2);
      ctx.globalAlpha = a * last.p;
      ctx.fillStyle = last.col === 'b' ? 'rgb(150,226,255)' : 'rgb(118,92,255)';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = RAD * 0.6;
      ctx.beginPath(); ctx.arc(P(last.x), P(last.y), RAD * 0.13, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 7) 금수 표시 (쌍삼 금지 룰, 내 차례)
    if (forbidden.size && canPlay()) {
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = 'rgb(255,120,145)'; ctx.lineWidth = Math.max(1.5 * DPR, RAD * 0.07); ctx.lineCap = 'round';
      const k = RAD * 0.24;
      for (const key of forbidden) {
        const [x, y] = key.split(',').map(Number);
        ctx.beginPath();
        ctx.moveTo(P(x) - k, P(y) - k); ctx.lineTo(P(x) + k, P(y) + k);
        ctx.moveTo(P(x) + k, P(y) - k); ctx.lineTo(P(x) - k, P(y) + k);
        ctx.stroke();
      }
    }

    // 8) 미리보기 돌 (마우스 호버 / 터치 1차 선택)
    const ghost = pending || hover;
    if (ghost && canPlay() && board[ghost.y][ghost.x] === 0) {
      const sp = SPR[S.you];
      const s = sp.body.width;
      ctx.globalAlpha = pending ? 0.62 : 0.38;
      ctx.drawImage(sp.body, P(ghost.x) - s / 2, P(ghost.y) - s / 2);
      ctx.drawImage(sp.spec, P(ghost.x) - s / 2, P(ghost.y) - s / 2);
      if (pending) {
        ctx.globalAlpha = 0.5 + 0.4 * Math.sin(t * 6);
        ctx.strokeStyle = S.you === 'b' ? 'rgb(170,150,255)' : 'rgb(215,236,255)';
        ctx.lineWidth = Math.max(DPR, RAD * 0.06);
        ctx.setLineDash([RAD * 0.25, RAD * 0.18]);
        ctx.beginPath(); ctx.arc(P(ghost.x), P(ghost.y), RAD * 1.18, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    updateTimers(now);
  }
  requestAnimationFrame(frame);

  /* 제한시간 표시 */
  const bars = { b: $('#pb .ptimer i'), w: $('#pw .ptimer i') };
  function updateTimers(now) {
    const running = S.status === 'playing' && S.timer && deadlineAt != null;
    for (const c of ['b', 'w']) {
      const on = running && S.turn === c;
      bars[c].classList.toggle('run', on);
      if (!on) continue;
      const rem = Math.max(0, deadlineAt - now);
      bars[c].style.transform = `scaleX(${rem / (S.timer * 1000)})`;
      bars[c].classList.toggle('low', rem < 5000);
      const sec = Math.ceil(rem / 1000);
      if (sec !== lastSec) {
        lastSec = sec;
        const se = $('#status .sec');
        if (se) se.textContent = sec + '초';
        if (canPlay() && sec <= 5 && sec > 0) sfx('tick');
      }
    }
  }

  /* ═════════════════════ 입력 ═════════════════════ */
  function cellAt(e) {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * DPR, py = (e.clientY - rect.top) * DPR;
    const x = Math.round((px - PAD) / CELL), y = Math.round((py - PAD) / CELL);
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    if (Math.hypot(px - P(x), py - P(y)) > CELL * 0.62) return null;
    return { x, y };
  }
  const playable = (c) => c && canPlay() && board[c.y][c.x] === 0 && !forbidden.has(c.x + ',' + c.y);

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const c = cellAt(e);
    hover = playable(c) ? c : null;
    canvas.style.cursor = hover ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerleave', () => { hover = null; });
  canvas.addEventListener('pointerup', (e) => {
    const c = cellAt(e);
    if (!c || !canPlay() || board[c.y][c.x] !== 0) return;
    if (forbidden.has(c.x + ',' + c.y)) { toast('쌍삼 금지 자리입니다', true); sfx('deny'); return; }
    if (e.pointerType === 'mouse') return place(c);
    // 터치: 오터치 방지를 위해 같은 자리를 한 번 더 탭하면 착수
    if (pending && pending.x === c.x && pending.y === c.y) place(c);
    else { pending = c; $('#hint').hidden = false; sfx('tick'); }
  });
  function place(c) {
    pending = null; hover = null;
    $('#hint').hidden = true;
    send({ t: 'move', x: c.x, y: c.y });
  }
})();
