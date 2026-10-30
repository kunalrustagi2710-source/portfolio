/* Plot Twist — multiplayer party game.
   Architecture: the host's device runs the game engine (the host is a non-playing controller).
   Players send actions through Supabase RPCs; the host applies them and publishes the shared state.
   Private info (roles, evidence) is delivered per-player; Mystery answers are verified server-side. */
(function () {
'use strict';

const SB_URL = 'https://rvjtdurrqtjrrcsftsku.supabase.co';
const SB_KEY = 'sb_publishable_ORtZVHC-8ux1KTW43fXXeA_8ZXEO8-k';
const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const C = window.PT_CONTENT;
const MIN_PLAYERS = 5, MAX_PLAYERS = 10;
const ADV_COOLDOWN = 30000, MYS_MINUTES = 15, PARTY_ROUNDS = 5, PARTY_ANSWER_MS = 30000, PARTY_REVEAL_MS = 14000;
const COLORS = ['#ff5c7a', '#ffcc4d', '#3ce0b0', '#5cb8ff', '#9b7bff', '#ff9f5c', '#7cf0ff', '#f78bff', '#b6f36b', '#ffd6e0', '#c9b8ff', '#9df2c9'];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- utilities ----------
const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const rand = n => Math.floor(Math.random() * n);
const pick = a => a[rand(a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const genCode = n => Array.from({ length: n }, () => ALPHA[rand(ALPHA.length)]).join('');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw new Error(error.message || 'Request failed');
  return data;
}
const fmt = ms => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const initials = n => (String(n || '?').trim()[0] || '?').toUpperCase();
const avatar = p => `<span class="av" style="background:${p && p.color || '#888'}">${esc(initials(p && p.name))}</span>`;
const LOGO = `<a class="logo" href="#/"><i><svg viewBox="0 0 24 24"><path d="M5 17c2.5-7 8.5-2 11-9" stroke="#120d24" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="17" cy="7" r="2.4" fill="#ffcc4d"/></svg></i>Plot Twist</a>`;

let toastTimer;
function toast(text, tone) {
  const t = $('#toast'); t.textContent = text; t.className = 'toast show ' + (tone || '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  if (navigator.vibrate && tone) try { navigator.vibrate(tone === 'bad' ? [80, 60, 80] : 60); } catch (e) {}
}

// ---------- render with input preservation ----------
const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
const root = () => $('#app');
function paint(html) {
  const r = root(), active = document.activeElement;
  const keep = {};
  r.querySelectorAll('input[id]').forEach(i => { keep[i.id] = i.value; });
  const focusId = active && active.id && r.contains(active) ? active.id : null;
  const sel = focusId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  r.innerHTML = html;
  Object.keys(keep).forEach(id => { const el = document.getElementById(id); if (el && !el.hasAttribute('data-fresh')) el.value = keep[id]; });
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} } }
  tickClocks();
}
function qrSvg(text, cell) {
  try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: cell || 5, margin: 2, scalable: true }); }
  catch (e) { return ''; }
}

// ---------- clocks ----------
let clockOffset = 0; // player: hostNow - localNow
const nowSynced = () => Date.now() + clockOffset;
function tickClocks() {
  document.querySelectorAll('[data-until]').forEach(el => {
    const left = Number(el.getAttribute('data-until')) - nowSynced();
    el.textContent = fmt(left);
    el.classList.toggle('low', left < 60000);
  });
  document.querySelectorAll('[data-cool]').forEach(el => {
    const left = Number(el.getAttribute('data-cool')) - nowSynced();
    el.textContent = left > 0 ? 'Recharging ' + Math.ceil(left / 1000) + 's' : 'Ready to twist';
  });
}
setInterval(tickClocks, 500);

// ---------- routing ----------
let session = null; // {kind:'host'|'player', code, stop()}
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (session) { session.stop(); session = null; }
  closeScanner();
  const v = parts[0] || '';
  const code = (parts[1] || '').toUpperCase();
  if (v === 'host' && code) return startHost(code);
  if (v === 'play' && code) return startPlayer(code);
  if (v === 'how') return renderHow();
  renderHome();
}
window.addEventListener('hashchange', route);

// ---------- delegated events ----------
const handlers = {};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = handlers[el.getAttribute('data-act')];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return; e.preventDefault();
  const fn = handlers[f.getAttribute('data-form')];
  if (fn) fn(f, e);
});

// =====================================================================
// HOME + HOW TO PLAY
// =====================================================================
function modeCards(selected, actName) {
  return `<div class="modes">${Object.keys(C.modes).map(k => {
    const m = C.modes[k];
    return `<button class="mode ${m.cls} ${selected === k ? 'sel' : ''}" ${actName ? `data-act="${actName}" data-mode="${k}"` : 'data-act="go-how"'}>
      <span class="ic">${m.icon}</span><h3>${m.name}</h3><div class="tag">${esc(m.tag)}</div>
      <p class="small muted" style="margin-top:6px">${esc(m.blurb)}</p></button>`;
  }).join('')}</div>`;
}
function renderHome(err) {
  const last = store.get('pt_last_join') || {};
  const hosted = (store.get('pt_hosted') || []).slice(-1)[0];
  paint(`<div class="wrap stack-l">
    <div class="top">${LOGO}<a class="btn sm ghost" href="#/how">How to play</a></div>
    <div class="hero stack">
      <h1>Every party needs a <span class="twist">plot&nbsp;twist.</span></h1>
      <p class="muted">One host, 5–10 players, everyone on their own phone. Pick a mode and let the room play.</p>
    </div>
    <form class="card stack" data-form="join">
      <h3>Join a game</h3>
      <div><label class="lbl" for="j-code">Room code</label><input id="j-code" class="input code" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="ABC123" value="${esc(last.code || '')}"></div>
      <div><label class="lbl" for="j-name">Your name</label><input id="j-name" class="input" maxlength="20" autocomplete="nickname" placeholder="What should we call you?" value="${esc(last.name || '')}"></div>
      ${err ? `<p class="err">${esc(err)}</p>` : ''}
      <button class="btn primary block" type="submit">Join room</button>
    </form>
    <div class="card stack">
      <h3>Host a game</h3>
      <p class="small muted">Your screen becomes the controller — put it on a laptop or TV so the room can see it. Hosts don't play.</p>
      <button class="btn sun block" data-act="create">Create a room</button>
      ${hosted ? `<button class="btn ghost block" data-act="resume" data-code="${esc(hosted)}">Resume hosting ${esc(hosted)}</button>` : ''}
    </div>
    <div class="stack"><h2>Three ways to play</h2>${modeCards(null)}</div>
  </div>`);
}
handlers['go-how'] = () => { location.hash = '#/how'; };
handlers.join = f => {
  const code = $('#j-code', f).value.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const name = $('#j-name', f).value.trim();
  if (code.length !== 6) return renderHome('Room codes are 6 characters.');
  if (!name) return renderHome('Add your name so others know who you are.');
  store.set('pt_last_join', { code, name });
  store.set('pt_pending_name_' + code, name);
  location.hash = '#/play/' + code;
};
handlers.create = async el => {
  el.disabled = true; el.textContent = 'Creating…';
  try {
    const r = await rpc('pt_create_room');
    store.set('pt_host_' + r.code, r.host_key);
    const list = (store.get('pt_hosted') || []).filter(c => c !== r.code); list.push(r.code); store.set('pt_hosted', list.slice(-5));
    location.hash = '#/host/' + r.code;
  } catch (e) { el.disabled = false; el.textContent = 'Create a room'; toast('Could not create a room. Check your connection.', 'bad'); }
};
handlers.resume = el => { location.hash = '#/host/' + el.getAttribute('data-code'); };

function renderHow() {
  paint(`<div class="wrap stack-l how">
    <div class="top">${LOGO}<a class="btn sm ghost" href="#/">Home</a></div>
    <h1 style="font-size:44px">How to play</h1>
    <div class="card stack"><h3>Getting started</h3><ol>
      <li>The host taps <b>Create a room</b> and keeps that screen visible. The host runs the game but doesn't play.</li>
      <li>5–10 players open this site on their phones, enter the 6-character code (or scan the host's QR) and their name.</li>
      <li>Everyone taps <b>I'm ready</b>. The host picks a mode and starts. The host can stop the game at any time.</li></ol></div>
    <div class="card stack c-adv"><h3>🧭 Adventure</h3><p class="muted">Hidden roles, played on your feet.</p><ol>
      <li>Most players are <b>Explorers</b>. One or two are secretly <b>Twisters</b> (Twisters know each other).</li>
      <li>Everyone has a badge — a QR code and a 5-letter code — on their phone. Keep it on screen.</li>
      <li>Twisters scan an Explorer's badge to twist them. Each badge converts only once, and the new Twister joins the twisting. Twisters recharge for 30 seconds between scans.</li>
      <li>Every Explorer has <b>one</b> unmask: scan someone you suspect. Right guess removes that Twister. Wrong guess wastes it.</li>
      <li>Explorers win by unmasking every active Twister or by still outnumbering them when time runs out. Twisters win the moment they match the Explorers.</li></ol></div>
    <div class="card stack c-mys"><h3>🔍 Mystery</h3><p class="muted">A team case against the clock.</p><ol>
      <li>Everyone reads the case. Each player gets <b>different pieces of evidence</b> for three clues — nobody has the full picture.</li>
      <li>Read your evidence out loud and work out each clue's digit together. Anyone can submit an answer.</li>
      <li>Stuck? Use a hint — it costs one minute. Wrong final codes cost 30 seconds.</li>
      <li>Crack all three digits, then enter the <b>final code</b> before the timer runs out.</li></ol></div>
    <div class="card stack c-par"><h3>🎉 Party</h3><p class="muted">Five quick rounds of thinking like the room.</p><ol>
      <li>Each round shows a prompt: would-you-rather, pick-the-vibe, or who's-most-likely (vote for a player).</li>
      <li>Answer within 30 seconds. You earn one <span class="spark">Spark</span> for every other player who matched your answer.</li>
      <li>Round 5 is the <b>Plot Twist round</b> — every Spark counts double.</li>
      <li>After five rounds, the Sparks leaderboard and awards decide the night.</li></ol></div>
    <a class="btn primary block" href="#/">Let's play</a>
  </div>`);
}

