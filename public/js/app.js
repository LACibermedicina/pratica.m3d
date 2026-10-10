'use strict';
/* =========================================================================
   pratica.M3D v6 — SPA (JavaScript sem build), autenticação, catálogo,
   salas OSCE com WebRTC + failsafe Agora, SRS, flowcards, PEP, admin.
   ========================================================================= */
import { m3dLogo } from './logo.js';
import { VideoRoom } from './video.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (sec) => { sec = Math.max(0, +sec | 0); return `${String((sec / 60) | 0).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

const S = {
  token: localStorage.getItem('m3d_token') || '',
  user: null, tab: 'dash', meta: {}, rooms: [], stations: [], srs: [], flowcards: [],
  peps: [], analytics: null, admin: null, room: null, station: null, participants: [],
  marks: {}, messages: [], video: null, socket: null, timerInterval: null,
};

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (S.token) h.Authorization = `Bearer ${S.token}`;
  if (body && !(body instanceof FormData)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(path, { method, headers: h, body });
  if (raw) return res;
  if (!res.ok && res.status === 401) { logout(); throw new Error('Sessão expirada'); }
  return res;
}

/* --------------------------------------------------------- bootstrap UI --- */
async function boot() {
  $('#logo-slot').innerHTML = m3dLogo(40);
  $('#logo-hero').innerHTML = m3dLogo(88);
  bindAuth();
  if (S.token) {
    try { const r = await (await api('/api/me')).json(); if (r.ok) { S.user = r.user; return enterApp(); } }
    catch { /* fallthrough */ }
  }
  showAuth();
}
document.addEventListener('DOMContentLoaded', boot);

