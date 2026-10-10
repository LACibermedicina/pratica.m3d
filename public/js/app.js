'use strict';
/* =========================================================================
   pratica.M3D v6 — SPA (JavaScript sem build), autenticação, catálogo,
   salas OSCE com WebRTC + failsafe Agora, SRS, flowcards, PEP, admin.
   ========================================================================= */
import { m3dLogo } from './logo.js';
import { roomUI } from './room-ui.js';
import { accountUI } from './account-ui.js';

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
  if (!res.ok && res.status === 401 && !['/api/login','/api/register','/api/auth/forgot','/api/auth/reset'].includes(path)) { logout(); throw new Error('Sessão expirada'); }
  return res;
}

/* --------------------------------------------------------- bootstrap UI --- */
async function boot() {
  $('#logo-slot').innerHTML = m3dLogo(40);
  $('#logo-hero').innerHTML = m3dLogo(88);
  bindAuth(); Account.recovery();
  if (S.token) {
    try { const r = await (await api('/api/me')).json(); if (r.ok) { S.user = r.user; return enterApp(); } }
    catch { /* sem sessão válida */ }
  }
  showAuth();
  api('/api/meta').then((r) => r.json()).then((m) => {
    if (m && m.stats) { S.meta = m; paintAuthStats(); }
  }).catch(() => { paintAuthStats(); });
}
document.addEventListener('DOMContentLoaded', boot);

function showAuth() {
  $('#view-auth').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  $('#nav').classList.add('hidden'); $('#user-chip').classList.add('hidden');
  paintAuthStats();
}
function paintAuthStats() {
  const st = S.meta && S.meta.stats;
  $('#auth-stats').innerHTML = [
    ['Estações', st ? st.stations : '—'],
    ['Usuários', st ? st.users : '—'],
    ['Salas abertas', st ? st.rooms_open : '—'],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
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
  Rooms.leave(false);
  api('/api/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('m3d_token'); S.token = ''; S.user = null; S.room=null; S.station=null; S.messages=[]; S.marks={}; S.tab='dash';
  $$('#view-app .panel').forEach(p=>p.innerHTML='');
  showAuth();
}

/* -------------------------------------------------------------- shell --- */
function enterApp() {
  $('#view-auth').classList.add('hidden'); $('#view-app').classList.remove('hidden');
  $('#nav').classList.remove('hidden'); $('#user-chip').classList.remove('hidden');
  renderNav(); renderUserChip(); connectSocket(); go('dash');
}

let coachHandler = null;
function renderNav() {
  const tabs = [
    ['dash', 'Painel'], ['rooms', 'Salas OSCE'], ['catalog', 'Catálogo'],
    ['srs', 'SRS'], ['cards', 'Flowcards'], ['peps', 'PEPs'], ['analytics', 'Desempenho'], ['profile', 'Perfil'],
  ];
  if (['root', 'admin'].includes(S.user.role)) tabs.push(['admin', 'Admin']);
  if (coachHandler) document.removeEventListener('keydown', coachHandler);
  coachHandler = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return;
    if(S.tab === 'srs') return;
    if (/^[1-9]$/.test(e.key)) { const t = tabs[+e.key - 1]; if (t) go(t[0]); }
  };
  document.addEventListener('keydown', coachHandler);
  $('#nav').innerHTML = tabs.map(([k, l]) => `<button class="navbtn ${S.tab === k ? 'active' : ''}" data-k="${k}">${l}</button>`).join('');
  $$('#nav .navbtn').forEach((b) => b.onclick = () => go(b.dataset.k));
}
function renderUserChip() {
  $('#user-chip').className = 'flex items-center gap-2';
  $('#user-chip').innerHTML = `
    <span class="tag">${esc(S.user.avatar || '🩺')} ${esc(S.user.name)} · ${esc(S.user.role)}</span>
    <button class="btn-ghost" id="btn-logout">Sair</button>`;
  $('#btn-logout').onclick = logout;
}

function go(tab) {
  if(S.tab === 'room' && tab !== 'room') Rooms.leave(false);
  S.tab = tab; renderNav(); window.scrollTo({top:0,behavior:'instant'});
  $$('#view-app .panel').forEach((p) => p.classList.add('hidden'));
  const map = { dash: renderDash, rooms: renderRoomsList, room: renderRoomView, catalog: renderCatalog,
    srs: renderSrs, cards: renderCards, peps: renderPeps, analytics: renderAnalytics, admin: renderAdmin, profile: Account.profile };
  Promise.resolve((map[tab] || renderDash)()).catch(e=>toast(e.message,5000));
  const el = $(`#panel-${tab}`); if (el) el.classList.remove('hidden');
}

/* --------------------------------------------------------------- socket --- */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.socket = io({ auth: { token: S.token }, transports: ['websocket'] });
  Rooms.attachSocket(); Account.attachSocket();
  const badge = $('#conn-badge');
  if (S.socket.connected) { badge.textContent = 'online'; badge.className = 'badge on'; }
  S.socket.on('connect', () => { badge.textContent = 'online'; badge.className = 'badge on'; });
  S.socket.on('disconnect', () => { badge.textContent = 'offline'; badge.className = 'badge err'; });
  S.socket.on('chat:message', onChat);
  S.socket.on('room:participants', ({ participants }) => { S.participants = participants; if (S.tab === 'room') updateParticipants(); });
  S.socket.on('room:mark', ({ station_id, candidate_id, item_idx, value }) => {
    const key = `${station_id}:${candidate_id}:${item_idx}`;
    S.marks[key] = value; if (S.tab === 'room') updateMarks();
  });
  S.socket.on('room:station', () => Rooms.refresh());
  S.socket.on('room:timer', ({ timer }) => { if (S.room) { S.room.timer = timer; updateTimer(); } });
  S.socket.on('room:closed', () => { toast('Sala encerrada pelo criador.'); Rooms.leave(); });
}