// =====================================================================
// REALTIME
// =====================================================================
function openChannel(code, on) {
  const ch = sb.channel('pt-' + code, { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'state' }, () => on.state && on.state());
  ch.on('broadcast', { event: 'act' }, () => on.act && on.act());
  ch.subscribe();
  return ch;
}
function nudge(ch, event) { try { ch.send({ type: 'broadcast', event, payload: { t: Date.now() } }); } catch (e) {} }

// =====================================================================
// HOST ENGINE
// =====================================================================
const H = {}; // host session
function freshState() {
  return { phase: 'lobby', mode: 'party', players: {}, order: [], settings: { advMinutes: 8 }, game: null, hostNow: Date.now() };
}
async function startHost(code) {
  const key = store.get('pt_host_' + code);
  paint(`<div class="wrap"><div class="top">${LOGO}</div><div class="spin"></div></div>`);
  if (!key) {
    paint(`<div class="wrap stack-l"><div class="top">${LOGO}</div><div class="card stack"><h2>This device isn't the host of ${esc(code)}</h2>
      <p class="muted">Only the device that created the room can control it.</p>
      <a class="btn primary block" href="#/play/${esc(code)}">Join ${esc(code)} as a player</a><a class="btn ghost block" href="#/">Home</a></div></div>`);
    return;
  }
  let r;
  try { r = await rpc('pt_host_get', { p_code: code, p_key: key }); } catch (e) { r = null; }
  if (!r) {
    paint(`<div class="wrap stack-l"><div class="top">${LOGO}</div><div class="card stack"><h2>Room ${esc(code)} has expired</h2>
      <p class="muted">Rooms close after two days of inactivity.</p><button class="btn sun block" data-act="create">Create a new room</button></div></div>`);
    return;
  }
  Object.assign(H, {
    code, key, state: r.state && r.state.players ? r.state : freshState(), secret: r.secret || {},
    dirty: true, dirtyPriv: {}, busy: false, again: false, alive: true
  });
  H.lastId = H.secret.lastId || 0;
  H.priv = H.secret.privates || {};
  H.ch = openChannel(code, { act: () => hostCycle() });
  const iv1 = setInterval(hostCycle, 1200);
  session = { kind: 'host', code, stop() { H.alive = false; clearInterval(iv1); try { sb.removeChannel(H.ch); } catch (e) {} } };
  renderHost();
  hostCycle();
}
const S = () => H.state;
const activeIds = () => S().order.filter(id => S().players[id] && !S().players[id].spectator);
const humanIds = () => activeIds().filter(id => !S().players[id].bot);
const nameOf = id => (S().players[id] || {}).name || 'Someone';
function setPriv(pid, patch) {
  H.priv[pid] = Object.assign({}, H.priv[pid] || {}, patch);
  H.dirtyPriv[pid] = true; H.dirty = true;
}
function notify(pid, text, tone) {
  const q = ((H.priv[pid] || {}).notices || []).concat([{ id: uuid(), text, tone: tone || '', t: Date.now() }]).slice(-4);
  setPriv(pid, { notices: q });
}
function markDirty() { H.dirty = true; }

async function hostCycle() {
  if (!H.alive) return;
  if (H.busy) { H.again = true; return; }
  H.busy = true;
  try {
    let acts = [];
    try { acts = await rpc('pt_host_actions', { p_code: H.code, p_key: H.key, p_after: H.lastId }); } catch (e) { acts = []; }
    for (const a of acts || []) {
      H.lastId = a.id;
      try { await applyAction(a.pid, a.type, a.payload || {}); } catch (e) { console.error(e); }
    }
    if (acts && acts.length) H.dirty = true;
    try { await modeTick(); } catch (e) { console.error(e); }
    try { await botTick(); } catch (e) { console.error(e); }
    if (H.dirty) await hostPush();
  } finally {
    H.busy = false;
    if (H.again && H.alive) { H.again = false; setTimeout(hostCycle, 30); }
  }
}
async function hostPush() {
  const st = S(); st.hostNow = Date.now();
  H.secret.lastId = H.lastId; H.secret.privates = H.priv;
  const privOut = {};
  Object.keys(H.dirtyPriv).forEach(id => { if (!S().players[id] || !S().players[id].bot) privOut[id] = H.priv[id]; });
  const hadPriv = Object.keys(privOut).length > 0;
  H.dirty = false; H.dirtyPriv = {};
  try {
    await rpc('pt_host_set', { p_code: H.code, p_key: H.key, p_state: st, p_secret: H.secret, p_private: hadPriv ? privOut : null });
    nudge(H.ch, 'state');
  } catch (e) {
    H.dirty = true; Object.keys(privOut).forEach(id => { H.dirtyPriv[id] = true; });
  }
  renderHost();
}

const hostAct = (fn) => async (el, e) => { fn(el, e); markDirty(); renderHost(); hostCycle(); };

async function applyAction(pid, type, p) {
  const st = S();
  if (type === 'join') {
    const name = String(p.name || '').trim().slice(0, 20) || 'Player';
    if (st.players[pid]) { st.players[pid].name = name; st.players[pid].gone = false; return; }
    const full = activeIds().length >= MAX_PLAYERS;
    const spectator = st.phase !== 'lobby' || full;
    st.players[pid] = { name, color: COLORS[st.order.length % COLORS.length], ready: false, spectator, bot: false };
    st.order.push(pid);
    if (spectator) notify(pid, full ? 'The room is full — you\'re watching this one.' : 'A game is running — you\'ll join the next one.', '');
    return;
  }
  const pl = st.players[pid];
  if (!pl) return;
  if (type === 'ready') { if (st.phase === 'lobby') pl.ready = !!p.ready; return; }
  if (type === 'leave') {
    if (st.phase === 'lobby') { delete st.players[pid]; st.order = st.order.filter(x => x !== pid); }
    else pl.gone = true;
    return;
  }
  if (st.phase !== 'playing' || !st.game || pl.spectator) return;
  if (st.game.type === 'adventure') return advAction(pid, type, p);
  if (st.game.type === 'mystery') return mysAction(pid, type, p);
  if (st.game.type === 'party') return parAction(pid, type, p);
}

// ---- host controls ----
handlers['h-mode'] = hostAct(el => { if (S().phase === 'lobby') S().mode = el.getAttribute('data-mode'); });
handlers['h-mins'] = hostAct(el => { S().settings.advMinutes = Number(el.getAttribute('data-v')); });
handlers['h-kick'] = hostAct(el => {
  const id = el.getAttribute('data-id'); const st = S();
  if (st.phase === 'lobby') { delete st.players[id]; st.order = st.order.filter(x => x !== id); }
  else if (st.players[id]) st.players[id].spectator = true;
});
const BOT_NAMES = ['Bot Arjun', 'Bot Meera', 'Bot Kabir', 'Bot Zoya', 'Bot Rohan', 'Bot Tara', 'Bot Ishaan', 'Bot Anaya', 'Bot Vihaan', 'Bot Sana'];
handlers['h-bot'] = hostAct(() => {
  const st = S(); if (st.phase !== 'lobby' || activeIds().length >= MAX_PLAYERS) return;
  const used = new Set(st.order.map(id => st.players[id] && st.players[id].name));
  const name = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + genCode(3));
  const id = uuid();
  st.players[id] = { name, color: COLORS[st.order.length % COLORS.length], ready: true, spectator: false, bot: true };
  st.order.push(id);
});
handlers['h-clearbots'] = hostAct(() => {
  const st = S(); if (st.phase !== 'lobby') return;
  st.order = st.order.filter(id => { if (st.players[id] && st.players[id].bot) { delete st.players[id]; return false; } return true; });
});
handlers['h-start'] = async el => {
  el.disabled = true;
  try { await startGame(S().mode); } catch (e) { console.error(e); toast('Could not start: ' + e.message, 'bad'); }
  markDirty(); renderHost(); hostCycle();
};
handlers['h-stop'] = hostAct(() => {
  if (!confirm('Stop the game and return everyone to the lobby?')) return;
  toLobby();
});
handlers['h-lobby'] = hostAct(() => toLobby());
handlers['h-again'] = async () => { try { await startGame(S().game ? S().game.type : S().mode); } catch (e) { toast('Could not start: ' + e.message, 'bad'); } markDirty(); renderHost(); hostCycle(); };
handlers['h-next'] = hostAct(() => { if (S().game && S().game.type === 'party') parNext(); });
handlers['h-reveal'] = hostAct(() => { if (S().game && S().game.type === 'party' && S().game.stage === 'answer') parReveal(); });
handlers['h-end-adv'] = hostAct(() => { if (S().game && S().game.type === 'adventure' && !S().game.over) advTimeUp(true); });