function showAuth() {
  $('#view-auth').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  $('#nav').classList.add('hidden'); $('#user-chip').classList.add('hidden');
  api('/api/meta').then((r) => r.json()).then((m) => {
    S.meta = m;
    $('#auth-stats').innerHTML = [
      ['Estações', m.stats.stations],
      ['Usuários', m.stats.users],
      ['Salas abertas', m.stats.rooms_open],
    ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  });
}

function bindAuth() {
  $('#tab-login').onclick = () => switchAuth('login');
  $('#tab-register').onclick = () => switchAuth('register');
  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await (await api('/api/login', { method: 'POST', body: { login: fd.get('login'), password: fd.get('password') } })).json();
    if (!r.ok) return $('#auth-msg').textContent = r.error;
    acceptSession(r);
  };
  $('#form-register').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await (await api('/api/register', { method: 'POST', body: { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') } })).json();
    if (!r.ok) return $('#auth-msg').textContent = r.error;
    acceptSession(r);
  };
}
function switchAuth(k) {
  const log = k === 'login';
  $('#tab-login').classList.toggle('active', log); $('#tab-login').setAttribute('aria-selected', log);
  $('#tab-register').classList.toggle('active', !log); $('#tab-register').setAttribute('aria-selected', !log);
  $('#form-login').classList.toggle('hidden', !log); $('#form-register').classList.toggle('hidden', log);
  $('#auth-msg').textContent = '';
}
function acceptSession(r) {
  S.token = r.token; S.user = r.user; localStorage.setItem('m3d_token', S.token);
  enterApp();
}
function logout() {
  if (S.socket) try { S.socket.disconnect(); } catch {}
  if (S.video) S.video.stop();
  api('/api/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('m3d_token'); S.token = ''; S.user = null;
  showAuth();
}

/* -------------------------------------------------------------- shell --- */
function enterApp() {
  $('#view-auth').classList.add('hidden'); $('#view-app').classList.remove('hidden');
  $('#nav').classList.remove('hidden'); $('#user-chip').classList.remove('hidden');
  renderNav(); renderUserChip(); connectSocket(); go('dash');
}

function renderNav() {
  const tabs = [
    ['dash', 'Painel'], ['rooms', 'Salas OSCE'], ['catalog', 'Catálogo'],
    ['srs', 'SRS'], ['cards', 'Flowcards'], ['peps', 'PEPs'], ['analytics', 'Desempenho'],
  ];
  if (['root', 'admin'].includes(S.user.role)) tabs.push(['admin', 'Admin']);
  $('#nav').innerHTML = tabs.map(([k, l]) => `<button class="navbtn ${S.tab === k ? 'active' : ''}" data-k="${k}">${l}</button>`).join('');
  $$('#nav .navbtn').forEach((b) => b.onclick = () => go(b.dataset.k));
}
function renderUserChip() {
  $('#user-chip').className = 'flex items-center gap-2';
  $('#user-chip').innerHTML = `
    <span class="tag">${esc(S.user.name)} · ${esc(S.user.role)}</span>
    <button class="btn-ghost" id="btn-logout">Sair</button>`;
  $('#btn-logout').onclick = logout;
}

function go(tab) {
  S.tab = tab; renderNav();
  $$('#view-app .panel').forEach((p) => p.classList.add('hidden'));
  const map = { dash: renderDash, rooms: renderRoomsList, room: renderRoomView, catalog: renderCatalog,
    srs: renderSrs, cards: renderCards, peps: renderPeps, analytics: renderAnalytics, admin: renderAdmin };
  (map[tab] || renderDash)();
  const el = $(`#panel-${tab}`); if (el) el.classList.remove('hidden');
}

/* --------------------------------------------------------------- socket --- */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.socket = io({ auth: { token: S.token } });
  const badge = $('#conn-badge');
  S.socket.on('connect', () => { badge.textContent = 'online'; badge.className = 'badge on'; });
  S.socket.on('disconnect', () => { badge.textContent = 'offline'; badge.className = 'badge err'; });
  S.socket.on('chat:message', onChat);
  S.socket.on('room:participants', ({ participants }) => { S.participants = participants; if (S.tab === 'room') updateParticipants(); });
  S.socket.on('room:mark', ({ station_id, candidate_id, item_idx, value }) => {
    const key = `${station_id}:${candidate_id}:${item_idx}`;
    S.marks[key] = value; if (S.tab === 'room') updateMarks();
  });
  S.socket.on('room:station', ({ station }) => { S.station = station; if (S.tab === 'room') renderRoomView(); });
  S.socket.on('room:timer', ({ timer }) => { if (S.room) { S.room.timer = timer; updateTimer(); } });
  S.socket.on('room:closed', () => { toast('Sala encerrada pelo criador.'); go('rooms'); });
}

/* --------------------------------------------------------------- painel --- */
async function renderDash() {
  const meta = await (await api('/api/meta')).json();
  const anal = await (await api('/api/analytics')).json();
  const stats = meta.stats;
  $('#panel-dash').innerHTML = `
    <div class="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
      <div class="card">
        <h2 class="text-xl font-black text-deep">Bem-vindo(a), ${esc(S.user.name)} 👋</h2>
        <p class="mt-1 text-[13.5px] text-mut">Treino OSCE/Revalida com videoconferência resiliente e correção por IA.</p>
        <div class="grid gap-3 sm:grid-cols-3 mt-4">
          ${stat('Estações', stats.stations)}${stat('Salas abertas', stats.rooms_open)}${stat('Usuários', stats.users)}
        </div>
        <div class="mt-5 flex gap-2 flex-wrap">
          <button class="btn-primary" id="go-new-room">Criar sala OSCE</button>
          <button class="btn-ghost" id="go-catalog">Explorar catálogo</button>
          <button class="btn-ghost" id="go-srs">Revisar SRS</button>
        </div>
      </div>
      <div class="card">
        <h3 class="font-black text-deep">Desempenho por grande área</h3>
        <div class="mt-3 space-y-2">${(anal.by_area || []).map(renderAreaBar).join('') || '<p class="text-mut text-sm">Realize PEPs para ver seu desempenho.</p>'}</div>
      </div>
    </div>`;
  $('#go-new-room').onclick = () => go('rooms');
  $('#go-catalog').onclick = () => go('catalog');
  $('#go-srs').onclick = () => go('srs');
}
const stat = (k, v) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`;
function renderAreaBar(a) {
  const c = (S.meta.area_colors || {})[a.area] || '#0d9488';
  const label = (S.meta.area_labels || {})[a.area] || a.area;
  return `<div><div class="flex justify-between text-[12.5px] font-bold"><span>${esc(label)}</span><span>${a.avg_pct || 0}% · ${a.n} PEPs</span></div>
    <div class="bar mt-1"><i style="width:${Math.min(100, a.avg_pct || 0)}%;background:${c}"></i></div></div>`;
}

/* --------------------------------------------------------------- salas --- */
async function renderRoomsList() {
  const r = await (await api('/api/rooms')).json();
  S.rooms = r.rooms || [];
  const stations = await (await api('/api/stations')).json();
  const stOpts = (stations.stations || []).slice(0, 300).map((s) => `<option value="${esc(s.id)}">[${esc(s.area)}] ${esc(s.tema)}</option>`).join('');
  $('#panel-rooms').innerHTML = `
    <div class="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <div class="card">
        <h3 class="font-black text-deep">Nova sala OSCE</h3>
        <form id="form-room" class="space-y-2 mt-3">
          <label class="fld">Nome<input name="name" required class="inp" placeholder="Simulado Clínica Médica · Grupo 1"/></label>
          <label class="fld">Estação inicial<select name="station" class="inp">${stOpts}</select></label>
          <div class="grid grid-cols-2 gap-2">
            <label class="fld">Duração (s)<input name="duration" type="number" value="600" min="60" class="inp"/></label>
            <label class="fld">Tipo<select name="rtype" class="inp"><option value="live">Ao vivo</option><option value="study">Estudo</option></select></label>
          </div>
          <button class="btn-primary w-full">Criar sala</button>
        </form>
        <p class="mt-3 text-[12px] text-mut">Vídeo: WebRTC P2P → failsafe automático <b>Agora</b> em ~8s.</p>
      </div>
      <div class="card">
        <div class="flex justify-between items-center"><h3 class="font-black text-deep">Salas abertas</h3>
          <label class="fld m-0">Entrar por código<input id="join-code" class="inp" placeholder="A1B2C3"/></label></div>
        <div class="mt-3 space-y-2">${S.rooms.map((r) => `
          <div class="flex justify-between items-center border rounded-xl p-3" style="border-color:var(--line)">
            <div><div class="font-bold">${esc(r.name)}</div>
              <div class="text-xs text-mut">${esc(r.code)} · ${esc(r.rtype)} · criado por ${esc(r.creator_name)}</div></div>
            <button class="btn-primary enter" data-code="${esc(r.code)}">Entrar</button>
          </div>`).join('') || '<p class="text-mut text-sm">Nenhuma sala aberta no momento.</p>'}
        </div>
      </div>
    </div>`;
  $('#form-room').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), station_ids: [fd.get('station')].filter(Boolean),
      timer_duration: +fd.get('duration'), rtype: fd.get('rtype') };
    const r = await (await api('/api/rooms', { method: 'POST', body })).json();
    if (!r.ok) return toast(r.error);
    enterRoom(r.room.code);
  };
  $$('.enter').forEach((b) => b.onclick = () => enterRoom(b.dataset.code));
  $('#join-code').onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) enterRoom(e.target.value.trim().toUpperCase()); };
}

async function enterRoom(code) {
  const r = await (await api('/api/rooms/' + code)).json();
  if (!r.ok) return toast(r.error || 'Sala não encontrada.');
  S.room = r.room; S.station = r.station; S.participants = r.participants || []; S.marks = {}; S.messages = [];
  go('room');
  S.socket.emit('room:join', { code, role: 'observer' });
}

function renderRoomView() {
  if (!S.room) return $('#panel-room').innerHTML = '<div class="card">Sala indisponível.</div>';
  const r = S.room, st = S.station;
  const canEval = ['root', 'admin'].includes(S.user.role) || S.user.id === r.creator_id;
  $('#panel-room').innerHTML = `
    <div class="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <div class="card">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div><div class="text-xs text-mut font-black tracking-widest">SALA ${esc(r.code)}</div>
            <h2 class="font-black text-deep text-xl">${esc(r.name)}</h2></div>
          <div class="flex items-center gap-3">
            <div><div class="timer" id="timer">${fmt(r.timer.left)}</div>
              <div class="text-[10px] text-mut font-bold text-right">${r.timer.running ? 'RODANDO' : 'PARADO'}</div></div>
            <span id="video-mode" class="badge video">vídeo: iniciando…</span>
          </div>
        </div>
        <div class="mt-3 flex gap-2 flex-wrap">
          <button class="btn-primary" id="btn-video-start">Entrar com vídeo</button>
          <button class="btn-ghost" id="btn-mute">Mudo</button>
          <button class="btn-ghost" id="btn-cam">Cam off</button>
          ${canEval ? `<button class="btn-ghost" id="btn-timer-start">▶ iniciar</button>
            <button class="btn-ghost" id="btn-timer-pause">⏸ pausar</button>
            <button class="btn-ghost" id="btn-timer-reset">⟳ reset</button>` : ''}
          <button class="btn-danger ml-auto" id="btn-leave">Sair</button>
        </div>
        <div class="vgrid mt-4" id="vgrid"></div>
        ${st ? renderStationBlock(st, canEval) : '<p class="text-mut mt-5">Nenhuma estação ativa.</p>'}
      </div>
      <div class="card">
        <h3 class="font-black text-deep">Participantes</h3>
        <div id="participants" class="mt-2 space-y-1"></div>
        <h3 class="font-black text-deep mt-4">Chat da sala</h3>
        <div class="msgbox mt-2" id="chatbox"></div>
        <form id="chatform" class="mt-2 flex gap-2">
          <input name="t" class="inp" placeholder="Mensagem…" required/>
          <button class="btn-primary">Enviar</button>
        </form>
      </div>
    </div>`;
  updateParticipants();
  bindRoomControls(canEval);
  startTimerLoop();
}

function renderStationBlock(st, canEval) {
  const chk = (st.checklist || []).map((c, i) => `
    <label class="chk" data-i="${i}">
      <input type="checkbox" ${canEval ? '' : 'disabled'} data-i="${i}"/>
      <div><div class="chk-t">${esc(c.item)}</div><div class="text-xs text-mut">peso ${c.peso}</div></div>
    </label>`).join('');
  return `
    <div class="mt-5 border-t pt-4" style="border-color:var(--line)">
      <div class="flex justify-between flex-wrap gap-2">
        <div><div class="text-xs text-mut font-black tracking-widest">ESTAÇÃO</div>
          <h3 class="font-black text-deep">${esc(st.tema)}</h3>
          <div class="flex gap-1 mt-1"><span class="tag">${esc(st.area)}</span><span class="tag">${esc(st.nivel || '')}</span><span class="tag">${+st.duracao} min</span></div></div>
        ${canEval ? `<button class="btn-primary" id="btn-close-pep">Fechar PEP</button>` : ''}
      </div>
      <details class="mt-3"><summary class="cursor-pointer font-bold text-deep">Instruções e cenário</summary>
        <div class="mt-2 text-[13.5px] whitespace-pre-wrap">${esc(st.instrucoes)}\n\n${esc(st.cenario)}</div></details>
      <div class="mt-3 grid gap-2" id="chklist">${chk}</div>
      ${canEval ? '<p class="text-xs text-mut mt-2">Marcações sincronizam ao vivo entre avaliadores.</p>' : ''}
    </div>`;
}

function bindRoomControls(canEval) {
  $('#btn-video-start').onclick = startVideo;
  $('#btn-leave').onclick = () => { if (S.video) S.video.stop(); S.socket.emit('room:leave'); go('rooms'); };
  $('#btn-mute').onclick = () => {
    if (!S.video || !S.video.local) return;
    const t = S.video.local.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; toast(t.enabled ? 'Mic ligado' : 'Mic mudo'); }
  };
  $('#btn-cam').onclick = () => {
    if (!S.video || !S.video.local) return;
    const t = S.video.local.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; toast(t.enabled ? 'Cam ligada' : 'Cam desligada'); }
  };
  if (canEval) {
    $('#btn-timer-start').onclick = () => api(`/api/rooms/${S.room.code}/timer`, { method: 'POST', body: { action: 'start' } });
    $('#btn-timer-pause').onclick = () => api(`/api/rooms/${S.room.code}/timer`, { method: 'POST', body: { action: 'pause' } });
    $('#btn-timer-reset').onclick = () => api(`/api/rooms/${S.room.code}/timer`, { method: 'POST', body: { action: 'reset', duration: S.room.timer.duration } });
    $('#btn-close-pep')?.addEventListener('click', closePep);
  }
  $$('#chklist input[type=checkbox]').forEach((cb) => cb.onchange = () => {
    const i = +cb.dataset.i;
    api(`/api/rooms/${S.room.code}/marks`, { method: 'POST', body: {
      station_id: S.station.id, candidate_id: pickCandidate(), item_idx: i, value: cb.checked ? 1 : 0,
    } });
    cb.closest('.chk').classList.toggle('done', cb.checked);
  });
  $('#chatform').onsubmit = (e) => {
    e.preventDefault(); const inp = e.target.t;
    S.socket.emit('chat:send', { text: inp.value });
    inp.value = '';
  };
}

function pickCandidate() {
  const cand = S.participants.find((p) => p.role === 'candidato');
  return cand ? cand.id : S.user.id;
}

async function closePep() {
  if (!confirm('Fechar PEP do candidato e enviar para correção da IA?')) return;
  const r = await (await api(`/api/rooms/${S.room.code}/pep`, { method: 'POST', body: { candidate_id: pickCandidate() } })).json();
  if (!r.ok) return toast(r.error);
  toast(`PEP fechado: ${r.pep.score}/${r.pep.max_score} (${r.pep.pct}%).`);
  go('peps');
}

function updateParticipants() {
  const el = $('#participants'); if (!el) return;
  const roles = ['candidato', 'avaliador', 'ator', 'observer'];
  el.innerHTML = `<div class="flex flex-wrap gap-1 mb-2">${roles.map((r) => `<button class="tag role-btn" data-r="${r}">eu: ${r}</button>`).join('')}</div>`
    + S.participants.map((p) => `<div class="flex justify-between items-center text-[13px]">
      <span>${esc(p.name)} ${p.id === S.user.id ? '<span class="text-xs text-mut">(você)</span>' : ''}</span>
      <span class="tag">${esc(p.role)}</span></div>`).join('');
  $$('.role-btn').forEach((b) => b.onclick = () => { S.socket.emit('room:role', { role: b.dataset.r }); toast('Papel atualizado: ' + b.dataset.r); });
}
function updateMarks() {
  $$('#chklist input[type=checkbox]').forEach((cb) => {
    const key = `${S.station.id}:${pickCandidate()}:${cb.dataset.i}`;
    const v = !!S.marks[key]; cb.checked = v; cb.closest('.chk').classList.toggle('done', v);
  });
}
function updateTimer() {
  const el = $('#timer'); if (!el) return;
  el.textContent = fmt(S.room.timer.left);
  el.classList.toggle('low', S.room.timer.left < 60);
}
function startTimerLoop() {
  clearInterval(S.timerInterval);
  S.timerInterval = setInterval(() => {
    if (!S.room || S.tab !== 'room') return;
    if (S.room.timer.running) {
      S.room.timer.left = Math.max(0, S.room.timer.left - 1);
      updateTimer();
    }
  }, 1000);
}
function onChat(m) {
  if (S.tab !== 'room') return;
  const box = $('#chatbox'); if (!box) return;
  const mine = m.from_id === S.user.id;
  box.insertAdjacentHTML('beforeend',
    `<div class="msg ${mine ? 'mine' : ''}"><div class="who">${esc(m.from_name)}${m.scope === 'private' ? ' · privado' : ''}</div>${esc(m.text)}</div>`);
  box.scrollTop = box.scrollHeight;
}

async function startVideo() {
  if (S.video) return;
  $('#btn-video-start').disabled = true;
  S.video = new VideoRoom({ socket: S.socket, api, roomCode: S.room.code, selfId: S.user.id, selfName: S.user.name });
  S.video.addEventListener('local', (e) => addTile('local', S.user.name + ' (você)', e.detail.stream, true));
  S.video.addEventListener('remote', (e) => {
    const name = (S.participants.find((p) => p.id === e.detail.peerId)?.name) || ('Peer ' + e.detail.peerId);
    addTile(String(e.detail.peerId), name, e.detail.stream, false);
  });
  S.video.addEventListener('drop', (e) => { const t = $('#tile-' + e.detail.peerId); if (t) t.remove(); });
  S.video.addEventListener('mode', (e) => {
    const b = $('#video-mode'); if (!b) return;
    const map = { p2p: ['vídeo: P2P', 'badge video'], agora: ['vídeo: Agora (failsafe)', 'badge warn'],
      failed: ['vídeo: indisponível', 'badge err'], idle: ['vídeo: encerrado', 'badge'] };
    const [t, c] = map[e.detail.mode] || ['vídeo: ' + e.detail.mode, 'badge'];
    b.textContent = t; b.className = c;
    if (e.detail.mode === 'agora') toast('P2P não conectou — migrando para Agora.');
  });
  try { await S.video.start(); }
  catch (err) { toast('Falha ao acessar câmera/microfone: ' + err.message); $('#btn-video-start').disabled = false; }
}
function addTile(peerId, label, stream, mute) {
  const grid = $('#vgrid'); if (!grid) return;
  let tile = $('#tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div'); tile.className = 'vtile live'; tile.id = 'tile-' + peerId;
    tile.innerHTML = `<video autoplay playsinline ${mute ? 'muted' : ''}></video><span class="vlabel">${esc(label)}</span>`;
    grid.appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}

/* ------------------------------------------------------------- catálogo --- */
async function renderCatalog() {
  const r = await (await api('/api/stations')).json();
  S.stations = r.stations || [];
  const canImport = ['root', 'admin'].includes(S.user.role);
  $('#panel-catalog').innerHTML = `
    <div class="card">
      <div class="flex flex-wrap gap-2 justify-between items-center">
        <h3 class="font-black text-deep">Catálogo de estações (${S.stations.length})</h3>
        <div class="flex gap-2 flex-wrap">
          <input id="st-q" class="inp" placeholder="buscar tema…" style="width:220px"/>
          <select id="st-area" class="inp" style="width:160px"><option value="">Todas áreas</option>
            ${Object.entries(S.meta.area_labels || {}).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <a class="btn-ghost" href="/api/stations/export.xlsx?token=${S.token}">Export XLSX</a>
          <a class="btn-ghost" href="/api/stations/export.json?token=${S.token}">Export JSON</a>
          ${canImport ? `<label class="btn-primary" style="cursor:pointer">Importar XLSX<input id="imp" type="file" accept=".xlsx" hidden/></label>
                        <button class="btn-ghost" id="ai-gen">Gerar por IA</button>` : ''}
        </div>
      </div>
      <div id="catgrid" class="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3"></div>
    </div>`;
  const paint = () => {
    const q = $('#st-q').value.toLowerCase(); const a = $('#st-area').value;
    const rows = S.stations.filter((s) => (!a || s.area === a) && (!q || (s.tema + ' ' + s.especialidade).toLowerCase().includes(q)));
    $('#catgrid').innerHTML = rows.slice(0, 180).map((s) => {
      const c = (S.meta.area_colors || {})[s.area] || '#0d9488';
      return `<div class="card" style="padding:14px">
        <div class="flex gap-2 items-center"><span class="chip" style="background:${c}">${esc(s.area)}</span>
          <span class="tag">${+s.duracao} min</span><span class="tag">${esc(s.nivel || '')}</span></div>
        <div class="font-bold mt-2">${esc(s.tema)}</div>
        <div class="text-xs text-mut">${esc(s.especialidade || '')}</div>
        <div class="mt-2 flex gap-1 flex-wrap">
          <button class="btn-ghost mk-flow" data-id="${esc(s.id)}">Fluxograma</button>
          <button class="btn-ghost mk-srs" data-id="${esc(s.id)}">+SRS</button>
        </div></div>`;
    }).join('') || '<p class="text-mut">Nada encontrado.</p>';
    $$('.mk-flow').forEach((b) => b.onclick = () => makeFlow(b.dataset.id));
    $$('.mk-srs').forEach((b) => b.onclick = () => quickSrs(b.dataset.id));
  };
  paint();
  $('#st-q').oninput = paint; $('#st-area').onchange = paint;
  if (canImport) {
    $('#imp').onchange = async (e) => {
      const fd = new FormData(); fd.append('file', e.target.files[0]);
      const r = await (await api('/api/stations/import', { method: 'POST', body: fd })).json();
      if (!r.ok) return toast(r.error);
      toast(`Importação: ${r.imported} novas, ${r.updated} atualizadas.`); renderCatalog();
    };
    $('#ai-gen').onclick = async () => {
      const tema = prompt('Tema da estação (deixe em branco para livre):') || '';
      const area = prompt('Área (CM, CIR, GO, PED, MFC):', 'CM') || 'CM';
      const r = await (await api('/api/ai/station', { method: 'POST', body: { tema, area } })).json();
      if (!r.ok) return toast(r.error);
      toast(`Estação criada via IA (${r.provider}).`); renderCatalog();
    };
  }
}
async function makeFlow(stationId) {
  toast('Gerando fluxograma…');
  const r = await (await api('/api/flowcards', { method: 'POST', body: { station_id: stationId } })).json();
  if (!r.ok) return toast(r.error);
  toast(`Flowcard criado (${r.source === 'xabcde' ? 'template XABCDE local' : 'IA'}).`); go('cards');
}
async function quickSrs(stationId) {
  const front = prompt('Frente do card (pergunta):'); if (!front) return;
  const back = prompt('Verso (resposta):'); if (!back) return;
  await api('/api/srs', { method: 'POST', body: { station_id: stationId, front, back } });
  toast('Card SRS criado.');
}

/* -------------------------------------------------------------- SRS ------ */
async function renderSrs() {
  const r = await (await api('/api/srs')).json(); S.srs = r;
  $('#panel-srs').innerHTML = `
    <div class="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
      <div class="card"><h3 class="font-black text-deep">Repetição espaçada</h3>
        <div class="mt-3 grid grid-cols-3 gap-2">
          ${stat('Devidos', r.due)}${stat('Total', r.total)}${stat('Estágios', r.intervals.length)}</div>
        <p class="text-mut text-xs mt-3">Intervalos: ${r.intervals.join(', ')} dias.</p></div>
      <div class="card"><h3 class="font-black text-deep">Sessão de revisão</h3>
        <div id="srs-session" class="mt-3"></div></div>
    </div>`;
  startSrsSession();
}
function startSrsSession() {
  const due = (S.srs.cards || []).filter((c) => c.due);
  const box = $('#srs-session');
  if (!due.length) { box.innerHTML = '<p class="text-mut">Sem cards devidos. 🎉</p>'; return; }
  let idx = 0, revealed = false;
  const paint = () => {
    const c = due[idx];
    box.innerHTML = `
      <div class="srscard" id="flip"><div class="text-xs text-mut">frente ${idx + 1}/${due.length}</div>
        <div class="mt-2 font-bold">${esc(c.front)}</div>
        ${revealed ? `<hr class="my-3" style="border-color:var(--line)"/><div>${esc(c.back)}</div>` : ''}</div>
      ${revealed ? `<div class="flex gap-2 mt-3 flex-wrap">
        ${[['errei', 0], ['difícil', 1], ['bom', 2], ['fácil', 3]].map(([l, q]) => `<button class="btn-ghost rate" data-q="${q}">${l}</button>`).join('')}
      </div>` : '<p class="text-mut text-sm mt-2">Clique no card para revelar.</p>'}`;
    $('#flip').onclick = () => { revealed = true; paint(); };
    $$('.rate').forEach((b) => b.onclick = async () => {
      await api(`/api/srs/${c.id}/review`, { method: 'POST', body: { quality: +b.dataset.q } });
      idx++; revealed = false;
      if (idx >= due.length) { toast('Sessão concluída.'); renderSrs(); } else paint();
    });
  };
  paint();
}

/* ----------------------------------------------------------- flowcards --- */
async function renderCards() {
  const r = await (await api('/api/flowcards')).json(); S.flowcards = r.cards || [];
  $('#panel-cards').innerHTML = `
    <div class="card"><h3 class="font-black text-deep">Cards de procedimento (${S.flowcards.length})</h3>
      <p class="text-xs text-mut">SVG vetorial — nenhum dado ilustrativo falso: o fluxograma deriva do spec da IA (ou do template XABCDE).</p>
      <div class="mt-4 grid gap-4 md:grid-cols-2">${S.flowcards.map((c) => `
        <div class="card" style="padding:12px">
          <div class="flex justify-between items-center"><div><div class="font-bold">${esc(c.title)}</div>
            <div class="text-xs text-mut">${esc(c.station_tema || c.station_id || 'sem estação')}</div></div>
            <button class="btn-danger del-flow" data-id="${c.id}">Excluir</button></div>
          <div class="mt-2 border rounded-xl overflow-hidden" style="border-color:var(--line)">
            <img alt="${esc(c.title)}" src="/cards/${c.id}.svg?token=${S.token}" style="width:100%;display:block"/></div>
          <details class="mt-2"><summary class="font-bold text-deep cursor-pointer">Resumo prático</summary>
            <pre class="whitespace-pre-wrap text-[13px] mt-2">${esc(c.summary)}</pre></details>
        </div>`).join('') || '<p class="text-mut">Gere um fluxograma na página Catálogo.</p>'}</div></div>`;
  $$('.del-flow').forEach((b) => b.onclick = async () => { await api('/api/flowcards/' + b.dataset.id, { method: 'DELETE' }); renderCards(); });
}

/* -------------------------------------------------------------- PEPs ----- */
async function renderPeps() {
  const r = await (await api('/api/peps')).json(); S.peps = r.peps || [];
  $('#panel-peps').innerHTML = `
    <div class="card"><h3 class="font-black text-deep">PEPs (${S.peps.length})</h3>
      <table class="tbl mt-2"><thead><tr><th>#</th><th>Estação</th><th>Nota</th><th>IA</th><th>Data</th><th></th></tr></thead>
      <tbody>${S.peps.map((p) => `<tr>
        <td>${p.id}</td><td>${esc(p.station_id)}</td>
        <td><b>${p.score}/${p.max_score}</b> <span class="text-mut">(${p.pct}%)</span></td>
        <td><span class="tag">${esc(p.ai_status)}</span></td>
        <td class="text-xs text-mut">${new Date(+p.created_at).toLocaleString('pt-BR')}</td>
        <td><button class="btn-ghost view-pep" data-id="${p.id}">ver</button></td></tr>`).join('')}
      </tbody></table>
      <div id="pep-detail" class="mt-4"></div></div>`;
  $$('.view-pep').forEach((b) => b.onclick = () => openPep(b.dataset.id));
}
async function openPep(id) {
  const r = await (await api('/api/peps/' + id)).json();
  if (!r.ok) return toast(r.error);
  const p = r.pep, ai = p.ai;
  const items = p.items.map((it) => `<li class="${it.marcado ? '' : 'text-coral'}">${it.marcado ? '✔' : '✘'} ${esc(it.item)} <span class="text-mut">(peso ${it.peso})</span></li>`).join('');
  $('#pep-detail').innerHTML = `
    <div class="card">
      <h4 class="font-black text-deep">PEP #${p.id} — ${p.score}/${p.max_score} (${p.pct}%)</h4>
      <ul class="list-none mt-2 text-[13.5px] space-y-1">${items}</ul>
      ${ai ? `<div class="mt-3 border-t pt-2" style="border-color:var(--line)">
        <h5 class="font-bold">Correção IA</h5>
        <p class="text-sm"><b>Comentário:</b> ${esc(ai.comentario || '')}</p>
        <p class="text-sm"><b>Pontos fortes:</b> ${(ai.pontos_fortes || []).map(esc).join('; ')}</p>
        <p class="text-sm"><b>Lacunas:</b> ${(ai.lacunas || []).map(esc).join('; ')}</p>
      </div>` : `<p class="text-xs text-mut mt-2">IA: ${esc(p.ai_status)}</p>`}
      <div class="mt-3 flex gap-2 flex-wrap">
        <button class="btn-ghost" id="srs-from-pep">Gerar SRS do que faltou</button>
        <button class="btn-primary" id="dispute">Disputar correção</button>
      </div>
      <div id="disputes" class="mt-3">${(r.disputes || []).map((d) => `
        <div class="border rounded-xl p-3 mt-2" style="border-color:var(--line)">
          <div class="flex justify-between"><b>${esc(d.by_name)}</b><span class="tag">${esc(d.status)}</span></div>
          <p class="text-sm">${esc(d.reason)}</p>
          ${d.ai ? `<p class="text-sm text-mut">IA: ${esc(d.ai.parecer || '')} — ${esc(d.ai.justificativa || '')}</p>` : ''}
        </div>`).join('')}</div>
    </div>`;
  $('#srs-from-pep').onclick = async () => {
    const r2 = await (await api('/api/srs/from-pep', { method: 'POST', body: {} }).catch(() => ({ json: () => ({ ok: false, error: 'Falha' }) }))).json?.() || {};
    toast(r2.created ? `${r2.created} card(s) SRS criados.` : 'Nada a criar.');
  };
  $('#dispute').onclick = async () => {
    const reason = prompt('Descreva o motivo da disputa:'); if (!reason) return;
    const r2 = await (await api(`/api/peps/${p.id}/dispute`, { method: 'POST', body: { reason } })).json();
    if (!r2.ok) return toast(r2.error);
    toast('Disputa aberta — IA analisará.'); openPep(id);
  };
}

/* --------------------------------------------------------- analytics ----- */
async function renderAnalytics() {
  const r = await (await api('/api/analytics')).json();
  $('#panel-analytics').innerHTML = `
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card"><h3 class="font-black text-deep">Desempenho por área</h3>
        <div class="mt-3 space-y-2">${(r.by_area || []).map(renderAreaBar).join('') || '<p class="text-mut">Sem PEPs ainda.</p>'}</div></div>
      <div class="card"><h3 class="font-black text-deep">PEPs recentes</h3>
        <table class="tbl mt-2"><thead><tr><th>Tema</th><th>Área</th><th>%</th><th>Data</th></tr></thead>
        <tbody>${(r.recent || []).map((p) => `<tr><td>${esc(p.tema || '-')}</td><td>${esc(p.area || '-')}</td><td><b>${p.pct}%</b></td>
          <td class="text-xs text-mut">${new Date(+p.created_at).toLocaleString('pt-BR')}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
}

/* -------------------------------------------------------------- admin --- */
async function renderAdmin() {
  const users = await (await api('/api/admin/users')).json();
  const ai = await (await api('/api/ai/status')).json();
  const logs = await (await api('/api/ai/logs')).json();
  $('#panel-admin').innerHTML = `
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card"><h3 class="font-black text-deep">Cadeia de IA</h3>
        <div class="mt-2 flex gap-2 flex-wrap">${(ai.providers || []).map((p) => `<span class="badge ${p.configured ? 'on' : 'warn'}">${p.provider}: ${p.configured ? 'OK' : 'não configurado'}</span>`).join('')}</div>
        <h4 class="font-bold mt-3">Resumo de chamadas</h4>
        <table class="tbl"><thead><tr><th>Provedor</th><th>Total</th><th>OKs</th><th>Latência média</th></tr></thead>
          <tbody>${(logs.summary || []).map((s) => `<tr><td>${s.provider}</td><td>${s.n}</td><td>${s.oks}</td><td>${s.avg_ms || 0} ms</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h3 class="font-black text-deep">Usuários</h3>
        <table class="tbl mt-2"><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th></th></tr></thead>
        <tbody>${(users.users || []).map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
          <td><span class="tag">${u.banned ? 'banido' : 'ativo'}</span></td>
          <td class="flex gap-1">${S.user.role === 'root' && u.role !== 'root' ? `
            <button class="btn-ghost role-up" data-id="${u.id}">${u.role === 'admin' ? '→user' : '→admin'}</button>` : ''}
            ${u.role !== 'root' ? `<button class="btn-danger ban" data-id="${u.id}" data-b="${u.banned ? 0 : 1}">${u.banned ? 'desbanir' : 'banir'}</button>` : ''}
          </td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $$('.role-up').forEach((b) => b.onclick = async () => {
    const u = users.users.find((x) => x.id == b.dataset.id);
    await api(`/api/admin/users/${u.id}/role`, { method: 'POST', body: { role: u.role === 'admin' ? 'user' : 'admin' } });
    renderAdmin();
  });
  $$('.ban').forEach((b) => b.onclick = async () => {
    await api(`/api/admin/users/${b.dataset.id}/ban`, { method: 'POST', body: { banned: +b.dataset.b } }); renderAdmin();
  });
}