/* --------------------------------------------------------------- painel --- */
async function renderDash() { return Account.dashboard(); }
const stat = (k, v) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`;
function renderAreaBar(a) {
  const c = (S.meta.area_colors || {})[a.area] || '#0d9488';
  const label = (S.meta.area_labels || {})[a.area] || a.area;
  return `<div><div class="flex justify-between text-[12.5px] font-bold"><span>${esc(label)}</span><span>${a.avg_pct || 0}% · ${a.n} PEPs</span></div>
    <div class="bar mt-1"><i style="width:${Math.min(100, a.avg_pct || 0)}%;background:${c}"></i></div></div>`;
}

/* --------------------------------------------------------------- salas --- */
const Rooms = roomUI({S,api,toast,go,esc,$,$$,fmt});
const Account = accountUI({S,api,toast,go,esc,$,$$,renderUserChip,acceptSession});
const renderRoomsList = () => Rooms.roomsList();
const enterRoom = code => Rooms.enter(code);
const renderRoomView = () => Rooms.view();
const updateParticipants = () => Rooms.participants();
const updateMarks = () => Rooms.updateMarks();
const onChat = m => Rooms.chat(m);
const updateTimer = () => Rooms.onTimer(S.room.timer);

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
          <input id="st-year" class="inp" placeholder="Ano (se informado)" style="width:150px"/>
          <input id="st-exam" class="inp" placeholder="Prova (se informada)" style="width:170px"/>
          <a class="btn-ghost" href="/api/stations/export.xlsx?token=${S.token}">Export XLSX</a>
          <a class="btn-ghost" href="/api/stations/export.json?token=${S.token}">Export JSON</a>
          ${canImport ? `<label class="btn-primary" style="cursor:pointer">Importar XLSX/JSON<input id="imp" type="file" accept=".xlsx,.json" hidden/></label>
                        <button class="btn-ghost" id="ai-gen">Gerar por IA</button>` : ''}
        </div>
      </div>
      <div id="catgrid" class="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3"></div>
    </div>`;
  const paint = () => {
    const q = $('#st-q').value.toLowerCase(); const a = $('#st-area').value;
    const year=$('#st-year').value.trim(),exam=$('#st-exam').value.toLowerCase();
    const rows = S.stations.filter((s) => (!year || s.ano === year) && (!exam || (s.prova || '').toLowerCase().includes(exam)) && (!a || s.area === a) && (!q || (s.tema + ' ' + s.especialidade).toLowerCase().includes(q)));
    $('#catgrid').innerHTML = rows.map((s) => {
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
  $('#st-q').oninput = paint; $('#st-area').onchange = paint; $('#st-year').oninput=paint; $('#st-exam').oninput=paint;
  if (canImport) {
    $('#imp').onchange = async (e) => {
      const fd = new FormData(); fd.append('file', e.target.files[0]);
      const r = await (await api('/api/stations/import', { method: 'POST', body: fd })).json();
      if (!r.ok) return toast(r.error);
      toast(`Importação: ${r.imported} novas, ${r.updated} atualizadas.`); renderCatalog();
    };
    $('#ai-gen').onclick = () => {
      $('#catgrid').insertAdjacentHTML('afterbegin',`<form id="ai-station-form" class="card"><h3 class="font-bold">Novo rascunho educacional por IA</h3><label class="fld">Tema<input name="tema" class="inp" required></label><label class="fld">Área<select name="area" class="inp">${['CM','CIR','GO','PED','MFC'].map(a=>`<option>${a}</option>`).join('')}</select></label><label class="fld">Complexidade<select name="nivel" class="inp"><option>básico</option><option>intermediário</option><option>avançado</option></select></label><p>Resultado exige revisão médica e verificação das referências. Não é prova oficial do INEP.</p><button class="btn-primary">Gerar rascunho</button></form>`);
      $('#ai-station-form').onsubmit=async e=>{e.preventDefault();const r=await(await api('/api/ai/station',{method:'POST',body:Object.fromEntries(new FormData(e.target))})).json();if(!r.ok)return toast(r.error);toast(`Rascunho gerado via ${r.provider}. Revise antes do uso.`);renderCatalog();};
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
let srsKeys=null;
function startSrsSession() {
  if(srsKeys)document.removeEventListener('keydown',srsKeys);
  const due = (S.srs.cards || []).filter((c) => c.due);
  const box = $('#srs-session');
  if (!due.length) { box.innerHTML = '<p class="text-mut">Sem cards devidos. 🎉</p>'; return; }
  let idx = 0, revealed = false;
  const paint = () => {
    const c = due[idx];
    box.innerHTML = `
      <div class="srscard" id="flip"><div class="text-xs text-mut">frente ${idx + 1}/${due.length}</div>
        <div class="mt-2 font-bold">${esc(c.front)}</div><p class="text-xs">Estação: ${esc(c.tema || c.station_id)}</p><button class="btn-ghost" id="srs-station">Estudar estação associada</button>
        ${revealed ? `<hr class="my-3" style="border-color:var(--line)"/><div>${esc(c.back)}</div>` : ''}</div>
      ${revealed ? `<div class="flex gap-2 mt-3 flex-wrap">
        ${[['errei', 0], ['difícil', 1], ['bom', 2], ['fácil', 3]].map(([l, q]) => `<button class="btn-ghost rate" data-q="${q}">${l}</button>`).join('')}
      </div>` : '<p class="text-mut text-sm mt-2">Clique no card para revelar.</p>'}`;
    $('#flip').onclick = () => { revealed = true; paint(); };
    $('#srs-station').onclick = async e => {e.stopPropagation();const r=await(await api('/api/rooms',{method:'POST',body:{station_ids:[c.station_id],study_mode:1,name:'Estudo SRS'}})).json();if(!r.ok)return toast(r.error);enterRoom(r.room.code);};
    $$('.rate').forEach((b) => b.onclick = async () => {
      await api(`/api/srs/${c.id}/review`, { method: 'POST', body: { quality: +b.dataset.q } });
      idx++; revealed = false;
      if (idx >= due.length) { toast('Sessão concluída.'); renderSrs(); } else paint();
    });
  };
  srsKeys = e => {if(S.tab !== 'srs' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;if(e.key === ' '){e.preventDefault();$('#flip')?.click();}if(/^[1-4]$/.test(e.key))$$('.rate')[+e.key-1]?.click();}; document.addEventListener('keydown',srsKeys);
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
  const items = p.items.map((it) => `<li class="${it.marcado ? '' : 'text-coral'}">${it.marcado ? '✔' : '✘'} ${esc(it.item)}${it.anulado?' <b>(anulado)</b>':''} ${it.justificativa?`<p>${esc(it.justificativa)}</p>`:''}${it.citacao?`<blockquote>“${esc(it.citacao)}”</blockquote>`:''} <span class="text-mut">(peso ${it.peso})</span></li>`).join('');
  $('#pep-detail').innerHTML = `
    <div class="card">
      <h4 class="font-black text-deep">PEP #${p.id} — ${p.score}/${p.max_score} (${p.pct}%)</h4>
      <ul class="list-none mt-2 text-[13.5px] space-y-1">${items}</ul>${p.transcript?`<details class="mt-3"><summary class="font-bold">Transcrição registrada</summary><pre class="pre">${esc(p.transcript)}</pre></details>`:''}
      ${ai ? `<div class="mt-3 border-t pt-2" style="border-color:var(--line)">
        <h5 class="font-bold">Correção IA</h5>
        <p class="text-sm"><b>Comentário:</b> ${esc(ai.comentario || '')}</p>
        <p class="text-sm"><b>Pontos fortes:</b> ${(ai.pontos_fortes || []).map(esc).join('; ')}</p>
        <p class="text-sm"><b>Lacunas:</b> ${(ai.lacunas || []).map(esc).join('; ')}</p>
      </div>` : `<p class="text-xs text-mut mt-2">IA: ${esc(p.ai_status)}</p>`}
      <div class="mt-3 flex gap-2 flex-wrap">
        <button class="btn-ghost" id="srs-from-pep">Gerar SRS do que faltou</button>
        ${p.evaluator_id===0?'<button class="btn-primary" id="dispute">Contestar itens</button>':''}<button class="btn-ghost" id="print-pep">Imprimir / salvar PDF</button>
      </div>
      <div id="disputes" class="mt-3">${(r.disputes || []).map((d) => `
        <div class="border rounded-xl p-3 mt-2" style="border-color:var(--line)">
          <div class="flex justify-between"><b>${esc(d.by_name)}</b><span class="tag">${esc(d.status)}</span></div>
          <p class="text-sm">${esc(d.reason)}</p>
          ${d.ai ? `<p class="text-sm text-mut">IA: ${esc(d.ai.parecer || '')} — ${esc(d.ai.justificativa || '')}</p>` : ''}
        </div>`).join('')}</div>
    </div>`;
  $('#srs-from-pep').onclick = async () => {
    try {
      const r2 = await (await api(`/api/srs/from-pep/${p.id}`, { method: 'POST', body: {} })).json();
      if (!r2.ok) return toast(r2.error || 'Falha ao gerar cards.');
      toast(r2.created ? `${r2.created} card(s) SRS criados a partir das lacunas.` : 'Nada a criar — nenhum item faltou.');
    } catch { toast('Falha ao gerar cards SRS.'); }
  };
  $('#print-pep').onclick = () => { document.body.classList.add('printing-pep'); window.print(); document.body.classList.remove('printing-pep'); };
  if($('#dispute')) $('#dispute').onclick = async () => {
    const reason = prompt('Descreva o motivo da disputa:'); if (!reason) return;
    const r2 = await (await api(`/api/peps/${p.id}/dispute`, { method: 'POST', body: { reason, item_indices: (prompt('Índices dos itens contestados (0,1,2...), separados por vírgula:') || '').split(',').filter(x=>x.trim()).map(Number) } })).json();
    if (!r2.ok) return toast(r2.error);
    toast('Disputa aberta — IA analisará.'); openPep(id);
  };
}

/* --------------------------------------------------------- analytics ----- */
async function renderAnalytics() {
  const r = await (await api('/api/analytics')).json();
  $('#panel-analytics').innerHTML = `
    <div class="card mb-4"><h3 class="font-bold">Resumo de desempenho</h3><p>${r.kpis.treinos} treinos · ${r.kpis.media}% de média · ${Math.round(r.kpis.tempo/60)} min · ${r.kpis.estacoes} estações · ${r.srs.total} revisões SRS</p><div class="doughnut" style="--pct:${r.kpis.media}%" role="img" aria-label="Média ${r.kpis.media}%"><b>${r.kpis.media}%</b></div><button id="coach-plan" class="btn-primary">Gerar plano de 7 dias</button><pre id="coach-result" class="pre"></pre></div>
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card"><h3 class="font-black text-deep">Desempenho por área</h3>
        <div class="mt-3 space-y-2">${(r.by_area || []).map(renderAreaBar).join('') || '<p class="text-mut">Sem PEPs ainda.</p>'}</div></div>
      <div class="card"><h3 class="font-black text-deep">PEPs recentes</h3>
        <table class="tbl mt-2"><thead><tr><th>Tema</th><th>Área</th><th>%</th><th>Data</th></tr></thead>
        <tbody>${(r.recent || []).map((p) => `<tr><td>${esc(p.tema || '-')}</td><td>${esc(p.area || '-')}</td><td><b>${p.pct}%</b></td>
          <td class="text-xs text-mut">${new Date(+p.created_at).toLocaleString('pt-BR')}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  $('#coach-plan').onclick=async()=>{const r=await(await api('/api/ai/coach',{method:'POST',body:{}})).json();if(!r.ok)return toast(r.error);$('#coach-result').textContent=r.plan;};
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
  await Account.adminExtras();
}