function toLobby() {
  const st = S();
  st.phase = 'lobby'; st.game = null;
  st.order = st.order.filter(id => st.players[id] && !st.players[id].gone);
  st.order.forEach(id => { const p = st.players[id]; p.spectator = false; p.ready = !!p.bot; });
  // enforce max: extras stay spectators
  st.order.forEach((id, i) => { if (i >= MAX_PLAYERS) st.players[id].spectator = true; });
  H.secret.adv = null; H.secret.mys = null; H.secret.party = null;
  st.order.forEach(id => setPriv(id, { mode: null, role: null, fragments: null, badge: null }));
}

function canStart() {
  const ids = activeIds();
  if (ids.length < MIN_PLAYERS) return { ok: false, why: `Need at least ${MIN_PLAYERS} players (${ids.length} joined). Add bots to test.` };
  if (ids.length > MAX_PLAYERS) return { ok: false, why: `Max ${MAX_PLAYERS} players.` };
  const notReady = ids.filter(id => !S().players[id].ready);
  if (notReady.length) return { ok: false, why: `Waiting for ${notReady.length} player${notReady.length > 1 ? 's' : ''} to tap Ready.` };
  return { ok: true, why: 'Everyone is ready.' };
}
async function startGame(mode) {
  const st = S();
  st.order.forEach(id => { const p = st.players[id]; if (p && p.gone) { p.spectator = true; } });
  st.mode = mode;
  if (mode === 'adventure') advStart();
  else if (mode === 'mystery') await mysStart();
  else parStart();
  st.phase = 'playing';
}
async function modeTick() {
  const g = S().game; if (!g || S().phase !== 'playing') return;
  if (g.type === 'adventure') advTick();
  else if (g.type === 'mystery') mysTick();
  else if (g.type === 'party') parTick();
}
async function botTick() {
  const g = S().game; if (!g || S().phase !== 'playing') return;
  const bots = activeIds().filter(id => S().players[id].bot);
  if (!bots.length) return;
  H.botNext = H.botNext || {};
  const now = Date.now();
  for (const id of bots) {
    if (g.type === 'party' && g.stage === 'answer' && !(id in H.secret.party.answers)) {
      if (!H.botNext[id + g.round]) H.botNext[id + g.round] = now + 2000 + rand(6000);
      if (now >= H.botNext[id + g.round]) parAction(id, 'answer', { round: g.round, opt: rand(g.prompt.options.length) });
    }
    if (g.type === 'adventure' && !g.over) {
      const A = H.secret.adv; if (!A) continue;
      if (!H.botNext[id]) H.botNext[id] = now + 20000 + rand(30000);
      if (now < H.botNext[id]) continue;
      H.botNext[id] = now + 25000 + rand(35000);
      if (A.roles[id] === 'twister' && !A.caught[id]) {
        const targets = activeIds().filter(x => A.roles[x] === 'explorer');
        if (targets.length) advAction(id, 'scan', { code: A.badges[pick(targets)] });
      } else if (A.roles[id] === 'explorer' && !A.accuseUsed[id] && Math.random() < 0.25) {
        const others = activeIds().filter(x => x !== id);
        advAction(id, 'accuse', { code: A.badges[pick(others)] });
      }
    }
  }
}

// ---------------- ADVENTURE ----------------
function advStart() {
  const st = S(); const ids = shuffle(activeIds());
  const tc = ids.length <= 6 ? 1 : 2;
  const roles = {}, badges = {}, used = new Set();
  ids.forEach((id, i) => {
    roles[id] = i < tc ? 'twister' : 'explorer';
    let b; do { b = genCode(5); } while (used.has(b)); used.add(b); badges[id] = b;
  });
  H.secret.adv = { roles, badges, caught: {}, accuseUsed: {}, lastScan: {}, orig: ids.slice(0, tc) };
  const dur = (st.settings.advMinutes || 8) * 60000;
  const now = Date.now();
  st.game = { type: 'adventure', startedAt: now, endsAt: now + dur, feed: [{ t: now, text: `🧭 The adventure begins. ${tc} Twister${tc > 1 ? 's are' : ' is'} hiding among you.` }], counts: {}, over: false, winner: null, reason: '', reveal: null };
  ids.forEach(id => setPriv(id, { mode: 'adventure', badge: badges[id], fragments: null }));
  advSyncPriv(); advCounts();
}
function advCounts() {
  const A = H.secret.adv, g = S().game, ids = activeIds();
  const explorers = ids.filter(id => A.roles[id] === 'explorer').length;
  const twisters = ids.filter(id => A.roles[id] === 'twister' && !A.caught[id]).length;
  const caught = ids.filter(id => A.caught[id]).length;
  g.counts = { explorers, twisters, caught, total: ids.length };
  return g.counts;
}
function advSyncPriv() {
  const A = H.secret.adv; const ids = activeIds();
  const tw = ids.filter(id => A.roles[id] === 'twister' && !A.caught[id]);
  ids.forEach(id => {
    const role = A.roles[id];
    const cur = H.priv[id] || {};
    const next = {
      role, caught: !!A.caught[id], accuseUsed: !!A.accuseUsed[id],
      coolUntil: (A.lastScan[id] || 0) + ADV_COOLDOWN,
      allies: role === 'twister' ? tw.filter(x => x !== id).map(nameOf) : []
    };
    if (JSON.stringify([cur.role, cur.caught, cur.accuseUsed, cur.coolUntil, cur.allies]) !==
        JSON.stringify([next.role, next.caught, next.accuseUsed, next.coolUntil, next.allies])) setPriv(id, next);
  });
}
function advFeed(text) { const g = S().game; g.feed.unshift({ t: Date.now(), text }); g.feed = g.feed.slice(0, 30); }
function badgeOwner(code) {
  const A = H.secret.adv; const c = String(code || '').toUpperCase().replace(/^PT[:\-]?/, '').replace(/[^A-Z0-9]/g, '');
  return Object.keys(A.badges).find(id => A.badges[id] === c && activeIds().includes(id)) || null;
}
function advAction(pid, type, p) {
  const g = S().game, A = H.secret.adv; if (!A || g.over) return;
  const now = Date.now();
  if (type === 'scan') {
    if (A.roles[pid] !== 'twister') return notify(pid, 'Only Twisters can twist. Use your unmask instead.', 'bad');
    if (A.caught[pid]) return notify(pid, 'You were unmasked — your twisting days are over.', 'bad');
    if (now < (A.lastScan[pid] || 0) + ADV_COOLDOWN) return notify(pid, 'Still recharging. Wait a few seconds.', 'bad');
    const t = badgeOwner(p.code);
    if (!t) return notify(pid, 'That badge code doesn\'t match anyone.', 'bad');
    if (t === pid) return notify(pid, 'That\'s your own badge.', 'bad');
    if (A.roles[t] === 'twister') return notify(pid, nameOf(t) + ' is already a Twister.', '');
    A.roles[t] = 'twister'; A.lastScan[pid] = now;
    notify(pid, 'You twisted ' + nameOf(t) + '! Recharging for 30s.', 'good');
    notify(t, 'Plot twist! You\'ve been twisted. You are now a TWISTER.', 'bad');
    advFeed('⚡ Someone just got twisted!');
  } else if (type === 'accuse') {
    if (A.roles[pid] !== 'explorer') return notify(pid, 'Only Explorers can unmask.', 'bad');
    if (A.accuseUsed[pid]) return notify(pid, 'You already used your unmask.', 'bad');
    const t = badgeOwner(p.code);
    if (!t) return notify(pid, 'That badge code doesn\'t match anyone.', 'bad');
    if (t === pid) return notify(pid, 'You can\'t unmask yourself.', 'bad');
    if (A.caught[t]) return notify(pid, nameOf(t) + ' was already unmasked. Pick someone else.', '');
    A.accuseUsed[pid] = true;
    if (A.roles[t] === 'twister') {
      A.caught[t] = true;
      notify(pid, 'Got them! ' + nameOf(t) + ' was a Twister.', 'good');
      notify(t, nameOf(pid) + ' unmasked you. You\'re out of the twisting.', 'bad');
      advFeed('🔦 ' + nameOf(t) + ' was unmasked as a Twister!');
    } else {
      notify(pid, nameOf(t) + ' is an Explorer. Your unmask is used up.', 'bad');
      advFeed('💨 A false accusation — an unmask was wasted.');
    }
  } else return;
  advCounts(); advSyncPriv(); advCheckWin(); markDirty();
}
function advCheckWin() {
  const c = advCounts();
  if (c.twisters === 0) return advEnd('explorers', 'Every active Twister was unmasked.');
  if (c.twisters >= c.explorers) return advEnd('twisters', 'The Twisters matched the Explorers and took over the room.');
}
function advTimeUp(byHost) {
  const c = advCounts(), why = byHost ? 'The host called time' : 'Time ran out';
  if (c.explorers > c.twisters) advEnd('explorers', why + ' with the Explorers still in the majority.');
  else advEnd('twisters', why + ' and the Twisters held the room.');
}
function advEnd(winner, reason) {
  const g = S().game, A = H.secret.adv; if (g.over) return;
  g.over = true; g.winner = winner; g.reason = reason; g.endedAt = Date.now();
  g.reveal = activeIds().map(id => ({ id, role: A.roles[id], orig: A.orig.includes(id), caught: !!A.caught[id] }));
  advFeed(winner === 'explorers' ? '🏆 Explorers win!' : '🌀 Twisters win!');
  S().phase = 'results'; markDirty();
}
function advTick() { const g = S().game; if (!g.over && Date.now() >= g.endsAt) advTimeUp(); }

// ---------------- MYSTERY ----------------
async function mysStart() {
  const st = S();
  const m = await rpc('pt_mystery_start', { p_code: H.code, p_key: H.key });
  const humans = humanIds(); const holders = humans.length ? shuffle(humans) : shuffle(activeIds());
  // fragment k of clue c goes to holder (off + c + k): every clue is spread across different people
  const out = {}; holders.forEach(id => { out[id] = []; });
  const off = rand(holders.length), n = holders.length;
  m.clues.forEach((c, ci) => c.fragments.forEach((text, k) => out[holders[(off + ci + k) % n]].push({ clue: ci, text })));
  activeIds().forEach(id => setPriv(id, { mode: 'mystery', fragments: (out[id] || []).sort((a, b) => a.clue - b.clue), role: null, badge: null }));
  H.secret.mys = { caseId: m.case_id };
  const now = Date.now();
  st.game = {
    type: 'mystery', caseId: m.case_id, title: m.title, intro: m.intro, startedAt: now, endsAt: now + MYS_MINUTES * 60000,
    clues: m.clues.map(() => ({ solved: false, digit: null, by: null, hint: null, wrong: 0 })),
    hintsUsed: 0, wrongTotal: 0, finalWrong: 0, log: [{ t: now, text: '🔍 Case opened: ' + m.title }], over: false, winner: null,
    holders: holders.length
  };
}
function mysLog(text) { const g = S().game; g.log.unshift({ t: Date.now(), text }); g.log = g.log.slice(0, 40); }
async function mysAction(pid, type, p) {
  const g = S().game; if (g.over) return;
  const ci = Number(p.clue);
  if (type === 'answer') {
    if (!(ci >= 0 && ci < g.clues.length)) return;
    const cl = g.clues[ci]; if (cl.solved) return notify(pid, 'Clue ' + (ci + 1) + ' is already cracked.', '');
    const val = String(p.value || '').trim().slice(0, 20); if (!val) return;
    const r = await rpc('pt_mystery_check', { p_code: H.code, p_key: H.key, p_case: g.caseId, p_clue: ci, p_answer: val });
    if (r && r.correct) {
      cl.solved = true; cl.digit = r.digit; cl.by = nameOf(pid);
      mysLog('✅ ' + nameOf(pid) + ' cracked Clue ' + (ci + 1) + '. Digit: ' + r.digit);
      notify(pid, 'Correct! Clue ' + (ci + 1) + ' cracked.', 'good');
      if (g.clues.every(c => c.solved)) mysLog('🔓 All three digits found. Enter the final code!');
    } else {
      cl.wrong++; g.wrongTotal++;
      mysLog('❌ ' + nameOf(pid) + ' tried "' + val + '" for Clue ' + (ci + 1));
      notify(pid, 'Not quite. Compare evidence with the room.', 'bad');
    }
    markDirty();
  } else if (type === 'hint') {
    if (!(ci >= 0 && ci < g.clues.length)) return;
    const cl = g.clues[ci]; if (cl.hint || cl.solved) return;
    cl.hint = await rpc('pt_mystery_hint', { p_code: H.code, p_key: H.key, p_case: g.caseId, p_clue: ci });
    g.hintsUsed++; g.endsAt -= 60000;
    mysLog('💡 ' + nameOf(pid) + ' used a hint on Clue ' + (ci + 1) + ' (−1:00)');
    markDirty();
  } else if (type === 'final') {
    if (!g.clues.every(c => c.solved)) return notify(pid, 'Crack all three clues first.', 'bad');
    const val = String(p.value || '').replace(/\D/g, '').slice(0, 6);
    const ok = await rpc('pt_mystery_final', { p_code: H.code, p_key: H.key, p_case: g.caseId, p_try: val });
    if (ok) {
      g.over = true; g.winner = 'team'; g.endedAt = Date.now(); g.timeLeft = g.endsAt - g.endedAt; g.finalCode = val; g.openedBy = nameOf(pid);
      mysLog('🏆 ' + nameOf(pid) + ' opened the lock with ' + val + '!');
      S().phase = 'results';
    } else {
      g.finalWrong++; g.endsAt -= 30000;
      mysLog('🔒 ' + nameOf(pid) + ' tried ' + (val || '—') + ' on the lock (−0:30). Check the order of the digits.');
      notify(pid, 'The lock didn\'t open.', 'bad');
    }
    markDirty();
  }
}
function mysTick() {
  const g = S().game;
  if (!g.over && Date.now() >= g.endsAt) {
    g.over = true; g.winner = null; g.endedAt = Date.now(); g.timeLeft = 0;
    mysLog('⏰ Time\'s up. The case went cold.'); S().phase = 'results'; markDirty();
  }
}

// ---------------- PARTY ----------------
function parBuildRounds() {
  const used = { wyr: new Set(), vibe: new Set(), likely: new Set() };
  const take = kind => {
    const bank = C.party[kind]; let i; let guard = 0;
    do { i = rand(bank.length); guard++; } while (used[kind].has(i) && guard < 50);
    used[kind].add(i); return { kind, i };
  };
  const kinds = ['wyr', 'likely', 'vibe', 'likely', pick(['wyr', 'vibe', 'likely'])];
  return kinds.map(take);
}
function parPrompt(r) {
  if (r.kind === 'likely') {
    const ids = activeIds();
    return { kind: 'likely', title: 'Who\'s most likely…', text: C.party.likely[r.i], options: ids.map(nameOf), optIds: ids };
  }
  const item = C.party[r.kind][r.i];
  return { kind: r.kind, title: r.kind === 'wyr' ? 'Would you rather' : 'Pick the vibe', text: r.kind === 'wyr' ? item[1].join('  or  ') : item[0], options: item[1].slice(), optIds: null, wyr: r.kind === 'wyr' };
}
function parStart() {
  const ids = activeIds(); const sparks = {}; ids.forEach(id => { sparks[id] = 0; });
  H.secret.party = { rounds: parBuildRounds(), answers: {} };
  S().game = { type: 'party', round: -1, total: PARTY_ROUNDS, stage: 'answer', prompt: null, mult: 1, endsAt: 0, answered: [], sparks, gains: {}, picks: null, tally: null, votes: {}, alone: {}, roundGains: [], over: false };
  ids.forEach(id => setPriv(id, { mode: 'party', fragments: null, role: null, badge: null }));
  parNext();
}
function parNext() {
  const g = S().game, P = H.secret.party;
  if (g.round >= 0 && g.stage === 'answer') parReveal();
  g.round++;
  if (g.round >= g.total) return parFinish();
  P.answers = {};
  g.prompt = parPrompt(P.rounds[g.round]);
  g.mult = g.round === g.total - 1 ? 2 : 1;
  g.stage = 'answer'; g.answered = []; g.picks = null; g.tally = null; g.gains = {};
  g.endsAt = Date.now() + PARTY_ANSWER_MS;
  markDirty();
}
function parAction(pid, type, p) {
  const g = S().game, P = H.secret.party;
  if (type !== 'answer' || g.stage !== 'answer' || Number(p.round) !== g.round) return;
  const opt = Number(p.opt); if (!(opt >= 0 && opt < g.prompt.options.length)) return;
  P.answers[pid] = opt;
  g.answered = Object.keys(P.answers);
  if (activeIds().every(id => id in P.answers)) parReveal();
  markDirty();
}
function parReveal() {
  const g = S().game, P = H.secret.party; if (g.stage !== 'answer') return;
  const tally = g.prompt.options.map(() => 0);
  Object.values(P.answers).forEach(o => { tally[o]++; });
  const gains = {};
  activeIds().forEach(id => {
    if (!(id in P.answers)) { gains[id] = 0; return; }
    const n = tally[P.answers[id]] - 1;
    gains[id] = n * g.mult;
    g.sparks[id] = (g.sparks[id] || 0) + gains[id];
    if (n === 0) g.alone[id] = (g.alone[id] || 0) + 1;
  });
  if (g.prompt.kind === 'likely') g.prompt.optIds.forEach((id, i) => { g.votes[id] = (g.votes[id] || 0) + tally[i]; });
  g.tally = tally; g.picks = Object.assign({}, P.answers); g.gains = gains; g.stage = 'reveal';
  g.roundGains.push(gains);
  g.endsAt = Date.now() + PARTY_REVEAL_MS;
  markDirty();
}
function parFinish() {
  const g = S().game; g.over = true; g.stage = 'done';
  const ids = activeIds();
  const top = (obj, dir) => { let best = null; ids.forEach(id => { const v = obj[id] || 0; if (best === null || (dir > 0 ? v > (obj[best] || 0) : v < (obj[best] || 0))) best = id; }); return best; };
  const last = g.roundGains[g.roundGains.length - 1] || {};
  g.awards = [
    { icon: '🔮', title: 'Mind Reader', note: 'Most Sparks overall', id: top(g.sparks, 1) },
    { icon: '🌟', title: 'Main Character', note: 'Most "most likely" votes', id: top(g.votes, 1) },
    { icon: '🃏', title: 'Wildcard', note: 'Most rounds with a one-of-a-kind answer', id: top(g.alone, 1) },
    { icon: '🌀', title: 'Plot Twister', note: 'Biggest haul in the 2× round', id: top(last, 1) }
  ].filter(a => a.id);
  S().phase = 'results'; markDirty();
}
function parTick() {
  const g = S().game; if (g.over) return;
  if (g.stage === 'answer' && Date.now() >= g.endsAt) parReveal();
  else if (g.stage === 'reveal' && Date.now() >= g.endsAt) parNext();
}

// ---------------- HOST VIEWS ----------------
function joinUrl(code) { return location.origin + location.pathname + '#/play/' + code; }
function playerRow(id, opts) {
  const p = S().players[id]; if (!p) return '';
  opts = opts || {};
  return `<div class="pl">${avatar(p)}<span class="nm">${esc(p.name)}</span>
    ${p.bot ? '<span class="pill">bot</span>' : ''}${p.spectator ? '<span class="pill">watching</span>' : ''}${p.gone ? '<span class="pill bad">left</span>' : ''}
    ${opts.ready ? (p.ready ? '<span class="pill on">ready</span>' : '<span class="pill warn">not ready</span>') : ''}
    ${opts.kick ? `<button class="btn sm ghost" data-act="h-kick" data-id="${id}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</div>`;
}
function renderHost() {
  if (!H.alive || !session || session.kind !== 'host') return;
  const st = S();
  const head = `<div class="top">${LOGO}<div class="row"><span class="pill">Host · ${esc(H.code)}</span>
    ${st.phase !== 'lobby' ? '<button class="btn sm ghost" data-act="h-stop">Stop game</button>' : ''}</div></div>`;
  let body = '';
  if (st.phase === 'lobby') body = hostLobby();
  else if (st.game && st.game.type === 'adventure') body = hostAdventure();
  else if (st.game && st.game.type === 'mystery') body = hostMystery();
  else if (st.game && st.game.type === 'party') body = hostParty();
  paint(`<div class="wrap wide">${head}${body}</div>`);
}
function hostLobby() {
  const st = S(), cs = canStart(), ids = activeIds();
  const spectators = st.order.filter(id => st.players[id] && st.players[id].spectator);
  const m = C.modes[st.mode];
  return `<div class="host-grid">
    <div class="stack-l">
      <div class="card row" style="gap:18px;align-items:center">
        <div style="flex:1;min-width:0" class="stack">
          <span class="dim small">Join at this site with code</span>
          <div class="roomcode">${esc(H.code)}</div>
          <p class="small muted" style="word-break:break-all">${esc(joinUrl(H.code))}</p>
        </div>
        <div class="qr" style="width:132px;flex:none" aria-label="QR code to join">${qrSvg(joinUrl(H.code), 4)}</div>
      </div>
      <div class="stack"><h2>Pick a mode</h2>${modeCards(st.mode, 'h-mode')}</div>
      ${st.mode === 'adventure' ? `<div class="card row wrapr between"><span class="small muted">Adventure length</span><div class="row">${[6, 8, 10].map(n => `<button class="btn sm ${st.settings.advMinutes === n ? 'mint' : 'ghost'}" data-act="h-mins" data-v="${n}">${n} min</button>`).join('')}</div></div>` : ''}
    </div>
    <div class="stack-l">
      <div class="card stack">
        <div class="row between"><h3>Players</h3><span class="pill ${ids.length >= MIN_PLAYERS ? 'on' : 'warn'}">${ids.length} / ${MAX_PLAYERS}</span></div>
        <div class="players">${ids.length ? ids.map(id => playerRow(id, { ready: true, kick: true })).join('') : '<p class="muted small">Waiting for players to join…</p>'}</div>
        ${spectators.length ? `<p class="tiny dim">Watching: ${spectators.map(id => esc(nameOf(id))).join(', ')}</p>` : ''}
        <div class="row wrapr">
          <button class="btn sm ghost" data-act="h-bot" ${ids.length >= MAX_PLAYERS ? 'disabled' : ''}>+ Add a test bot</button>
          ${ids.some(id => st.players[id].bot) ? '<button class="btn sm ghost" data-act="h-clearbots">Remove bots</button>' : ''}
        </div>
      </div>
      <div class="card stack">
        <p class="small ${cs.ok ? '' : 'muted'}">${esc(cs.why)}</p>
        <button class="btn ${m.btn} block" data-act="h-start" ${cs.ok ? '' : 'disabled'}>Start ${m.name}</button>
      </div>
    </div>
  </div>`;
}
function feedHtml(list) { return `<div class="feed">${(list || []).map(f => `<div>${esc(f.text)}</div>`).join('')}</div>`; }
function hostAdventure() {
  const st = S(), g = st.game, c = g.counts || {};
  const tot = Math.max(1, c.total || 1);
  if (st.phase === 'results') return advResults(null);
  return `<div class="host-grid">
    <div class="stack-l">
      <div class="card center stack"><span class="pill" style="color:var(--mint)">🧭 Adventure</span>
        <div class="timer big-timer" data-until="${g.endsAt}">--:--</div>
        <p class="muted small">Twisters scan badges to convert Explorers. Explorers have one unmask each.</p></div>
      <div class="card stack"><h3>The room right now</h3><div class="bars">
        <div class="bar"><div class="row between small"><b style="color:var(--mint)">Explorers</b><b>${c.explorers || 0}</b></div><div class="track"><div class="fill" style="width:${(c.explorers || 0) / tot * 100}%;background:var(--mint)"></div></div></div>
        <div class="bar"><div class="row between small"><b style="color:var(--coral)">Active Twisters</b><b>${c.twisters || 0}</b></div><div class="track"><div class="fill" style="width:${(c.twisters || 0) / tot * 100}%;background:var(--coral)"></div></div></div>
        <div class="bar"><div class="row between small"><b class="muted">Unmasked</b><b>${c.caught || 0}</b></div><div class="track"><div class="fill" style="width:${(c.caught || 0) / tot * 100}%;background:var(--dim)"></div></div></div>
      </div></div>
      <button class="btn ghost block" data-act="h-end-adv">End now and call the result</button>
    </div>
    <div class="stack-l"><div class="card stack"><h3>Live feed</h3>${feedHtml(g.feed)}</div>
      <div class="card stack"><h3>Players</h3><div class="players">${activeIds().map(id => playerRow(id)).join('')}</div></div></div>
  </div>`;
}
function advResults(me) {
  const g = S().game;
  const win = g.winner === 'explorers';
  const mine = me && g.reveal ? g.reveal.find(r => r.id === me) : null;
  const meWon = mine ? ((mine.role === 'explorer') === win) : null;
  return `<div class="stack-l pop">
    <div class="banner ${me ? (meWon ? 'win' : 'lose') : 'win'} stack">
      <span class="kicker tiny dim">ADVENTURE OVER</span>
      <h1 style="font-size:44px">${win ? 'Explorers win' : 'Twisters win'}</h1>
      <p class="muted">${esc(g.reason)}</p>
      ${mine ? `<p><b>${meWon ? 'Your side won!' : 'Your side lost this one.'}</b></p>` : ''}
    </div>
    <div class="card stack"><h3>Who was who</h3><div class="players">${(g.reveal || []).map(r => {
      const p = S().players[r.id] || {};
      return `<div class="pl">${avatar(p)}<span class="nm">${esc(p.name)}</span>
        <span class="pill ${r.role === 'twister' ? 'bad' : 'on'}">${r.role === 'twister' ? (r.orig ? 'Original Twister' : 'Twisted') : 'Explorer'}</span>
        ${r.caught ? '<span class="pill">unmasked</span>' : ''}</div>`;
    }).join('')}</div></div>
    <div class="card stack"><h3>How it went</h3>${feedHtml(g.feed)}</div>
    ${me ? '' : hostResultButtons()}
  </div>`;
}
function hostResultButtons() {
  return `<div class="grid2"><button class="btn sun block" data-act="h-again">Play again</button><button class="btn ghost block" data-act="h-lobby">Back to lobby</button></div>`;
}
function digitsHtml(g) {
  return `<div class="digits">${g.clues.map(c => `<span class="${c.solved ? 'on' : ''}">${c.solved ? esc(c.digit) : '?'}</span>`).join('')}</div>`;
}
function hostMystery() {
  const st = S(), g = st.game;
  if (st.phase === 'results') return mysResults(false);
  return `<div class="host-grid">
    <div class="stack-l">
      <div class="card stack"><span class="pill" style="color:var(--violet)">🔍 Mystery</span><h2>${esc(g.title)}</h2><p class="muted">${esc(g.intro)}</p></div>
      <div class="card center stack"><div class="timer big-timer" data-until="${g.endsAt}">--:--</div>${digitsHtml(g)}
        <p class="small muted">Hints used: ${g.hintsUsed} · Wrong guesses: ${g.wrongTotal + g.finalWrong}</p></div>
    </div>
    <div class="stack-l">
      ${g.clues.map((c, i) => `<div class="card clue ${c.solved ? 'solved' : ''} stack"><div class="row between"><h3>Clue ${i + 1}</h3>
        ${c.solved ? `<span class="pill on">Cracked by ${esc(c.by)}</span>` : '<span class="pill">Unsolved</span>'}</div>
        ${c.hint ? `<div class="hint">💡 ${esc(c.hint)}</div>` : ''}</div>`).join('')}
      <div class="card stack"><h3>Case log</h3>${feedHtml(g.log)}</div>
    </div></div>`;
}
function mysResults(isPlayer) {
  const g = S().game, win = g.winner === 'team';
  const tl = g.timeLeft || 0;
  const stars = win ? (1 + (g.hintsUsed === 0 ? 1 : 0) + (tl > 5 * 60000 ? 1 : 0)) : 0;
  return `<div class="stack-l pop">
    <div class="banner ${win ? 'win' : 'lose'} stack">
      <span class="tiny dim">${esc(g.title).toUpperCase()}</span>
      <h1 style="font-size:44px">${win ? 'Case closed!' : 'The case went cold'}</h1>
      <p class="muted">${win ? `${esc(g.openedBy)} opened the lock with ${esc(g.finalCode)} with ${fmt(tl)} to spare.` : 'The timer ran out before the lock opened.'}</p>
      ${win ? `<p style="font-size:28px">${'★'.repeat(stars)}<span class="dim">${'★'.repeat(3 - stars)}</span></p><p class="tiny dim">One star for solving, one for no hints, one for 5+ minutes left.</p>` : ''}
    </div>
    ${digitsHtml(g)}
    <div class="card stack"><div class="row between"><h3>Case summary</h3><span class="small muted">Hints ${g.hintsUsed} · Wrong ${g.wrongTotal + g.finalWrong}</span></div>${feedHtml(g.log)}</div>
    ${isPlayer ? '' : hostResultButtons()}
  </div>`;
}
function tallyHtml(g, me) {
  const total = Math.max(1, (g.tally || []).reduce((a, b) => a + b, 0));
  const max = Math.max.apply(null, g.tally || [0]);
  return `<div class="bars">${g.prompt.options.map((o, i) => {
    const n = g.tally[i]; const who = Object.keys(g.picks || {}).filter(id => g.picks[id] === i);
    return `<div class="bar"><div class="row between small"><b ${me != null && g.picks && g.picks[me] === i ? 'style="color:var(--sun)"' : ''}>${esc(o)}${n === max && n > 0 ? ' 👑' : ''}</b><b>${n}</b></div>
      <div class="track"><div class="fill" style="width:${n / total * 100}%;background:${n === max ? 'var(--sun)' : 'var(--violet)'}"></div></div>
      ${who.length ? `<div class="chips">${who.map(id => `<span class="chip">${esc(nameOf(id))}</span>`).join('')}</div>` : ''}</div>`;
  }).join('')}</div>`;
}
function leaderboard(g, limit, me) {
  const ids = activeIds().slice().sort((a, b) => (g.sparks[b] || 0) - (g.sparks[a] || 0));
  return `<div class="lb">${ids.slice(0, limit || ids.length).map((id, i) => {
    const p = S().players[id] || {};
    const gain = g.gains && g.gains[id] ? `<span class="small spark">+${g.gains[id]}</span>` : '';
    return `<div class="pl" ${id === me ? 'style="border-color:var(--sun)"' : ''}><b class="dim" style="width:18px">${i + 1}</b>${avatar(p)}<span class="nm">${esc(p.name)}${id === me ? ' (you)' : ''}</span>${g.stage === 'reveal' ? gain : ''}<span class="sc">${g.sparks[id] || 0}</span></div>`;
  }).join('')}</div>`;
}
function hostParty() {
  const st = S(), g = st.game;
  if (st.phase === 'results') return parResults(null);
  const ids = activeIds();
  const roundLbl = `Round ${g.round + 1} of ${g.total}${g.mult > 1 ? ' · Plot Twist round · 2× Sparks' : ''}`;
  return `<div class="host-grid">
    <div class="stack-l">
      <div class="card stack"><div class="row between"><span class="pill" style="color:var(--coral)">🎉 ${esc(roundLbl)}</span>
        <span class="timer" data-until="${g.endsAt}">--:--</span></div>
        <span class="dim small">${esc(g.prompt.title)}</span><div class="prompt">${esc(g.prompt.text)}</div></div>
      ${g.stage === 'answer'
        ? `<div class="card stack"><div class="row between"><h3>Answers in</h3><b>${g.answered.length} / ${ids.length}</b></div>
            <div class="chips">${ids.map(id => `<span class="chip ${g.answered.includes(id) ? 'on' : ''}">${esc(nameOf(id))}</span>`).join('')}</div>
            <button class="btn ghost block" data-act="h-reveal">Reveal now</button></div>`
        : `<div class="card stack"><h3>The room said…</h3>${tallyHtml(g)}<button class="btn primary block" data-act="h-next">${g.round + 1 >= g.total ? 'Final results' : 'Next round'} <span class="small" data-until="${g.endsAt}"></span></button></div>`}
    </div>
    <div class="card stack"><h3>Sparks</h3>${leaderboard(g)}</div>
  </div>`;
}
function parResults(me) {
  const g = S().game;
  const ids = activeIds().slice().sort((a, b) => (g.sparks[b] || 0) - (g.sparks[a] || 0));
  const winner = ids[0];
  return `<div class="stack-l pop">
    <div class="banner win stack"><span class="tiny dim">PARTY OVER</span>
      <h1 style="font-size:44px">${esc(nameOf(winner))} wins</h1>
      <p class="muted">${g.sparks[winner] || 0} Sparks after five rounds.${me ? ` You finished #${ids.indexOf(me) + 1} with ${g.sparks[me] || 0}.` : ''}</p></div>
    <div class="card stack"><h3>Awards</h3>${(g.awards || []).map(a => `<div class="award"><span class="ai">${a.icon}</span><div><b>${esc(a.title)} — ${esc(nameOf(a.id))}</b><div class="small muted">${esc(a.note)}</div></div></div>`).join('')}</div>
    <div class="card stack"><h3>Final Sparks</h3>${leaderboard(Object.assign({}, g, { stage: 'done' }), null, me)}</div>
    ${me ? '' : hostResultButtons()}
  </div>`;
}

// =====================================================================
// PLAYER
// =====================================================================
const P = {};
async function startPlayer(code) {
  Object.assign(P, { code, v: -1, state: null, priv: {}, alive: true, seen: new Set(), primed: false, partyPick: null });
  let me = store.get('pt_player_' + code);
  const pending = store.get('pt_pending_name_' + code);
  if (!me && !pending) return renderPlayerJoin();
  if (!me) { me = { pid: uuid(), secret: uuid(), name: pending }; }
  else if (pending) me.name = pending;
  store.set('pt_pending_name_' + code, null);
  P.me = me;
  paint(`<div class="wrap"><div class="top">${LOGO}</div><div class="spin"></div><p class="center muted">Joining ${esc(code)}…</p></div>`);
  try {
    await rpc('pt_join', { p_code: code, p_pid: me.pid, p_secret: me.secret, p_name: me.name });
  } catch (e) {
    const msg = /no_room/.test(e.message) ? 'No room with code ' + code + '. Check the code with your host.' : /bad_secret/.test(e.message) ? 'This name slot is taken on another device.' : 'Could not join right now. Try again.';
    store.set('pt_player_' + code, null);
    return renderPlayerJoin(msg);
  }
  store.set('pt_player_' + code, me);
  store.set('pt_last_join', { code, name: me.name });
  P.ch = openChannel(code, { state: () => playerPull() });
  const iv = setInterval(playerPull, 2000);
  session = { kind: 'player', code, stop() { P.alive = false; clearInterval(iv); try { sb.removeChannel(P.ch); } catch (e) {} } };
  playerPull();
}
function renderPlayerJoin(err) {
  const last = store.get('pt_last_join') || {};
  paint(`<div class="wrap stack-l"><div class="top">${LOGO}</div>
    <form class="card stack" data-form="pjoin"><h2>Join room ${esc(P.code)}</h2>
    <div><label class="lbl" for="pj-name">Your name</label><input id="pj-name" class="input" maxlength="20" placeholder="What should we call you?" value="${esc(last.name || '')}"></div>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <button class="btn primary block" type="submit">Join</button></form>
    <a class="btn ghost block" href="#/">Use a different code</a></div>`);
}
handlers.pjoin = f => {
  const name = $('#pj-name', f).value.trim(); if (!name) return renderPlayerJoin('Add your name first.');
  store.set('pt_pending_name_' + P.code, name); route();
};
async function act(type, payload) {
  try { await rpc('pt_act', { p_code: P.code, p_pid: P.me.pid, p_secret: P.me.secret, p_type: type, p_payload: payload || {} }); nudge(P.ch, 'act'); return true; }
  catch (e) { toast(/slow_down/.test(e.message) ? 'Slow down a little!' : 'That didn\'t go through. Try again.', 'bad'); return false; }
}
let pulling = false;
async function playerPull() {
  if (!P.alive || pulling) return; pulling = true;
  try {
    const r = await rpc('pt_get_room', { p_code: P.code });
    if (!r) { paint(`<div class="wrap stack-l"><div class="top">${LOGO}</div><div class="card stack"><h2>This room has closed</h2><a class="btn primary block" href="#/">Home</a></div></div>`); return; }
    if (r.v !== P.v) {
      P.v = r.v; P.state = r.state;
      if (r.state && r.state.hostNow) clockOffset = r.state.hostNow - Date.now();
      try { P.priv = (await rpc('pt_private_get', { p_code: P.code, p_pid: P.me.pid, p_secret: P.me.secret })) || {}; } catch (e) {}
      const list = P.priv.notices || [];
      const fresh = list.filter(n => !P.seen.has(n.id) && (P.primed || Date.now() + clockOffset - (n.t || 0) < 8000));
      list.forEach(n => P.seen.add(n.id)); P.primed = true;
      if (fresh.length) { const last = fresh[fresh.length - 1]; toast(fresh.map(n => n.text).join('  ·  '), last.tone); }
      renderPlayer();
    }
  } catch (e) { /* transient */ } finally { pulling = false; }
}
function renderPlayer() {
  if (!P.alive) return;
  const st = P.state;
  const head = `<div class="top">${LOGO}<span class="pill">${esc(P.code)}</span></div>`;
  if (!st || !st.players) return paint(`<div class="wrap">${head}<div class="card stack center"><h2>Waiting for the host</h2><p class="muted">The host's screen needs to stay open. Hang tight.</p><div class="spin"></div></div></div>`);
  window.__ptState = st; // for shared view helpers
  const me = st.players[P.me.pid];
  if (!me) return paint(`<div class="wrap">${head}<div class="card stack center"><h2>Connecting…</h2><p class="muted">Making sure the host has you on the list.</p><div class="spin"></div>
    <button class="btn ghost block" data-act="p-rejoin">Rejoin</button></div></div>`);
  let body;
  if (st.phase === 'lobby') body = playerLobby(st, me);
  else if (me.spectator) body = playerWatching(st);
  else if (st.game.type === 'adventure') body = st.phase === 'results' ? withState(st, () => advResults(P.me.pid)) : playerAdventure(st);
  else if (st.game.type === 'mystery') body = st.phase === 'results' ? withState(st, () => mysResults(true)) : playerMystery(st);
  else body = st.phase === 'results' ? withState(st, () => parResults(P.me.pid)) : playerParty(st);
  paint(`<div class="wrap">${head}${body}</div>`);
}
// shared view helpers read S()/activeIds()/nameOf() — point them at the player's copy of state
function withState(st, fn) { const prev = H.state; H.state = st; try { return fn(); } finally { H.state = prev; } }
handlers['p-rejoin'] = () => route();
handlers['p-ready'] = async el => {
  const me = P.state.players[P.me.pid]; const want = !me.ready;
  me.ready = want; renderPlayer();
  await act('ready', { ready: want });
};
handlers['p-leave'] = async () => {
  if (!confirm('Leave this room?')) return;
  await act('leave', {}); store.set('pt_player_' + P.code, null); location.hash = '#/';
};
function playerLobby(st, me) {
  const ids = st.order.filter(id => st.players[id] && !st.players[id].spectator);
  const m = C.modes[st.mode];
  return `<div class="stack-l">
    <div class="card stack center"><span class="av" style="width:64px;height:64px;font-size:28px;margin:0 auto;background:${me.color}">${esc(initials(me.name))}</span>
      <h2>You're in, ${esc(me.name)}</h2>
      ${me.spectator ? '<p class="muted">The room is full — you\'ll watch this round.</p>' :
        `<button class="btn ${me.ready ? 'mint' : 'primary'} block" data-act="p-ready">${me.ready ? '✓ Ready — tap to undo' : 'I\'m ready'}</button>`}
    </div>
    <div class="card stack"><span class="dim small">Next up</span><div class="row"><span style="font-size:28px">${m.icon}</span><div><h3>${m.name}</h3><div class="small muted">${esc(m.tag)}</div></div></div><p class="small muted">${esc(m.blurb)}</p></div>
    <div class="card stack"><div class="row between"><h3>Players</h3><span class="pill">${ids.length} / ${MAX_PLAYERS}</span></div>
      <div class="players">${ids.map(id => { const p = st.players[id]; return `<div class="pl">${avatar(p)}<span class="nm">${esc(p.name)}${id === P.me.pid ? ' (you)' : ''}</span><span class="dot ${p.ready ? 'on' : ''}" title="${p.ready ? 'ready' : 'not ready'}"></span></div>`; }).join('')}</div>
      <p class="tiny dim center">The host starts when everyone is ready.</p></div>
    <a class="btn ghost block" href="#/how">How to play</a>
    <button class="btn ghost block" data-act="p-leave">Leave room</button>
  </div>`;
}
function playerWatching(st) {
  const g = st.game;
  return `<div class="stack-l"><div class="card stack center"><h2>You're watching</h2><p class="muted">A ${esc(C.modes[g.type].name)} game is in progress. You'll be in the next one.</p>
    ${g.endsAt ? `<div class="timer" data-until="${g.endsAt}">--:--</div>` : ''}</div></div>`;
}

// ---- player: adventure ----
function playerAdventure(st) {
  const g = st.game, pv = P.priv || {}, c = g.counts || {};
  const role = pv.role || 'explorer', caught = pv.caught;
  const cls = caught ? 'caught' : role;
  const roleCard = `<div class="rolecard ${cls} stack">
    <span class="kicker">You are ${role === 'twister' && !caught ? 'secretly' : ''}</span>
    <div class="rname">${caught ? 'UNMASKED' : role === 'twister' ? 'A TWISTER' : 'AN EXPLORER'}</div>
    <p class="small" style="opacity:.9">${caught ? 'You were caught. Cheer on the Twisters — quietly.' : role === 'twister'
      ? 'Scan Explorers\' badges to twist them. Act normal. Don\'t get unmasked.'
      : 'Stay sharp. Someone near you is a Twister. You get one unmask.'}</p>
    ${role === 'twister' && !caught && pv.allies && pv.allies.length ? `<p class="small"><b>Fellow Twisters:</b> ${pv.allies.map(esc).join(', ')}</p>` : ''}
  </div>`;
  let actions = '';
  if (!caught && role === 'twister') {
    actions = `<div class="card stack"><div class="row between"><h3>Twist someone</h3><span class="pill" data-cool="${pv.coolUntil || 0}"></span></div>
      <button class="btn primary block" data-act="p-scan" data-kind="scan">📷 Scan a badge</button>
      <form class="row" data-form="p-manual" data-kind="scan"><input id="adv-code" class="input code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" aria-label="Badge code"><button class="btn sm primary" type="submit" style="min-height:52px">Twist</button></form></div>`;
  } else if (!caught) {
    actions = pv.accuseUsed ? `<div class="card"><p class="muted small">You've used your unmask. Keep your badge hidden from Twisters!</p></div>`
      : `<div class="card stack"><div class="row between"><h3>Unmask a Twister</h3><span class="pill warn">1 use</span></div>
      <p class="small muted">Only when you're sure. A wrong guess wastes it.</p>
      <button class="btn mint block" data-act="p-scan" data-kind="accuse">🔦 Scan a suspect's badge</button>
      <form class="row" data-form="p-manual" data-kind="accuse"><input id="adv-code" class="input code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" aria-label="Suspect badge code"><button class="btn sm mint" type="submit" style="min-height:52px">Unmask</button></form></div>`;
  }
  return `<div class="stack-l">
    <div class="row between"><span class="pill" style="color:var(--mint)">🧭 Adventure</span><span class="timer" data-until="${g.endsAt}">--:--</span></div>
    ${roleCard}
    <div class="card badge"><div class="qr">${qrSvg('PT:' + (pv.badge || ''), 4)}</div>
      <div class="stack"><span class="dim small">Your badge</span><div class="bc">${esc(pv.badge || '-----')}</div><p class="tiny muted">Keep this on screen. Twisters will try to scan it.</p></div></div>
    ${actions}
    <div class="card stack"><div class="row between small"><b style="color:var(--mint)">Explorers ${c.explorers || 0}</b><b style="color:var(--coral)">Twisters ${c.twisters || 0}</b><b class="muted">Unmasked ${c.caught || 0}</b></div>${feedHtml((g.feed || []).slice(0, 6))}</div>
  </div>`;
}
handlers['p-scan'] = el => { const kind = el.getAttribute('data-kind'); openScanner(code => act(kind, { code })); };
handlers['p-manual'] = async f => {
  const inp = $('#adv-code', f); const code = inp.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (code.length !== 5) return toast('Badge codes are 5 characters.', 'bad');
  setVal('adv-code', '');
  if (!(await act(f.getAttribute('data-kind'), { code }))) setVal('adv-code', code);
};

// ---- player: mystery ----
function playerMystery(st) {
  const g = st.game, pv = P.priv || {};
  const frs = pv.fragments || [];
  const allSolved = g.clues.every(c => c.solved);
  return `<div class="stack-l">
    <div class="row between"><span class="pill" style="color:var(--violet)">🔍 Mystery</span><span class="timer" data-until="${g.endsAt}">--:--</span></div>
    <div class="card stack"><h2>${esc(g.title)}</h2><p class="small muted">${esc(g.intro)}</p></div>
    <div class="card stack"><div class="row between"><h3>Your evidence</h3><span class="pill">${frs.length} piece${frs.length === 1 ? '' : 's'}</span></div>
      <p class="tiny dim">Only you can see these. Read them out loud to the room.</p>
      ${frs.length ? frs.map(f => `<div class="frag"><b>Clue ${f.clue + 1}</b>${esc(f.text)}</div>`).join('') : '<p class="small muted">You hold no evidence this time — listen closely and help solve.</p>'}
    </div>
    ${digitsHtml(g)}
    ${g.clues.map((c, i) => `<div class="card clue ${c.solved ? 'solved' : ''} stack">
      <div class="row between"><h3>Clue ${i + 1}</h3>${c.solved ? `<span class="digit">${esc(c.digit)}</span>` : (c.wrong ? `<span class="pill bad">${c.wrong} wrong</span>` : '')}</div>
      ${c.solved ? `<p class="small muted">Cracked by ${esc(c.by)}</p>` : `
        ${c.hint ? `<div class="hint">💡 ${esc(c.hint)}</div>` : ''}
        <form class="row" data-form="p-answer" data-clue="${i}"><input id="mys-a${i}" class="input" maxlength="20" inputmode="text" placeholder="Digit for clue ${i + 1}" autocomplete="off" aria-label="Answer for clue ${i + 1}"><button class="btn sm violet" type="submit" style="min-height:52px">Submit</button></form>
        ${c.hint ? '' : `<button class="btn sm ghost" data-act="p-hint" data-clue="${i}">Use a hint (−1:00)</button>`}`}
    </div>`).join('')}
    ${allSolved ? `<form class="card stack" data-form="p-final" style="border-color:var(--mint)"><h3>🔓 Final lock</h3><p class="small muted">Enter the three digits in clue order.</p>
      <div class="row"><input id="mys-final" class="input code" maxlength="3" inputmode="numeric" placeholder="•••" autocomplete="off" aria-label="Final code"><button class="btn mint" type="submit">Open</button></div></form>` : ''}
    <div class="card stack"><h3>Case log</h3>${feedHtml((g.log || []).slice(0, 8))}</div>
  </div>`;
}
handlers['p-answer'] = async f => {
  const i = Number(f.getAttribute('data-clue')); const inp = $('#mys-a' + i, f); const value = inp.value.trim();
  if (!value) return; setVal('mys-a' + i, ''); toast('Checking…');
  if (!(await act('answer', { clue: i, value }))) setVal('mys-a' + i, value);
};
handlers['p-hint'] = el => {
  if (!confirm('A hint costs one minute off the clock. Use it?')) return;
  act('hint', { clue: Number(el.getAttribute('data-clue')) });
};
handlers['p-final'] = async f => {
  const inp = $('#mys-final', f); const value = inp.value.replace(/\D/g, '');
  if (value.length !== 3) return toast('The final code has 3 digits.', 'bad');
  setVal('mys-final', ''); toast('Trying the lock…');
  if (!(await act('final', { value }))) setVal('mys-final', value);
};

// ---- player: party ----
function playerParty(st) {
  const g = st.game, me = P.me.pid;
  const roundLbl = `Round ${g.round + 1}/${g.total}${g.mult > 1 ? ' · 2× Sparks' : ''}`;
  const myPick = P.partyPick && P.partyPick.round === g.round ? P.partyPick.opt : null;
  const answered = g.answered.includes(me) || myPick != null;
  let main;
  if (g.stage === 'answer') {
    main = `<div class="opts">${g.prompt.options.map((o, i) => `<button class="opt ${myPick === i ? 'picked' : ''}" data-act="p-pick" data-i="${i}" ${answered ? 'disabled' : ''}><span class="k">${String.fromCharCode(65 + i)}</span>${esc(o)}${g.prompt.optIds && g.prompt.optIds[i] === me ? ' <span class="dim small">(you)</span>' : ''}</button>`).join('')}</div>
      <p class="center small muted">${answered ? `Locked in. Waiting for the room… (${g.answered.length}/${g.prompt.options && (st.order.filter(id => st.players[id] && !st.players[id].spectator).length)})` : 'Pick the answer you think the room will pick.'}</p>`;
  } else {
    const gain = (g.gains || {})[me] || 0;
    main = `<div class="card center stack pop"><span class="dim small">You earned</span><div class="timer spark">+${gain} Spark${gain === 1 ? '' : 's'}</div>
      <p class="small muted">${g.picks && me in g.picks ? (gain ? `${gain / g.mult} other${gain / g.mult === 1 ? '' : 's'} matched you.` : 'Nobody matched you this time.') : 'You didn\'t answer in time.'}</p></div>
      <div class="card stack"><h3>The room said…</h3>${withState(st, () => tallyHtml(g, me))}</div>`;
  }
  return `<div class="stack-l">
    <div class="row between"><span class="pill" style="color:var(--coral)">🎉 ${esc(roundLbl)}</span><span class="timer" data-until="${g.endsAt}">--:--</span></div>
    <div class="card stack">${g.prompt.wyr ? '' : `<span class="dim small">${esc(g.prompt.title)}</span>`}<div class="prompt">${esc(g.prompt.wyr ? 'Would you rather…' : g.prompt.text)}</div></div>
    ${main}
    <div class="card stack"><div class="row between"><h3>Sparks</h3><span class="spark">${g.sparks[me] || 0} yours</span></div>${withState(st, () => leaderboard(g, 5, me))}</div>
  </div>`;
}
handlers['p-pick'] = async el => {
  const g = P.state.game; const opt = Number(el.getAttribute('data-i'));
  P.partyPick = { round: g.round, opt }; renderPlayer();
  if (!(await act('answer', { round: g.round, opt }))) { P.partyPick = null; renderPlayer(); }
};

// =====================================================================
// QR SCANNER (camera with manual fallback)
// =====================================================================
let scan = null;
async function openScanner(onCode) {
  closeScanner();
  const ov = document.createElement('div'); ov.className = 'scanner';
  ov.innerHTML = `<div class="row between"><h3>Scan a badge</h3><button class="btn sm ghost" id="sc-close">Close</button></div>
    <div class="frame"><video playsinline muted autoplay></video></div>
    <p class="center small muted" id="sc-msg">Point the camera at someone's badge QR.</p>
    <form class="row" id="sc-form" style="max-width:520px;margin:0 auto;width:100%"><input class="input code" id="sc-code" maxlength="5" placeholder="or type CODE" autocomplete="off" autocapitalize="characters" aria-label="Badge code"><button class="btn sm sun" type="submit" style="min-height:52px">Go</button></form>`;
  document.body.appendChild(ov);
  scan = { ov, stream: null, timer: null, done: false };
  const finish = code => { if (scan && !scan.done) { scan.done = true; closeScanner(); onCode(code); } };
  ov.querySelector('#sc-close').onclick = closeScanner;
  ov.querySelector('#sc-form').onsubmit = e => { e.preventDefault(); const v = ov.querySelector('#sc-code').value.replace(/[^a-z0-9]/gi, '').toUpperCase(); if (v.length === 5) finish(v); else toast('Badge codes are 5 characters.', 'bad'); };
  const msg = ov.querySelector('#sc-msg'), video = ov.querySelector('video');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = 'Camera not available here — type the badge code instead.'; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (!scan || scan.ov !== ov) { stream.getTracks().forEach(t => t.stop()); return; }
    scan.stream = stream; video.srcObject = stream; await video.play().catch(() => {});
    const detector = ('BarcodeDetector' in window) ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const parse = raw => { const m = String(raw || '').toUpperCase().match(/PT:?([A-Z0-9]{5})/); return m ? m[1] : null; };
    const loop = async () => {
      if (!scan || scan.done || scan.ov !== ov) return;
      try {
        if (video.readyState >= 2) {
          let raw = null;
          if (detector) { const codes = await detector.detect(video); raw = codes[0] && codes[0].rawValue; }
          else if (window.jsQR) {
            const w = 360, hgt = Math.round(360 * (video.videoHeight / video.videoWidth || 1));
            canvas.width = w; canvas.height = hgt; ctx.drawImage(video, 0, 0, w, hgt);
            const res = window.jsQR(ctx.getImageData(0, 0, w, hgt).data, w, hgt, { inversionAttempts: 'dontInvert' });
            raw = res && res.data;
          }
          const c = parse(raw); if (c) return finish(c);
          if (raw) msg.textContent = 'That QR isn\'t a Plot Twist badge.';
        }
      } catch (e) {}
      scan.timer = setTimeout(loop, 220);
    };
    loop();
  } catch (e) { msg.textContent = 'Camera blocked — type the badge code instead.'; }
}
function closeScanner() {
  if (!scan) return;
  clearTimeout(scan.timer);
  if (scan.stream) scan.stream.getTracks().forEach(t => t.stop());
  scan.ov.remove(); scan = null;
}

route();
})();
