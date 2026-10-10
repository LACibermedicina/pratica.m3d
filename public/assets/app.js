/* =============================================================================
   pratica.M3D v5 — SPA (JavaScript sem build)
   Parte 1/2: núcleo, autenticação, painel, catálogo, importação/exportação,
              administração, perfil, analytics e cards de procedimento (biblioteca).
   ============================================================================= */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  token: localStorage.getItem('m3d_token') || '',
  user: null,
  tab: 'dash',
  meta: { area_labels: {}, area_colors: {}, stats: {} },
  rooms: [],
  room: null,
  stations: [],
  catsel: [],
  srs: [],
  es: null,          // EventSource (tempo real)
  since: 0,
  peer: null,
  peers: {},         // peer_id -> {pc, stream, el, name, role, polite}
  local: null,
  chatScope: 'room',
  timer: null,
  events: [],
  markState: {},
  disp: {},
  live: false,
};

/* ------------------------------------------------------------------ helpers -- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nl(s) { return esc(s).replace(/\n/g, '<br>'); }
function hhmmss(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function toast(msg, kind = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = esc(msg);
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(24px)'; }, ms - 350);
  setTimeout(() => el.remove(), ms);
}

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  let body = opts.body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
  let data = null;
  try { data = await res.json(); } catch (_) { data = { ok: false, error: 'Resposta inválida do servidor (' + res.status + ')' }; }
  if (res.status === 401 && S.token && !opts.silent) { logout(true); }
  if (!res.ok || data.ok === false) {
    const msg = (data && (data.error || data.message)) || ('Erro HTTP ' + res.status);
    if (!opts.silent) toast(msg, 'err', 6500);
    throw Object.assign(new Error(msg), { data });
  }
  return data;
}

/* ================================ AUTENTICAÇÃO ================================ */
function setToken(t) {
  S.token = t || '';
  if (t) localStorage.setItem('m3d_token', t); else localStorage.removeItem('m3d_token');
}

function logout(silent) {
  if (!silent) api('/api/logout', { method: 'POST', silent: true }).catch(() => {});
  stopRealtime();
  setToken('');
  S.user = null;
  window.rtc?.stop();
  $('#view-auth').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  $$('#topbar .btn, #mainnav, #userChip, #clockBadge, #aiBadge, #liveBadge').forEach(e => e.classList.add('hidden'));
  $$('#mainnav .navbtn').forEach(b => b.classList.add('hidden'));
  tailwindRefresh();
}

function showApp() {
  $('#view-auth').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#userChip').classList.remove('hidden');
  $('#userChip').classList.add('flex');
  $('#userName').textContent = S.user.name.split(' ')[0];
  $('#userAvatar').textContent = S.user.avatar || '🩺';
  $('#btnLogout').classList.remove('hidden');
  $('#btnMenu').classList.remove('hidden');
  buildNav();
  go(S.tab || 'dash');
}

const NAV = [
  ['dash', '🏠 Painel'],
  ['cat', '📚 Catálogo'],
  ['lobby', '🎥 Salas'],
  ['srs', '🧠 Cards de revisão'],
  ['lib', '🗂️ Meus cards'],
  ['kpi', '📊 Desempenho'],
  ['admin', '🛡️ Gestão', ['root', 'admin']],
  ['perfil', '⚙️ Perfil'],
];

function buildNav() {
  const nav = $('#mainnav');
  nav.classList.remove('hidden');
  nav.innerHTML = NAV
    .filter(n => !n[2] || n[2].includes(S.user.role))
    .map(([k, label]) => `<button class="navbtn" data-tab="${k}">${label}</button>`).join('');
  $$('#mainnav .navbtn').forEach(b => b.onclick = () => go(b.dataset.tab));
  markNav();
}
function markNav() {
  $$('#mainnav .navbtn').forEach(b => b.classList.toggle('is-on', b.dataset.tab === S.tab));
}
function tailwindRefresh() { /* CDN do Tailwind já observa o DOM */ }

function go(tab) {
  S.tab = tab;
  markNav();
  $$('#mainnav .navbtn').forEach(b => b.classList.toggle('is-on', b.dataset.tab === tab));
  const host = $('#tabhost');
  host.innerHTML = '<div class="card">Carregando…</div>';
  ({ dash: viewDash, cat: viewCat, lobby: viewLobby, srs: viewSrs, lib: viewLib,
     kpi: viewKpi, admin: viewAdmin, perfil: viewPerfil }[tab] || viewDash)()
    .catch(e => { host.innerHTML = `<div class="card text-coral font-bold">Falha ao abrir a aba: ${esc(e.message)}</div>`; });
}

/* ==================================== PAINEL ================================== */
async function viewDash() {
  const d = await api('/api/analytics');
  const rooms = (await api('/api/rooms')).rooms;
  S.rooms = rooms;
  const k = d.kpis;
  const live = rooms.filter(r => r.live);

  $('#tabhost').innerHTML = `
  <div class="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
    <div class="card raise">
      <div class="flex items-center gap-3">
        <span class="text-[12px] font-black text-mut">OLÁ, ${esc(S.user.name.toUpperCase())}</span>
        <span class="badge teal ml-auto">${esc(S.user.role)}</span>
      </div>
      <h2 class="mt-1 text-[21px] font-black text-deep">Seu painel de treino</h2>
      <p class="text-[12.5px] text-mut">Reorganize os quadros arrastando; a disposição fica salva no seu perfil.</p>
      <div id="kpiGrid" class="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        ${kpi('Treinos concluídos', k.treinos, '🎯')}
        ${kpi('Nota média', k.media + '%', '⭐')}
        ${kpi('Tempo acumulado', k.tempo_min + ' min', '⏱')}
        ${kpi('Catálogo de estações', k.estacoes_catalogo, '📚')}
        ${kpi('Salas criadas', k.salas, '🚪')}
        ${kpi('Usuários', k.usuarios, '👥')}
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button class="btn" id="dashNew">＋ Criar sala de treino</button>
        <button class="btn ghost" id="dashCat">Explorar catálogo</button>
        <button class="btn violet" id="dashSrs">Revisar cards de hoje</button>
        <button class="btn sky" id="dashKpi">Ver desempenho</button>
      </div>
    </div>

    <div class="card raise">
      <div class="flex items-center gap-2">
        <h3 class="text-[15px] font-black text-deep">Salas ao vivo</h3>
        ${live.length ? `<span class="badge coral"><span class="live-dot"></span> ${live.length} ao vivo</span>` : '<span class="badge gray">nenhuma</span>'}
        <button class="btn ghost sm ml-auto" id="dashReload">↻</button>
      </div>
      <div id="dashRooms" class="mt-3 space-y-2 max-h-[330px] scroll-y">
        ${rooms.length ? rooms.map(r => roomRow(r)).join('') : '<p class="hint">Nenhuma sala ainda. Crie a primeira com uma estação selecionada.</p>'}
      </div>
    </div>
  </div>

  <div class="grid gap-4 lg:grid-cols-2 mt-4">
    <div class="card raise">
      <h3 class="text-[15px] font-black text-deep">Aproveitamento por grande área</h3>
      <div class="bars mt-2">${d.bars.map(b => `
        <div class="col">
          <span class="text-[11px] font-black" style="color:${b.color}">${b.media}%</span>
          <div class="bar" style="height:${Math.max(3, b.media)}%;background:linear-gradient(180deg,${b.color}cc,${b.color})"></div>
          <span class="badge area" style="color:${b.color}">${b.area}</span>
        </div>`).join('')}</div>
    </div>
    <div class="card raise">
      <h3 class="text-[15px] font-black text-deep">Desempenho global</h3>
      <div class="mt-3 flex items-center gap-5 flex-wrap">
        <div class="donut" style="--p:${d.donut.global}"><b>${d.donut.global}%</b></div>
        <div class="text-[12.5px] space-y-1">
          <p><b>${k.treinos}</b> estações avaliadas · <b>${k.media}%</b> de média</p>
          <p class="text-mut">Barras por grande área e rosca global usam apenas o seu histórico (admins veem o de todos).</p>
          <button class="btn ghost sm" id="dashCoach">🤖 Diagnóstico do coach</button>
        </div>
      </div>
      <div id="coachOut" class="mt-3 hidden rounded-xl border border-line bg-white p-3 text-[12.5px] leading-relaxed"></div>
    </div>
  </div>

  <div class="card mt-4">
    <h3 class="text-[15px] font-black text-deep">Últimos treinos</h3>
    <div class="mt-2 overflow-x-auto">
      <table class="tb"><thead><tr><th>Estação</th><th>Área</th><th>Nota</th><th>Quando</th></tr></thead>
      <tbody>${(d.ultimos || []).map(u => `<tr><td>${esc(u.tema || '—')}</td>
        <td><span class="badge area" style="color:${areaColor(u.area)}">${esc(u.area || '')}</span></td>
        <td><b>${u.score}%</b></td><td class="text-mut">${new Date((u.at || 0) * 1000).toLocaleString('pt-BR')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="text-mut">Sem treinos registrados.</td></tr>'}</tbody></table>
    </div>
  </div>`;

  $$('#kpiGrid .kpi').forEach(el => { el.draggable = true; });
  enableDrag('#kpiGrid');
  $('#dashNew').onclick = () => go('lobby');
  $('#dashCat').onclick = () => go('cat');
  $('#dashSrs').onclick = () => go('srs');
  $('#dashKpi').onclick = () => go('kpi');
  $('#dashReload').onclick = () => go('dash');
  $('#dashRooms').onclick = e => {
    const b = e.target.closest('[data-join]');
    if (b) { S.pendingJoin = b.dataset.join; go('lobby'); }
  };
  $('#dashCoach').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = '🤖 analisando…';
    try {
      const r = await api('/api/ai/coach', { method: 'POST' });
      const out = $('#coachOut');
      out.classList.remove('hidden');
      out.innerHTML = `<div class="text-[11px] font-black text-mut mb-1">PROVEDOR: ${esc((r.provider || 'local').toUpperCase())}</div>`
        + mdLite(r.coach);
    } finally { ev.target.disabled = false; ev.target.textContent = '🤖 Diagnóstico do coach'; }
  };
}

function kpi(label, val, icon) {
  return `<div class="kpi cursor-grab"><b>${esc(val)}</b><span>${icon} ${esc(label)}</span></div>`;
}
function areaColor(a) { return (S.meta.area_colors || {})[a] || '#0d9488'; }
function areaLabel(a) { return (S.meta.area_labels || {})[a] || a; }

function roomRow(r) {
  return `<div class="flex items-center gap-2 rounded-xl border border-line bg-white/90 p-2.5">
    <span class="text-[17px]">${r.rtype === 'ai' ? '🤖' : '👥'}</span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        <b class="text-[13px] truncate">${esc(r.name)}</b>
        ${r.live ? '<span class="badge coral"><span class="live-dot"></span>ao vivo</span>' : '<span class="badge gray">vazia</span>'}
        ${r.open ? '<span class="badge teal">aberta</span>' : '<span class="badge amber">fechada</span>'}
        ${r.study_mode ? '<span class="badge violet">modo estudo</span>' : ''}
      </div>
      <div class="text-[11px] text-mut">código <b>${esc(r.code)}</b> · ${r.station_ids.length} estação(ões) · ${r.membros} na sala · por ${esc(r.creator_name)}</div>
    </div>
    <button class="btn sm" data-join="${esc(r.code)}">Entrar</button>
    ${r.mine || ['root', 'admin'].includes(S.user.role) ? `<button class="btn coral sm" data-del="${esc(r.code)}">Encerrar</button>` : ''}
  </div>`;
}

function mdLite(t) {
  return esc(t)
    .replace(/^### (.*)$/gm, '<b class="block mt-2 text-deep">$1</b>')
    .replace(/^## (.*)$/gm, '<b class="block mt-2 text-deep">$1</b>')
    .replace(/^\s*[-*] (.*)$/gm, '• $1<br>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/_(.+?)_/g, '<i>$1</i>')
    .replace(/\n/g, '<br>');
}

function enableDrag(sel, onDrop) {
  let src = null;
  $$(sel + ' > *').forEach(el => {
    el.ondragstart = () => { src = el; el.style.opacity = '.45'; };
    el.ondragend = () => { el.style.opacity = '1'; src = null; saveLayout(sel); };
    el.ondragover = e => { e.preventDefault(); el.classList.add('flash-ok'); };
    el.ondragleave = () => el.classList.remove('flash-ok');
    el.ondrop = e => {
      e.preventDefault(); el.classList.remove('flash-ok');
      if (!src || src === el) return;
      const kids = Array.from(el.parentNode.children);
      if (kids.indexOf(src) < kids.indexOf(el)) el.after(src); else el.before(src);
      if (onDrop) onDrop();
    };
  });
}
async function saveLayout(sel) {
  const order = $$(sel + ' > *').map(e => e.querySelector('span')?.textContent || '');
  try {
    S.user.layout = Object.assign({}, S.user.layout, { [sel]: order });
    await api('/api/profile', { method: 'POST', body: { layout: S.user.layout }, silent: true });
  } catch (_) {}
}

/* =================================== CATÁLOGO ================================= */
async function viewCat() {
  const boot = await api('/api/stations?limit=1');
  S.meta.area_labels = boot.area_labels; S.meta.area_colors = boot.area_colors;
  $('#tabhost').innerHTML = `
  <div class="card">
    <div class="flex flex-wrap items-end gap-2">
      <div><label class="fl">Buscar</label><input id="catQ" class="in w-[260px]" placeholder="tema, especialidade, fonte…"></div>
      <div><label class="fl">Nível</label><select id="catN" class="sel w-[150px]">
        <option value="">todos</option><option>básico</option><option>intermediário</option><option>avançado</option></select></div>
      <div><label class="fl">Ordenar</label><select id="catS" class="sel w-[150px]">
        <option value="">Área + tema</option><option value="tema">Tema</option><option value="nivel">Nível</option></select></div>
      <button class="btn ml-auto" id="catSearch">🔎 Buscar</button>
      <button class="btn ghost" id="catSelAll">Selecionar página</button>
      <button class="btn violet" id="catNew">🤖 Gerar estação por IA</button>
    </div>
    <div id="catChips" class="mt-3 flex flex-wrap gap-1.5"></div>
    <div id="catStats" class="mt-2 text-[11.5px] text-mut"></div>
  </div>

  <div class="grid gap-4 lg:grid-cols-[1.6fr_1fr] mt-4">
    <div class="card">
      <div id="catList" class="space-y-2 max-h-[640px] scroll-y"></div>
      <div class="mt-3 flex items-center gap-2">
        <button class="btn ghost sm" id="catPrev">← anterior</button>
        <span id="catPage" class="text-[12px] font-black text-mut"></span>
        <button class="btn ghost sm" id="catNext">próxima →</button>
      </div>
    </div>
    <div class="space-y-4">
      <div class="card">
        <div class="flex items-center gap-2">
          <h3 class="text-[15px] font-black text-deep">Selecionadas</h3>
          <span id="selCount" class="badge teal">0</span>
          <button class="btn ghost sm ml-auto" id="selClear">limpar</button>
        </div>
        <div id="selList" class="mt-2 space-y-1.5 max-h-[230px] scroll-y text-[12.5px]"></div>
        <button class="btn w-full mt-3" id="selCreate">🎥 Criar sala com a seleção</button>
        <p class="hint mt-1">Regra da estação: não é possível abrir sala sem ao menos uma estação selecionada.</p>
      </div>
      <div class="card">
        <h3 class="text-[15px] font-black text-deep">Importar / exportar (XLSX · JSON)</h3>
        <div class="dz mt-2" id="dz">
          <b class="text-[13.5px]">Arraste a planilha .xlsx aqui</b>
          <p class="hint">aba “Estações” · cabeçalho flexível (tema, area, roteiro_ator, checklist…)</p>
          <input type="file" id="fileXlsx" class="hidden" accept=".xlsx,.xls,.json,.csv">
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          <button class="btn sm" id="pickFile">📄 Escolher arquivo</button>
          <button class="btn ghost sm" id="expAll">⬇ Exportar todas</button>
          <button class="btn ghost sm" id="expSel">⬇ Exportar seleção</button>
          <button class="btn ghost sm" id="syncXlsx">🔄 Sincronizar data/estacoes.xlsx</button>
        </div>
        <label class="flex items-center gap-2 mt-2 text-[12px] font-bold"><input type="checkbox" id="ovw"> sobrescrever ids existentes (overwrite)</label>
        <div id="impOut" class="mt-2 hidden rounded-xl border border-line bg-white p-3 text-[12px]"></div>
      </div>
    </div>
  </div>`;

  S.catPage = 0;
  $('#catSearch').onclick = () => { S.catPage = 0; loadCat(); };
  $('#catQ').onkeydown = e => { if (e.key === 'Enter') { S.catPage = 0; loadCat(); } };
  $('#catN').onchange = () => loadCat();
  $('#catPrev').onclick = () => { S.catPage = Math.max(0, S.catPage - 1); loadCat(); };
  $('#catNext').onclick = () => { S.catPage++; loadCat(); };
  $('#catSelAll').onclick = () => { S.stations.forEach(s => { if (!S.catsel.includes(s.id)) S.catsel.push(s.id); }); renderSel(); renderCatList(); };
  $('#selClear').onclick = () => { S.catsel = []; renderSel(); renderCatList(); };
  $('#selCreate').onclick = () => { if (!S.catsel.length) return toast('Selecione ao menos uma estação', 'err'); S.prefill = S.catsel.slice(); go('lobby'); };
  $('#catNew').onclick = openGenStation;
  $('#pickFile').onclick = () => $('#fileXlsx').click();
  $('#fileXlsx').onchange = e => e.target.files[0] && importFile(e.target.files[0]);
  const dz = $('#dz');
  dz.onclick = () => $('#fileXlsx').click();
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) importFile(f); });
  $('#expAll').onclick = () => downloadExport('/api/stations/export');
  $('#expSel').onclick = () => S.catsel.length
    ? downloadExport('/api/stations/export?ids=' + encodeURIComponent(S.catsel.join(',')))
    : toast('Selecione estações para exportar', 'err');
  $('#syncXlsx').onclick = async () => {
    const r = await api('/api/stations/sync', { method: 'POST' });
    toast(r.created + ' criadas · ' + r.updated + ' atualizadas · ' + r.skipped + ' ignoradas');
    loadCat();
  };
  renderSel();
  await loadCat();
}

function renderChips(byArea) {
  const total = Object.values(byArea || {}).reduce((a, b) => a + b, 0);
  const chips = [`<button class="navbtn is-on" data-area="">Todas (${total})</button>`]
    .concat(Object.keys(byArea || {}).sort().map(a =>
      `<button class="navbtn" data-area="${a}" style="color:${areaColor(a)}">${a} · ${byArea[a]}</button>`));
  $('#catChips').innerHTML = chips.join('');
  $$('#catChips .navbtn').forEach(b => b.onclick = () => {
    $$('#catChips .navbtn').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on');
    S.catArea = b.dataset.area; S.catPage = 0; loadCat();
  });
  if (S.catArea) $$('#catChips .navbtn').forEach(b => b.classList.toggle('is-on', b.dataset.area === S.catArea));
}

async function loadCat() {
  const limit = 40;
  const p = new URLSearchParams({
    limit: String(limit), offset: String(S.catPage * limit),
    q: $('#catQ').value.trim(), nivel: $('#catN').value, area: S.catArea || '',
  });
  const d = await api('/api/stations?' + p.toString());
  S.stations = d.stations;
  renderChips(d.by_area);
  renderCatList();
  $('#catPage').textContent = `página ${S.catPage + 1} · ${d.total} estação(ões)`;
  $('#catStats').textContent = d.total + ' estações no acervo — filtros por grande área (CM/CIR/GO/PED/MFC), nível e texto.';
}

function renderCatList() {
  $('#catList').innerHTML = S.stations.map(s => `
    <div class="rounded-xl border ${S.catsel.includes(s.id) ? 'border-teal2 flash-ok' : 'border-line'} bg-white/92 p-2.5">
      <div class="flex items-start gap-2">
        <button class="btn ${S.catsel.includes(s.id) ? '' : 'ghost'} sm" data-sel="${esc(s.id)}">${S.catsel.includes(s.id) ? '☑' : '☐'}</button>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="badge area" style="color:${s.area_color}">${s.area}</span>
            <span class="badge gray">${esc(s.nivel)}</span>
            <span class="badge teal">${s.duracao} min</span>
            ${s.frozen ? '<span class="badge coral">congelada · revisão</span>' : ''}
          </div>
          <b class="block text-[13.2px] mt-1 leading-snug">${esc(s.tema)}</b>
          <div class="text-[11px] text-mut">${esc(s.especialidade || '—')} · fonte: ${esc(s.fonte || 'interno')}</div>
        </div>
        <div class="flex flex-col gap-1">
          <button class="btn ghost sm" data-open="${esc(s.id)}">👁 ver</button>
          <button class="btn violet sm" data-card="${esc(s.id)}">🗂️ card</button>
        </div>
      </div>
    </div>`).join('') || '<p class="hint">Nada encontrado com esses filtros.</p>';

  $$('#catList [data-sel]').forEach(b => b.onclick = () => {
    const id = b.dataset.sel, i = S.catsel.indexOf(id);
    if (i >= 0) S.catsel.splice(i, 1); else S.catsel.push(id);
    renderSel(); renderCatList();
  });
  $$('#catList [data-open]').forEach(b => b.onclick = () => openStation(b.dataset.open));
  $$('#catList [data-card]').forEach(b => b.onclick = () => makeCard(b.dataset.card));
}

function renderSel() {
  $('#selCount').textContent = S.catsel.length;
  $('#selList').innerHTML = S.catsel.map(id => {
    const s = S.stations.find(x => x.id === id) || { tema: id, area: '' };
    return `<div class="flex items-center gap-2 rounded-lg border border-line bg-white px-2 py-1">
      <span class="badge area" style="color:${areaColor(s.area)}">${esc(s.area)}</span>
      <span class="truncate flex-1">${esc(s.tema)}</span>
      <button class="text-coral font-black" data-rm="${esc(id)}">✕</button></div>`;
  }).join('') || '<p class="hint">Nenhuma estação selecionada.</p>';
  $$('#selList [data-rm]').forEach(b => b.onclick = () => {
    S.catsel = S.catsel.filter(x => x !== b.dataset.rm); renderSel(); renderCatList();
  });
}

async function openStation(id) {
  const d = await api('/api/stations/' + encodeURIComponent(id));
  const s = d.station;
  const ck = (s.checklist || []).map((c, i) => `<li><b>${i + 1}.</b> ${esc(c.item)} <span class="badge amber">peso ${esc(c.peso ?? 1)}</span></li>`).join('');
  const ex = (s.exames || []).map(e => `<li>${esc(typeof e === 'string' ? e : (e.nome || e.tipo || JSON.stringify(e)))}</li>`).join('');
  openModal('📚 ' + s.tema, `
    <div class="flex flex-wrap gap-1.5">
      <span class="badge area" style="color:${s.area_color}">${s.area} — ${esc(s.area_label)}</span>
      <span class="badge gray">${esc(s.nivel)}</span><span class="badge teal">${s.duracao} min</span>
      <span class="badge violet">${esc(s.especialidade || '—')}</span>
      <span class="badge amber">fonte: ${esc(s.fonte || 'interno')}</span></div>
    <div class="grid gap-3 md:grid-cols-2 mt-3 text-[12.8px]">
      <div><b class="text-deep">Instruções do candidato</b><p class="mt-1">${nl(s.instrucoes)}</p></div>
      <div><b class="text-deep">Cenário / encontro</b><p class="mt-1">${nl(s.cenario)}</p></div>
      <div class="md:col-span-2"><b class="text-deep">Roteiro do ator (avaliador)</b><p class="mt-1">${nl(s.roteiro_ator)}</p></div>
      <div><b class="text-deep">Protocolo / diretriz</b><p class="mt-1">${nl(s.protocolo || '—')}</p></div>
      <div><b class="text-deep">Exames complementares (${(s.exames || []).length})</b><ul class="mt-1 list-disc pl-5">${ex || '<li class="text-mut">sem exames anexados</li>'}</ul></div>
    </div>
    <div class="mt-3"><b class="text-deep text-[12.8px]">Checklist oficial (PEP) — ${(s.checklist || []).length} itens</b>
      <ol class="mt-1 list-disc pl-5 text-[12.6px] space-y-1">${ck || '<li class="text-mut">sem checklist</li>'}</ol></div>
    <div class="mt-4 flex flex-wrap gap-2">
      <button class="btn" data-act="sel">＋ Adicionar à seleção</button>
      <button class="btn violet" data-act="card">🗂️ Gerar card de procedimento</button>
      <button class="btn ghost" data-act="edit">✏️ Editar (admin)</button>
      ${['root', 'admin'].includes(S.user.role) ? '<button class="btn coral" data-act="del">🗑 Excluir</button>' : ''}
    </div>`, root => {
    root.querySelector('[data-act="sel"]').onclick = () => {
      if (!S.catsel.includes(s.id)) S.catsel.push(s.id);
      closeModal(); renderSel(); if (S.tab === 'cat') renderCatList();
      toast('Estação adicionada à seleção');
    };
    root.querySelector('[data-act="card"]').onclick = () => { closeModal(); makeCard(s.id); };
    root.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
      closeModal();
      openModal('✏️ Editar — ' + s.tema, stationForm(s), r => bindStationForm(r, s.id));
    });
    root.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      if (!confirm('Excluir a estação “' + s.tema + '”?')) return;
      await api('/api/stations/' + encodeURIComponent(s.id), { method: 'DELETE' });
      closeModal(); toast('Estação removida'); loadCat();
    });
  });
}

function stationForm(s) {
  const f = (k, label, v, type = 'in') => `<label class="fl">${label}${type === 'area'
    ? `<textarea class="area" name="${k}">${esc(v || '')}</textarea>`
    : `<input class="in" name="${k}" value="${esc(v || '')}"/>`}</label>`;
  return `<div class="grid gap-3 md:grid-cols-2">
    ${f('tema', 'Tema', s.tema)}${f('especialidade', 'Especialidade', s.especialidade)}
    <label class="fl">Grande área<select class="sel" name="area">${Object.keys(areaLabelMap()).map(a =>
      `<option value="${a}" ${s.area === a ? 'selected' : ''}>${a} — ${esc(areaLabel(a))}</option>`).join('')}</select></label>
    <label class="fl">Nível<select class="sel" name="nivel">${['básico', 'intermediário', 'avançado'].map(n =>
      `<option ${s.nivel === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    ${f('duracao', 'Duração (min)', s.duracao)}
    ${f('fonte', 'Fonte / prova', s.fonte)}
    <div class="md:col-span-2">${f('instrucoes', 'Instruções do candidato', s.instrucoes, 'area')}</div>
    <div class="md:col-span-2">${f('cenario', 'Cenário', s.cenario, 'area')}</div>
    <div class="md:col-span-2">${f('roteiro_ator', 'Roteiro do ator', s.roteiro_ator, 'area')}</div>
    <div class="md:col-span-2">${f('protocolo', 'Protocolo / diretriz', s.protocolo, 'area')}</div>
    <div class="md:col-span-2">${f('checklist', 'Checklist (JSON ou itens separados por ;)', JSON.stringify(s.checklist || []), 'area')}</div>
    <div class="md:col-span-2">${f('exames', 'Exames (JSON ou itens separados por ;)', JSON.stringify(s.exames || []), 'area')}</div>
  </div><div class="mt-4 flex gap-2"><button class="btn" id="stSave">💾 Salvar</button></div>`;
}
function areaLabelMap() { return S.meta.area_labels || {}; }
function bindStationForm(root, id) {
  root.querySelector('#stSave').onclick = async () => {
    const body = {};
    $$('input,select,textarea', root).forEach(el => {
      if (!el.name) return;
      let v = el.value;
      if (el.name === 'checklist' || el.name === 'exames') {
        try { v = JSON.parse(v); } catch (_) { v = String(v).split(/[;|]/).map(x => x.trim()).filter(Boolean); }
      }
      body[el.name] = v;
    });
    await api('/api/stations' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body });
    toast('Estação salva'); closeModal(); loadCat();
  };
}

function openGenStation() {
  openModal('🤖 Gerar estação por IA', `
    <p class="hint">A cadeia de IA (Gemini → OpenAI → Pollinations) cria a estação já padronizada ao INEP/SUS, com roteiro do ator, exames e checklist do PEP.</p>
    <div class="grid gap-3 md:grid-cols-3 mt-3">
      <div class="md:col-span-3"><label class="fl">Tema<input class="in" id="genTema" placeholder="ex.: abdome agudo hemorrágico por gravidez ectópica rota"></label></div>
      <label class="fl">Grande área<select class="sel" id="genArea">${Object.keys(areaLabelMap()).map(a => `<option value="${a}">${a} — ${esc(areaLabel(a))}</option>`).join('')}</select></label>
      <label class="fl">Nível<select class="sel" id="genNivel"><option>básico</option><option selected>intermediário</option><option>avançado</option></select></label>
      <button class="btn self-end" id="genGo">✨ Criar estação</button>
    </div>
    <div id="genOut" class="mt-3"></div>`, root => {
    root.querySelector('#genGo').onclick = async (ev) => {
      const tema = root.querySelector('#genTema').value.trim();
      if (!tema) return toast('Informe o tema', 'err');
      ev.target.disabled = true; ev.target.textContent = '✨ gerando…';
      const out = root.querySelector('#genOut');
      out.innerHTML = '<div class="rounded-xl border border-line bg-white p-3 text-[12.5px]">Consultando a cadeia de IA…</div>';
      try {
        const r = await api('/api/ai/generate_station', {
          method: 'POST', body: { tema, area: root.querySelector('#genArea').value, nivel: root.querySelector('#genNivel').value },
        });
        setAiBadge(r.provider);
        out.innerHTML = `<div class="rounded-xl border border-teal3 bg-teal1/5 p-3 text-[12.5px]">
          <b class="text-deep">Provedor: ${esc(r.provider)}</b>
          <p class="mt-1"><b>${esc(r.station.tema)}</b></p>
          <p class="mt-1">${esc(r.station.instrucoes || '')}</p>
          <p class="mt-1 text-mut">${(r.station.checklist || []).length} itens de PEP · ${(r.station.exames || []).length} exames</p>
          <button class="btn sm mt-2" data-open="${esc(r.station_id)}">👁 Abrir e revisar</button></div>`;
        out.querySelector('[data-open]').onclick = () => { closeModal(); openStation(r.station_id); };
        toast('Estação criada por IA'); loadCat();
      } catch (e) {
        out.innerHTML = `<div class="rounded-xl border border-coral bg-coral/10 p-3 text-[12.5px]">${nl(e.message)}</div>`;
      } finally { ev.target.disabled = false; ev.target.textContent = '✨ Criar estação'; }
    };
  });
}

async function importFile(file) {
  const out = $('#impOut');
  out.classList.remove('hidden');
  out.innerHTML = 'Lendo ' + esc(file.name) + '…';
  try {
    const rows = /\.(xlsx|xls)$/i.test(file.name) ? await sheetToRows(file) : JSON.parse(await file.text());
    const list = Array.isArray(rows) ? rows : (rows.estacoes || rows.rows || []);
    out.innerHTML = `${list.length} linha(s) lidas de <b>${esc(file.name)}</b> — enviando…`;
    const r = await api('/api/stations/import', {
      method: 'POST', body: { rows: list, overwrite: $('#ovw').checked ? '1' : '0', source: file.name },
    });
    out.innerHTML = `<b class="text-deep">${esc(r.message)}</b>${r.errors && r.errors.length
      ? '<br><span class="text-coral">' + r.errors.map(esc).join('<br>') + '</span>' : ''}`;
    toast(r.message);
    loadCat();
  } catch (e) {
    out.innerHTML = '<span class="text-coral">' + esc(e.message) + '</span>';
    toast('Falha na importação: ' + e.message, 'err', 7000);
  }
}

/** Lê XLSX no navegador (SheetJS sob demanda) e devolve as linhas da aba "Estações". */
async function sheetToRows(file) {
  if (!window.XLSX) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Não foi possível carregar o leitor de planilhas (offline). Use JSON ou a sincronização no servidor.'));
      document.head.appendChild(s);
    });
  }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const name = wb.SheetNames.find(n => /esta[cç]/i.test(n)) || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
}

function downloadExport(url) {
  if (!S.token) return toast('Sessão expirada', 'err');
  fetch(url, { headers: { Authorization: 'Bearer ' + S.token } })
    .then(async r => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + (await r.text()).slice(0, 160));
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pacote-estacoes-' + Date.now() + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Pacote exportado');
    })
    .catch(e => toast('Falha ao exportar: ' + e.message, 'err'));
}
/* =============================================================================
   pratica.M3D v5 — SPA (parte 2/2)
   Salas OSCE · videochamada WebRTC mesh (com fallback SDP manual) · timer
   autoritativo · chats (sala/observadores/lobby) · PEP com correção de IA e
   disputa · taxas de congelamento · SRS · biblioteca de cards · gestão · perfil.
   ============================================================================= */

/* ------------------------------------------------------------------- MODAL ---- */
let modalHandler = null;
function openModal(title, html, onReady) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  modalHandler = onReady || null;
  if (modalHandler) modalHandler($('#modalBody'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; modalHandler = null; }
$$('#modal [data-close]').forEach(el => el.onclick = closeModal);
$$('#imgview').forEach(el => el.addEventListener('click', e => { if (e.target.id === 'imgview') $('#imgview').classList.add('hidden'); }));
$('#imgClose').onclick = () => $('#imgview').classList.add('hidden');
$('#imgPrint').onclick = () => window.print();

/* ================================== LOBBY / SALAS ============================= */
async function viewLobby() {
  const rooms = (await api('/api/rooms')).rooms;
  S.rooms = rooms;
  const open = rooms.filter(r => r.open);
  $('#tabhost').innerHTML = `
  <div class="grid gap-4 lg:grid-cols-[1fr_1.25fr]">
    <div class="card raise">
      <h3 class="text-[16px] font-black text-deep">🎥 Criar sala de treino</h3>
      <div class="mt-3 space-y-2.5">
        <label class="fl">Nome da sala<input class="in" id="rName" placeholder="ex.: Revalida CIR — tarde"></label>
        <div class="grid grid-cols-2 gap-2.5">
          <label class="fl">Tipo<select class="sel" id="rType">
            <option value="ppl">👥 Com outros usuários</option>
            <option value="ai">🤖 Com auxílio de IA</option></select></label>
          <label class="fl">Visibilidade<select class="sel" id="rOpen">
            <option value="1">🌐 Aberta (aparece ao vivo no painel)</option>
            <option value="0">🔒 Fechada (somente convidados)</option></select></label>
        </div>
        <label class="flex items-center gap-2 text-[12.5px] font-bold">
          <input type="checkbox" id="rStudy"> modo estudo (sem cronômetro e sem nota)</label>
        <label class="fl">Estações da sala <span class="badge teal" id="rCount">0</span>
          <input class="in" id="rFilter" placeholder="filtrar estações…"></label>
        <div id="rStations" class="max-h-[260px] scroll-y space-y-1.5"></div>
        <button class="btn w-full" id="rCreate">＋ Abrir sala</button>
        <p class="hint">Regra da estação: a sala precisa de ao menos 1 estação. A regra de sala única encerra a sua sala anterior.</p>
      </div>
    </div>

    <div class="card raise">
      <div class="flex items-center gap-2">
        <h3 class="text-[16px] font-black text-deep">Salas disponíveis</h3>
        <span class="badge teal">${rooms.length}</span>
        ${open.length ? `<span class="badge coral"><span class="live-dot"></span>${open.length} abertas</span>` : ''}
        <button class="btn ghost sm ml-auto" id="rReload">↻</button>
      </div>
      <div class="mt-3 space-y-2 max-h-[560px] scroll-y" id="roomList">
        ${rooms.length ? rooms.map(r => roomRow(r)).join('') : '<p class="hint">Nenhuma sala criada ainda.</p>'}
      </div>
    </div>
  </div>

  <div class="card mt-4">
    <div class="flex items-center gap-2">
      <h3 class="text-[16px] font-black text-deep">💬 Chat do lobby</h3>
      <span class="badge gray">arquivado por hora no servidor</span>
      <button class="btn ghost sm ml-auto" id="lobbyLoad">carregar últimas</button>
    </div>
    <div id="lobbyMsgs" class="chat mt-2 rounded-xl border border-line bg-white/70"></div>
    <div class="mt-2 flex gap-2">
      <input class="in flex-1" id="lobbyText" placeholder="Mensagem pública do lobby…">
      <button class="btn" id="lobbySend">Enviar</button>
    </div>
  </div>`;

  $('#rReload').onclick = () => viewLobby();
  $('#lobbySend').onclick = sendLobby;
  $('#lobbyText').onkeydown = e => { if (e.key === 'Enter') sendLobby(); };
  $('#lobbyLoad').onclick = loadLobbyHistory;
  $('#rFilter').oninput = () => renderRoomStationPicker();
  $('#rCreate').onclick = createRoom;
  $('#roomList').onclick = async e => {
    const j = e.target.closest('[data-join]');
    const d = e.target.closest('[data-del]');
    if (j) return joinRoom(j.dataset.join);
    if (d && confirm('Encerrar a sala ' + d.dataset.del + '?')) {
      await api('/api/rooms/' + d.dataset.del, { method: 'DELETE' });
      toast('Sala encerrada'); viewLobby();
    }
  };

  S.pick = S.pick || [];
  renderRoomStationPicker();

  if (S.pendingJoin) { const c = S.pendingJoin; S.pendingJoin = null; joinRoom(c); }
}

async function renderRoomStationPicker() {
  const q = ($('#rFilter')?.value || '').trim();
  const d = await api('/api/stations?limit=60&q=' + encodeURIComponent(q));
  S.pickPool = d.stations;
  const host = $('#rStations');
  if (!host) return;
  host.innerHTML = S.pickPool.map(s => `
    <label class="flex items-center gap-2 rounded-lg border border-line bg-white px-2 py-1.5 text-[12.3px]">
      <input type="checkbox" data-pick="${esc(s.id)}" ${S.pick.includes(s.id) ? 'checked' : ''}>
      <span class="badge area" style="color:${s.area_color}">${s.area}</span>
      <span class="truncate flex-1">${esc(s.tema)}</span>
      <span class="badge gray">${esc(s.nivel)}</span></label>`).join('') || '<p class="hint">Nada encontrado.</p>';

  $$('#rStations [data-pick]').forEach(cb => cb.onchange = () => {
    const id = cb.dataset.pick;
    if (cb.checked) { if (!S.pick.includes(id)) S.pick.push(id); }
    else S.pick = S.pick.filter(x => x !== id);
    $('#rCount').textContent = S.pick.length;
    S.catsel = S.pick.slice();
  });
  if (S.prefill && S.prefill.length) {
    S.pick = Array.from(new Set(S.pick.concat(S.prefill)));
    S.prefill = null;
    renderRoomStationPicker();
  }
  $('#rCount').textContent = S.pick.length;
}

async function createRoom() {
  if (!S.pick || !S.pick.length) return toast('Escolha ao menos uma estação para abrir a sala', 'err');
  const body = {
    name: $('#rName').value.trim(),
    rtype: $('#rType').value,
    open: $('#rOpen').value === '1' ? 1 : 0,
    study_mode: $('#rStudy').checked ? 1 : 0,
    station_ids: S.pick,
  };
  const r = await api('/api/rooms', { method: 'POST', body });
  toast('Sala ' + r.room.code + ' criada');
  S.pick = [];
  joinRoom(r.room.code);
}

async function sendLobby() {
  const t = $('#lobbyText').value.trim();
  if (!t) return;
  $('#lobbyText').value = '';
  await api('/api/chat/lobby', { method: 'POST', body: { text: t } });
}
async function loadLobbyHistory() {
  try {
    const d = await api('/api/chat/archive');
    pushChat('#lobbyMsgs', { name: '📜 arquivo', text: d.archive.filter(x => x.scope === 'lobby').slice(0, 40).reverse().map(x => x.user_name + ': ' + x.text).join('\n') });
  } catch (_) { toast('Histórico restrito a administradores', 'err'); }
}

/* ============================== SALA / ESTAÇÃO ================================ */
async function joinRoom(code) {
  const role = await askRole();
  if (!role) return;
  const j = await api('/api/rooms/' + code + '/join', { method: 'POST', body: { role, peer_id: S.peer || (S.peer = rid()) } });
  const d = await api('/api/rooms/' + code);
  S.room = d.room; S.roomStations = d.stations; S.roomMembers = d.members; S.myRole = role;
  startRealtime(code);
  renderRoom();
  window.rtc = window.rtc || makeRtc();
  await window.rtc.start(role === 'observador');
}

function rid() { return Math.random().toString(36).slice(2, 10); }

function askRole() {
  return new Promise(res => {
    openModal('Qual o seu papel nesta estação?', `
      <div class="grid gap-2.5 md:grid-cols-3">
        <button class="card raise !p-4 text-left" data-role="medico">
          <b class="text-[15px] text-deep">🩺 Médico / Candidato</b>
          <p class="hint mt-1">Vê as instruções do participante, exames liberados e o próprio PEP.</p></button>
        <button class="card raise !p-4 text-left" data-role="avaliador">
          <b class="text-[15px] text-deep">🎭 Avaliador / Ator</b>
          <p class="hint mt-1">Script completo do ator, folha oficial do PEP, moderação e tempo.</p></button>
        <button class="card raise !p-4 text-left" data-role="observador">
          <b class="text-[15px] text-deep">👀 Observador</b>
          <p class="hint mt-1">Assiste sem pontuar, com chat oculto para dúvidas à IA.</p></button>
      </div>`, root => {
      $$('[data-role]', root).forEach(b => b.onclick = () => { const r = b.dataset.role; closeModal(); res(r); });
      root.querySelector('#modal')?.addEventListener('click', () => res(null));
    });
  });
}

function renderRoom() {
  const r = S.room, st = (S.roomStations || []).find(s => s.id === r.active_station) || (S.roomStations || [])[0];
  const isMod = S.myRole === 'avaliador' || r.creator_id === S.user.id || ['root', 'admin'].includes(S.user.role);
  const obs = S.myRole === 'observador';

  $('#tabhost').innerHTML = `
  <div class="card">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[17px]">${r.rtype === 'ai' ? '🤖' : '👥'}</span>
      <b class="text-[16px] text-deep">${esc(r.name)}</b>
      <span class="badge teal">código ${esc(r.code)}</span>
      ${r.study_mode ? '<span class="badge violet">modo estudo</span>' : ''}
      <span class="badge gray" id="rMembers">${(S.roomMembers || []).length} na sala</span>
      <span class="badge ${S.myRole === 'observador' ? 'violet' : S.myRole === 'avaliador' ? 'amber' : 'teal'}">${esc(S.myRole)}</span>
      <div class="ml-auto flex gap-2">
        <button class="btn ghost sm" id="rtcDiag">📡 diagnóstico WebRTC</button>
        <button class="btn ghost sm" id="sdpManual">🔗 SDP manual (fallback)</button>
        ${isMod ? '<button class="btn amber sm" id="roomFinish">✅ Encerrar estação</button>' : ''}
        <button class="btn coral sm" id="roomLeave">Sair</button>
      </div>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
      <span class="badge amber">🎭 papel: ${esc(S.myRole)}</span>
      ${r.station_ids.length > 1 && isMod
        ? `<label class="fl mb-0">Estação ativa
             <select class="sel" id="stSwitch">${r.station_ids.map(id => {
               const s = (S.roomStations || []).find(x => x.id === id) || {};
               return `<option value="${esc(id)}" ${id === r.active_station ? 'selected' : ''}>${esc(s.tema || id)}</option>`;
             }).join('')}</select></label>`
        : `<span class="badge teal">estação ativa: ${esc(st ? st.tema : '—')}</span>`}
    </div>
  </div>

  <div class="grid gap-4 lg:grid-cols-[1.5fr_1fr] mt-4">
    <div class="space-y-4">
      <div class="card">
        <div class="flex items-center gap-2">
          <h3 class="text-[15px] font-black text-deep">🎥 Vídeo · WebRTC mesh</h3>
          <span class="badge gray" id="iceAgg">ICE: —</span>
          <span class="badge teal ml-auto" id="tTimer">10:00</span>
        </div>
        <div id="videos" class="mt-3 grid gap-3 sm:grid-cols-2"></div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="btn mic-on sm" id="btnMic">🎙 microfone</button>
          <button class="btn mic-on sm" id="btnCam">📷 câmera</button>
          <button class="btn sky sm" id="btnShare">🖥 compartilhar tela</button>
          <button class="btn ghost sm" id="btnDevices">🎛 trocar dispositivos</button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 ${r.study_mode ? 'opacity-50 pointer-events-none' : ''}">
          <b class="text-[12.5px]">⏱ Timer oficial</b>
          <button class="btn sm" data-tm="start">▶ iniciar</button>
          <button class="btn amber sm" data-tm="pause">⏸ pausar</button>
          <button class="btn ghost sm" data-tm="resume">↻ retomar</button>
          <button class="btn ghost sm" data-tm="reset">⟲ zerar</button>
          <label class="flex items-center gap-1.5 text-[12px] font-bold">min
            <input class="in !w-[70px]" type="number" id="tmMin" min="1" max="60" value="${Math.round(r.timer.duration / 60)}">
            <button class="btn violet sm" id="tmSet">aplicar</button></label>
          <span class="text-[11px] text-mut">calculado e validado no servidor (fonte única)</span>
        </div>
      </div>

      <div class="card">
        <div class="flex gap-1.5 rounded-2xl bg-teal1/8 p-1.5 text-[12.5px] font-bold">
          <button class="tabbtn flex-1 is-on" data-cs="room">💬 Chat da sala</button>
          <button class="tabbtn flex-1" data-cs="obs">👀 Chat oculto (observadores)</button>
          <button class="tabbtn flex-1" data-cs="ai">🤖 Perguntar à IA</button>
        </div>
        <div id="chatBox" class="chat mt-3 rounded-xl border border-line bg-white/70"></div>
        <div class="mt-2 flex gap-2">
          <input class="in flex-1" id="chatText" placeholder="Escreva…">
          <button class="btn" id="chatSend">Enviar</button>
        </div>
        <p class="hint mt-1" id="chatHint"></p>
      </div>
    </div>

    <div class="space-y-4">
      <div class="card">
        <div class="flex items-center gap-2">
          <h3 class="text-[15px] font-black text-deep">🧾 Estação</h3>
          <span class="badge area ml-auto" style="color:${st ? st.area_color : '#0d9488'}">${esc(st ? st.area : '')}</span>
        </div>
        <div class="mt-2 text-[12.6px] space-y-2 max-h-[280px] scroll-y">
          <div><b class="text-deep">${esc(st ? st.tema : '—')}</b></div>
          ${obs ? '<p class="text-mut">Observador: você acompanha sem acessar o PEP.</p>' : `
            <div><b class="text-deep">Instruções do candidato</b><p>${nl(st ? st.instrucoes : '')}</p></div>
            ${isMod ? `<div><b class="text-deep">Roteiro do ator</b><p>${nl(st ? st.roteiro_ator : '')}</p></div>` : ''}
            <div><b class="text-deep">Cenário</b><p>${nl(st ? st.cenario : '')}</p></div>
            <div><b class="text-deep">Protocolo</b><p>${nl(st ? st.protocolo : '')}</p></div>`}
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          <button class="btn ghost sm" id="stExams">🖼 exames complementares</button>
          <button class="btn violet sm" id="stCard">🗂️ card de procedimento</button>
          ${st ? `<button class="btn sky sm" id="aiPatient">🤖对话 paciente virtual</button>` : ''}
        </div>
      </div>

      ${obs ? '' : `
      <div class="card">
        <div class="flex items-center gap-2">
          <h3 class="text-[15px] font-black text-deep">✅ Checklist oficial (PEP)</h3>
          <span class="badge teal ml-auto" id="pepScore">0%</span>
        </div>
        <div class="sbar mt-2"><i id="pepBar" style="width:0%"></i></div>
        <div id="pepList" class="mt-3 space-y-1.5 max-h-[320px] scroll-y text-[12.4px]"></div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button class="btn" id="pepSave">💾 Salvar nota</button>
          <button class="btn violet sm" id="pepAI">🤖 corrigir por áudio/transcrição</button>
          <button class="btn ghost sm" id="pepStudy">📖 modo estudo (sem nota)</button>
        </div>
        <div class="mt-3 rounded-xl border border-line bg-white/80 p-2.5">
          <b class="text-[12.5px] text-deep">Sistema de contestação</b>
          <p class="hint">Discorde de itens do PEP. Se a anulação passar de 40%, a estação é congelada e vai para revisão no painel admin.</p>
          <div class="mt-2 flex gap-2">
            <input class="in !w-[70px]" type="number" id="dspIdx" min="1" placeholder="item">
            <input class="in flex-1" id="dspReason" placeholder="motivo da contestação">
            <button class="btn coral sm" id="dspGo">contestar</button>
          </div>
          <div id="dspOut" class="mt-2 text-[12px]"></div>
        </div>
      </div>`}
    </div>
  </div>`;

  bindRoom(st, isMod);
  renderVideos();
  S.markState = {};
  renderPep(st);
  syncTimerUi(r.timer);
  loadChat();
  if (S.myRole === 'observador') setChatScope('obs');
}

function bindRoom(st, isMod) {
  $('#roomLeave').onclick = async () => {
    await api('/api/rooms/' + S.room.code + '/leave', { method: 'POST', body: { peer_id: S.peer } });
    window.rtc?.stop(); stopRealtime(); S.room = null; go('lobby');
  };
  $('#roomFinish')?.addEventListener('click', async () => {
    const r = await api('/api/rooms/' + S.room.code + '/finish', { method: 'POST' });
    toast(r.message);
  });
  $('#stSwitch')?.addEventListener('change', async e => {
    await api('/api/rooms/' + S.room.code + '/station', { method: 'POST', body: { station_id: e.target.value } });
    toast('Estação ativa alterada');
  });
  $$('[data-tm]').forEach(b => b.onclick = async () => {
    const r = await api('/api/rooms/' + S.room.code + '/timer', { method: 'POST', body: { action: b.dataset.tm } });
    syncTimerUi(r.timer);
  });
  $('#tmSet')?.addEventListener('click', async () => {
    const sec = Math.max(60, Math.min(3600, (parseInt($('#tmMin').value, 10) || 10) * 60));
    const r = await api('/api/rooms/' + S.room.code + '/timer', { method: 'POST', body: { action: 'set', seconds: sec } });
    syncTimerUi(r.timer);
  });
  $('#stExams').onclick = () => showExams(st);
  $('#stCard').onclick = () => makeCard(st.id);
  $('#aiPatient')?.addEventListener('click', () => aiPatientPanel(st));

  $('#btnMic').onclick = () => window.rtc.toggleMic();
  $('#btnCam').onclick = () => window.rtc.toggleCam();
  $('#btnShare').onclick = () => window.rtc.toggleShare();
  $('#btnDevices').onclick = () => window.rtc.pickDevices();
  $('#rtcDiag').onclick = () => window.rtc.diagnose();
  $('#sdpManual').onclick = () => window.rtc.manualSdp();

  const chatBox = $('#chatBox');
  $$('.tabbtn[data-cs]').forEach(b => b.onclick = () => setChatScope(b.dataset.cs));
  $('#chatSend').onclick = sendChat;
  $('#chatText').onkeydown = e => { if (e.key === 'Enter') sendChat(); };

  $$('#pepList input[type=checkbox]').forEach(cb => cb.onchange = () => {
    S.markState[cb.dataset.idx] = cb.checked ? 1 : 0;
    updatePepScore(st);
  });
  $('#pepSave')?.addEventListener('click', async () => {
    const r = await api('/api/pep', { method: 'POST', body: { room_code: S.room.code, station_id: st.id, marks: S.markState, transcript: (S.transcript || '') } });
    toast('Nota salva: ' + r.score + '%');
  });
  $('#pepAI')?.addEventListener('click', () => pepAiPanel(st));
  $('#pepStudy')?.addEventListener('click', () => openStation(st.id));
  $('#dspGo')?.addEventListener('click', async () => {
    const idx = parseInt($('#dspIdx').value, 10);
    const reason = $('#dspReason').value.trim();
    if (!idx || !reason) return toast('Informe o item e o motivo', 'err');
    const r = await api('/api/disputes', { method: 'POST', body: { station_id: st.id, item_idx: idx, reason, room_code: S.room.code } });
    $('#dspOut').innerHTML = `<b class="${r.frozen ? 'text-coral' : 'text-deep'}">${esc(r.message)}</b> — ${r.open}/${r.total_itens} itens contestados (${r.ratio}%)`;
    toast(r.message, r.frozen ? 'err' : 'ok', 6500);
  });
}

function showExams(st) {
  const ex = st.exames || [];
  const gal = { 'laboratório': '🧪', 'ecg': '📈', 'raio': '🩻', 'tc': '🧠', 'rm': '🧲', 'usg': '🩺', 'ectoscopia': '🔍', 'sorologia': '🧫' };
  openModal('🖼 Exames complementares — ' + st.tema, `
    <div class="grid gap-3 sm:grid-cols-2">${ex.length ? ex.map((e, i) => {
      const nome = typeof e === 'string' ? e : (e.nome || e.tipo || JSON.stringify(e));
      const laudo = typeof e === 'string' ? '' : (e.laudo || e.resultado || e.descricao || '');
      const ic = Object.keys(gal).find(k => nome.toLowerCase().includes(k));
      return `<div class="card !p-3">
        <div class="flex items-center gap-2"><span class="text-[20px]">${ic ? gal[ic] : '🖼'}</span><b class="text-[13px]">${esc(nome)}</b></div>
        ${laudo ? `<p class="mt-1 text-[12.3px]">${nl(laudo)}</p>` : '<p class="hint mt-1">Laudo reservado ao avaliador — libere verbalmente conforme a condução.</p>'}
        <button class="btn ghost sm mt-2" data-rel="${i}">liberar ao candidato</button></div>`;
    }).join('') : '<p class="hint">Esta estação não possui exames anexados.</p>'}</div>`, root => {
      $$('[data-rel]', root).forEach(b => b.onclick = () => evtSend('exams:release', { station_id: st.id, idx: parseInt(b.dataset.rel, 10), by: S.user.name }));
    });
}

/* ==================================== TIMER =================================== */
function syncTimerUi(t) {
  S.timer = t;
  const el = $('#tTimer');
  if (el) {
    el.textContent = hhmmss(t.remaining);
    el.className = 'badge ' + (t.alert === 'red' ? 'coral' : t.alert === 'amber' ? 'amber' : 'teal') + ' ml-auto timerbox';
  }
  const badge = $('#clockBadge');
  if (badge) { badge.classList.remove('hidden'); badge.textContent = '⏱ ' + hhmmss(t.remaining); }
}
function tickTimer() {
  if (S.timer && S.timer.state === 'running') {
    S.timer.remaining = Math.max(0, S.timer.remaining - 1);
    if (S.timer.remaining === 180 || S.timer.remaining === 60) beep();
    if (S.timer.remaining === 0) beep(3);
    syncTimerUi(S.timer);
  } else if (S.timer) syncTimerUi(S.timer);
}
let audioCtx = null;
function beep(n = 1) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < n; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = i % 2 ? 520 : 780;
      o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.28;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.start(t0); o.stop(t0 + 0.25);
    }
  } catch (_) {}
}
setInterval(tickTimer, 1000);

/* =============================== PEP / SCORE ================================== */
function renderPep(st) {
  const host = $('#pepList');
  if (!host || !st) return;
  host.innerHTML = (st.checklist || []).map((c, i) => `
    <label class="flex items-start gap-2 rounded-lg border border-line bg-white px-2 py-1.5">
      <input type="checkbox" data-idx="${i + 1}" ${S.markState[i + 1] ? 'checked' : ''} class="mt-[3px]">
      <span class="flex-1">${esc(c.item)} <span class="badge amber">peso ${esc(c.peso ?? 1)}</span></span>
      <button class="text-coral font-black" data-dsp="${i + 1}" title="contestar">⚖</button>
    </label>`).join('') || '<p class="hint">Sem checklist nesta estação.</p>';
  $$('#pepList input[type=checkbox]').forEach(cb => cb.onchange = () => { S.markState[cb.dataset.idx] = cb.checked ? 1 : 0; updatePepScore(st); });
  $$('#pepList [data-dsp]').forEach(b => b.onclick = () => { if ($('#dspIdx')) $('#dspIdx').value = b.dataset.dsp; });
  updatePepScore(st);
}
function updatePepScore(st) {
  let tot = 0, got = 0;
  (st.checklist || []).forEach((c, i) => { const w = +c.peso || 1; tot += w; if (S.markState[i + 1]) got += w; });
  const pct = tot ? Math.round(got / tot * 1000) / 10 : 0;
  if ($('#pepScore')) $('#pepScore').textContent = pct + '%';
  if ($('#pepBar')) $('#pepBar').style.width = pct + '%';
}

/* ============================== CORREÇÃO POR IA =============================== */
function pepAiPanel(st) {
  openModal('🤖 Correção automática do PEP', `
    <p class="hint">Grave o áudio da estação (fala do médico e do ator) ou cole a transcrição.
    A IA valida item a item, exige citação em contexto e gera justificativa para cada critério.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn" id="recStart">🎙 iniciar gravação</button>
      <button class="btn amber" id="recStop" disabled>⏹ parar</button>
      <button class="btn ghost" id="dictStart">🗣 ditado (pt-BR)</button>
      <span class="badge gray" id="recState">pronto</span>
      <span id="recWarn" class="hint"></span>
    </div>
    <textarea class="area mt-3" id="trText" placeholder="Transcrição do diálogo…">${esc(S.transcript || '')}</textarea>
    <button class="btn violet mt-3" id="trGo">🤖 corrigir com IA</button>
    <div id="trOut" class="mt-3"></div>`, root => bindPepAi(root, st));
}

function bindPepAi(root, st) {
  const ta = root.querySelector('#trText');
  let rec = null, chunks = [];
  root.querySelector('#recStart').onclick = async (ev) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream); chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        root.querySelector('#recState').textContent = 'transcrevendo…';
        const blob = new Blob(chunks, { type: rec.mimeType });
        // transcrição local quando disponível; caso contrário o áudio fica anexado à nota
        const txt = await tryLocalTranscript(blob);
        if (txt) { ta.value = (ta.value ? ta.value + '\n' : '') + txt; }
        root.querySelector('#recState').textContent = txt ? 'transcrito' : 'áudio capturado (sem transcrição local)';
        root.querySelector('#recWarn').textContent = txt ? '' : 'Este navegador não expôs transcrição — cole a transcrição ou use o ditado.';
        S.transcript = ta.value;
      };
      rec.start();
      ev.target.disabled = true; root.querySelector('#recStop').disabled = false;
      root.querySelector('#recState').textContent = 'gravando…';
    } catch (e) {
      root.querySelector('#recWarn').textContent = 'Microfone indisponível: ' + e.message + ' (use https:// fora de localhost)';
    }
  };
  root.querySelector('#recStop').onclick = () => { rec?.stop(); root.querySelector('#recStart').disabled = false; root.querySelector('#recStop').disabled = true; };
  root.querySelector('#dictStart').onclick = (ev) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { root.querySelector('#recWarn').textContent = 'Reconhecimento de voz não suportado neste navegador.'; return; }
    const r = new SR(); r.lang = 'pt-BR'; r.continuous = true; r.interimResults = true;
    r.onresult = e => {
      let fin = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) fin += e.results[i][0].transcript + '. ';
      if (fin) ta.value += fin;
    };
    r.start();
    root.querySelector('#recState').textContent = 'ditado ativo…';
    ta.onclick = () => r.stop();
  };
  root.querySelector('#trGo').onclick = async (ev) => {
    S.transcript = ta.value;
    if (!ta.value.trim()) return toast('Cole ou grave a transcrição primeiro', 'err');
    ev.target.disabled = true; ev.target.textContent = '🤖 corrigindo…';
    try {
      const r = await api('/api/ai/correct_pep', { method: 'POST', body: { station_id: st.id, transcript: ta.value, room_code: S.room.code } });
      setAiBadge(r.provider);
      S.markState = {};
      r.detail.forEach(d => { if (d.cumprido) S.markState[d.idx] = 1; });
      renderPep(st);
      root.querySelector('#trOut').innerHTML = `
        <div class="card !p-3">
          <div class="flex items-center gap-2"><b class="text-deep">Nota da IA: ${r.score}%</b>
            <span class="badge teal">${esc((r.provider || '').toUpperCase())}</span></div>
          <p class="mt-2 text-[12.5px]">${nl(r.comentario)}</p>
          <div class="mt-2 space-y-1.5">${r.detail.map(d => `
            <div class="rounded-lg border ${d.cumprido ? 'border-teal3 bg-teal1/5' : 'border-line bg-white'} p-2 text-[12.2px]">
              <b>${d.cumprido ? '✔' : '✘'} ${d.idx}. ${esc(d.item)}</b> <span class="badge amber">peso ${d.peso}</span>
              ${d.citacao ? `<div class="mt-1 text-mut">“${esc(d.citacao)}”</div>` : ''}
              ${d.justificativa ? `<div class="mt-1">${esc(d.justificativa)}</div>` : ''}
            </div>`).join('')}</div>
        </div>`;
      toast('PEP corrigido pela IA: ' + r.score + '%');
    } finally { ev.target.disabled = false; ev.target.textContent = '🤖 corrigir com IA'; }
  };
}

/** Tenta transcrição nativa do navegador (experimental) sem quebrar o fluxo. */
async function tryLocalTranscript(blob) {
  try {
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) return '';
    return '';   // sem API nativa confiável para arquivo; o ditado cobre o caso
  } catch (_) { return ''; }
}

function aiPatientPanel(st) {
  openModal('🤖 Paciente virtual — ' + st.tema, `
    <p class="hint">O paciente responde apenas o que for perguntado, segundo o roteiro do ator.
    Há fala (SpeechSynthesis pt-BR) e ditado (SpeechRecognition) quando o navegador suportar.</p>
    <div class="mt-2 flex items-center gap-2">
      <label class="flex items-center gap-1.5 text-[12px] font-bold"><input type="checkbox" id="pvSpeak" checked> falar em voz alta</label>
      <button class="btn ghost sm ml-auto" id="pvMic">🎤 perguntar por voz</button>
    </div>
    <div id="pvLog" class="chat mt-3 rounded-xl border border-line bg-white/70"></div>
    <div class="mt-2 flex gap-2">
      <input class="in flex-1" id="pvQ" placeholder="Pergunta ao paciente…">
      <button class="btn" id="pvGo">Perguntar</button>
    </div>`, root => {
    const log = root.querySelector('#pvLog');
    const hist = [];
    const ask = async (q) => {
      if (!q.trim()) return;
      pushChat(log, { me: true, name: 'você', text: q });
      root.querySelector('#pvQ').value = '';
      const r = await api('/api/ai/patient', { method: 'POST', body: { station_id: st.id, question: q, history: hist } });
      setAiBadge(r.provider);
      hist.push({ from: 'candidato', text: q }, { from: 'paciente', text: r.answer });
      pushChat(log, { ai: true, name: 'paciente', text: r.answer });
      if (root.querySelector('#pvSpeak').checked && window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(r.answer);
        u.lang = 'pt-BR';
        speechSynthesis.speak(u);
      }
    };
    root.querySelector('#pvGo').onclick = () => ask(root.querySelector('#pvQ').value);
    root.querySelector('#pvQ').onkeydown = e => { if (e.key === 'Enter') ask(root.querySelector('#pvQ').value); };
    root.querySelector('#pvMic').onclick = (ev) => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return toast('Reconhecimento de voz não suportado', 'err');
      const r = new SR(); r.lang = 'pt-BR'; r.continuous = false; r.interimResults = false;
      ev.target.textContent = '🎤 ouvindo…';
      r.onresult = e => { ev.target.textContent = '🎤 perguntar por voz'; ask(e.results[0][0].transcript); };
      r.onerror = () => { ev.target.textContent = '🎤 perguntar por voz'; };
      r.start();
    };
  });
}

/* ============================ WEBRTC MESH (relay) ============================= */
function makeRtc() {
  const CFG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
  const R = {
    local: null, share: null, cams: [], mics: [], ice: {},
    async start(audioOnly) {
      try {
        R.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: !audioOnly });
      } catch (e) {
        toast('Não foi possível abrir câmera/microfone: ' + e.message + ' — fora de localhost o navegador exige https://', 'err', 9000);
        return;
      }
      await R.devices();
      renderVideos();
      R.hello();
    },
    stop() {
      Object.values(S.peers).forEach(p => { try { p.pc.close(); } catch (_) {} });
      S.peers = {};
      R.local?.getTracks().forEach(t => t.stop());
      renderVideos();
    },
    async devices() {
      try {
        const ds = await navigator.mediaDevices.enumerateDevices();
        R.cams = ds.filter(d => d.kind === 'videoinput');
        R.mics = ds.filter(d => d.kind === 'audioinput');
      } catch (_) {}
    },
    hello() {
      // anuncia entrada para que os pares existentes iniciem ofertas
      evtSend('rtc', { from: S.peer, to: '', kind: 'hello', data: { name: S.user.name, role: S.myRole } });
    },
    addPeer(pid, polite) {
      const p = S.peers[pid] || (S.peers[pid] = { pc: null, polite, name: '', role: '', state: 'novo' });
      if (p.pc) return p;
      p.pc = new RTCPeerConnection(CFG);
      R.ice[pid] = [];
      R.local?.getTracks().forEach(t => p.pc.addTrack(t, R.local));
      p.pc.onicecandidate = e => { if (e.candidate) evtSend('rtc', { from: S.peer, to: pid, kind: 'ice', data: e.candidate.toJSON() }); };
      p.pc.oniceconnectionstatechange = () => { p.state = p.pc.iceConnectionState; renderVideos(); };
      p.pc.ontrack = e => {
        p.stream = e.streams[0];
        renderVideos();
      };
      return p;
    },
    async offer(pid) {
      const p = R.addPeer(pid, false);
      const o = await p.pc.createOffer();
      await p.pc.setLocalDescription(o);
      evtSend('rtc', { from: S.peer, to: pid, kind: 'offer', data: o });
    },
    async onSignal(msg) {
      const pid = msg.from, kind = msg.kind;
      if (kind === 'hello') { if (pid !== S.peer) R.offer(pid); return; }
      if (kind === 'offer') {
        const p = R.addPeer(pid, true);
        await p.pc.setRemoteDescription(new RTCSessionDescription(msg.data));
        const a = await p.pc.createAnswer();
        await p.pc.setLocalDescription(a);
        evtSend('rtc', { from: S.peer, to: pid, kind: 'answer', data: a });
      } else if (kind === 'answer') {
        const p = S.peers[pid]; if (p?.pc) await p.pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      } else if (kind === 'ice') {
        const p = S.peers[pid]; if (p?.pc) { try { await p.pc.addIceCandidate(new RTCIceCandidate(msg.data)); } catch (_) {} }
      } else if (kind === 'bye') {
        S.peers[pid]?.pc?.close(); delete S.peers[pid]; renderVideos();
      } else if (kind === 'manual') {
        S.manualOffer = msg.data;
        toast('Oferta SDP recebida de ' + (msg.name || pid) + ' — abra “SDP manual” para aplicar', 'info', 8000);
      }
    },
    toggleMic() {
      const t = R.local?.getAudioTracks()[0]; if (!t) return;
      t.enabled = !t.enabled;
      $('#btnMic').className = 'btn sm ' + (t.enabled ? 'mic-on' : 'mic-off');
      $('#btnMic').textContent = t.enabled ? '🎙 microfone' : '🔇 mudo';
    },
    toggleCam() {
      const t = R.local?.getVideoTracks()[0]; if (!t) return toast('Sem câmera disponível', 'err');
      t.enabled = !t.enabled;
      $('#btnCam').className = 'btn sm ' + (t.enabled ? 'mic-on' : 'mic-off');
      $('#btnCam').textContent = t.enabled ? '📷 câmera' : '🚫 câmera off';
    },
    async toggleShare() {
      const btn = $('#btnShare');
      if (R.share) {
        R.share.getTracks().forEach(t => t.stop()); R.share = null;
        const cam = R.local?.getVideoTracks()[0] || null;
        await R.replaceVideo(cam);
        btn.className = 'btn sky sm'; btn.textContent = '🖥 compartilhar tela';
        toast('Compartilhamento encerrado');
        return;
      }
      try {
        R.share = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const st = R.share.getVideoTracks()[0];
        await R.replaceVideo(st);
        st.onended = () => R.toggleShare();
        btn.className = 'btn coral sm'; btn.textContent = '⏹ parar de compartilhar';
        toast('Compartilhando tela (replaceTrack em todos os pares)');
      } catch (e) { toast('Compartilhamento cancelado', 'err'); }
    },
    async replaceVideo(track) {
      for (const p of Object.values(S.peers)) {
        const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender && track) await sender.replaceTrack(track);
      }
      renderVideos();
    },
    async pickDevices() {
      await R.devices();
      openModal('🎛 Dispositivos de mídia', `
        <label class="fl">Câmera<select class="sel" id="dvCam">${R.cams.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || 'câmera ' + (i + 1))}</option>`).join('')}</select></label>
        <label class="fl mt-3">Microfone<select class="sel" id="dvMic">${R.mics.map((d, i) => `<option value="${d.deviceId}">${esc(d.label || 'microfone ' + (i + 1))}</option>`).join('')}</select></label>
        <button class="btn mt-3" id="dvGo">aplicar e republicar</button>`, root => {
        root.querySelector('#dvGo').onclick = async () => {
          const cam = root.querySelector('#dvCam').value, mic = root.querySelector('#dvMic').value;
          const ns = await navigator.mediaDevices.getUserMedia({
            audio: mic ? { deviceId: { exact: mic } } : true,
            video: cam ? { deviceId: { exact: cam } } : true,
          });
          const vt = ns.getVideoTracks()[0], at = ns.getAudioTracks()[0];
          R.local?.getTracks().forEach(t => t.stop());
          R.local = ns;
          for (const p of Object.values(S.peers)) {
            for (const s of p.pc.getSenders()) {
              if (!s.track) continue;
              if (s.track.kind === 'video' && vt) await s.replaceTrack(vt);
              if (s.track.kind === 'audio' && at) await s.replaceTrack(at);
            }
          }
          closeModal(); renderVideos(); toast('Dispositivos trocados');
        };
      });
    },
    diagnose() {
      const rows = Object.entries(S.peers).map(([pid, p]) => {
        const pc = p.pc;
        const pairs = pc?.getStats ? 'ok' : '—';
        return `<tr><td>${esc(p.name || pid)}</td><td>${esc(p.role || '')}</td>
          <td><span class="badge ${p.state === 'connected' ? 'teal' : p.state === 'failed' ? 'coral' : 'amber'}">${esc(p.state || 'novo')}</span></td>
          <td class="text-mut">${pc?.connectionState || '—'} / ${pc?.iceConnectionState || '—'}</td></tr>`;
      }).join('');
      openModal('📡 Diagnóstico da conexão (por par)', `
        <p class="hint">Estado ICE por peer — se aparecer “failed”, use o <b>SDP manual</b> (fallback 100% offline via copiar/colar).</p>
        <table class="tb mt-2"><thead><tr><th>par</th><th>papel</th><th>estado</th><th>connection/ice</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="text-mut">Nenhum par conectado ainda.</td></tr>'}</tbody></table>
        <div class="mt-3 text-[12px]"><b>Mídia local:</b> ${R.local ? R.local.getTracks().map(t => t.kind + (t.enabled ? ' ✔' : ' ✘')).join(' · ') : 'sem captura'}</div>`);
    },
    /** Fallback SDP manual: cria/cola oferta e resposta sem depender do servidor. */
    manualSdp() {
      openModal('🔗 SDP manual (fallback P2P offline)', `
        <p class="hint">Caminho de contingência quando o servidor de sinalização fica inacessível: um lado gera a
        <b>oferta</b>, o outro cola a oferta e gera a <b>resposta</b>, e o primeiro aplica a resposta. Tudo por copiar/colar.</p>
        <div class="mt-3 grid gap-3 md:grid-cols-2">
          <div class="card !p-3">
            <b class="text-[13px] text-deep">1 · Oferta (lado A)</b>
            <textarea class="area mt-2" id="sdA" placeholder="cole aqui a OFERTA recebida para gerar a resposta"></textarea>
            <div class="mt-2 flex gap-2">
              <button class="btn sm" id="sdMakeOffer">gerar oferta</button>
              <button class="btn violet sm" id="sdMakeAnswer">gerar resposta</button>
            </div>
          </div>
          <div class="card !p-3">
            <b class="text-[13px] text-deep">2 · Resposta / aplicação (lado B)</b>
            <textarea class="area mt-2" id="sdB" placeholder="cole aqui a RESPOSTA recebida para aplicar"></textarea>
            <div class="mt-2 flex gap-2">
              <button class="btn sky sm" id="sdApply">aplicar resposta</button>
              <button class="btn ghost sm" id="sdCopy">copiar minha saída</button>
            </div>
          </div>
        </div>
        <div id="sdOut" class="mt-3 text-[12px]"></div>`, root => {
        const tmp = { pc: null };
        const mk = () => {
          if (tmp.pc) return tmp.pc;
          tmp.pc = new RTCPeerConnection(CFG);
          R.local?.getTracks().forEach(t => tmp.pc.addTrack(t, R.local));
          tmp.pc.onicecandidate = e => {
            if (e.candidate) root.querySelector('#sdOut').textContent = 'coletando ICE…';
          };
          return tmp.pc;
        };
        const dump = (pc, out) => {
          setTimeout(() => {
            root.querySelector(out).value = JSON.stringify(pc.localDescription);
            root.querySelector('#sdOut').innerHTML = 'SDP gerado — copie, envie para o outro lado e cole a resposta em <b>SDP manual</b>.';
          }, 900);
        };
        root.querySelector('#sdMakeOffer').onclick = async () => { const pc = mk(); await pc.setLocalDescription(await pc.createOffer()); dump(pc, '#sdA'); };
        root.querySelector('#sdMakeAnswer').onclick = async () => {
          const pc = mk();
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(root.querySelector('#sdA').value)));
            await pc.setLocalDescription(await pc.createAnswer());
            dump(pc, '#sdB');
          } catch (e) { toast('Oferta inválida: ' + e.message, 'err'); }
        };
        root.querySelector('#sdApply').onclick = async () => {
          const pc = mk();
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(root.querySelector('#sdB').value)));
            pc.ontrack = e => { S.manualStream = e.streams[0]; renderVideos(); };
            toast('Resposta aplicada — mídia P2P ativa');
          } catch (e) { toast('Resposta inválida: ' + e.message, 'err'); }
        };
        root.querySelector('#sdCopy').onclick = () => {
          const v = root.querySelector('#sdA').value || root.querySelector('#sdB').value;
          navigator.clipboard.writeText(v); toast('SDP copiado');
        };
      });
    },
  };
  return R;
}

function renderVideos() {
  const host = $('#videos');
  if (!host) return;
  const tiles = [];
  if (window.rtc?.local) {
    tiles.push(tile('local', 'Você · ' + S.user.name, window.rtc.local, window.rtc.share ? 'compartilhando tela' : 'conectado', 'ok'));
  } else {
    tiles.push(`<div class="vwrap"><div class="ph">📷 Sem captura local.<br>Fora de localhost o navegador exige <b>https://</b> para usar câmera e microfone.</div></div>`);
  }
  Object.entries(S.peers).forEach(([pid, p]) => {
    if (!p.stream) tiles.push(`<div class="vwrap"><div class="ph">⏳ aguardando mídia de ${esc(p.name || pid)}…<br><span class="text-[11px]">${esc(p.state || 'novo')}</span></div></div>`);
    else tiles.push(tile(pid, (p.name || pid) + ' · ' + (p.role || ''), p.stream, '', p.state === 'connected' ? 'ok' : 'wait'));
  });
  if (S.manualStream) tiles.push(tile('manual', 'par via SDP manual', S.manualStream, '', 'ok'));
  host.innerHTML = tiles.join('');
  host.querySelectorAll('video').forEach(v => {
    const s = v.dataset.sid;
    const stream = s === 'local' ? window.rtc?.local : s === 'manual' ? S.manualStream : S.peers[s]?.stream;
    if (stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
  });
}
function tile(id, label, stream, extra, st) {
  return `<div class="vwrap">
    <video data-sid="${esc(id)}" autoplay playsinline ${id === 'local' ? 'muted' : ''}></video>
    <span class="tag">${esc(label)}${extra ? ' · ' + esc(extra) : ''}</span>
    <span class="st ${st}">${st === 'ok' ? '✔ ativo' : '…'}</span></div>`;
}

/* =============================== CHAT / EVENTOS =============================== */
function setChatScope(scope) {
  S.chatScope = scope;
  $$('.tabbtn[data-cs]').forEach(b => b.classList.toggle('is-on', b.dataset.cs === scope));
  const hints = {
    room: 'Chat em tempo real entre os participantes da sala.',
    obs: 'Área restrita: só observadores leem agora — as anotações são reveladas a todos ao encerrar a estação.',
    ai: 'Sua pergunta é enviada à cadeia de IA com o contexto da estação.',
  };
  $('#chatHint').textContent = hints[scope] || '';
  loadChat();
}
async function loadChat() {
  if (!S.room) return;
  const box = $('#chatBox');
  if (!box) return;
  box.innerHTML = '';
  try {
    const d = await api('/api/pep/results?limit=1', { silent: true });
    void d;
  } catch (_) {}
  pushChat(box, { name: 'sistema', text: 'Chat ' + S.chatScope + ' ativo na sala ' + S.room.code + '.' });
}
function pushChat(sel, m) {
  const box = typeof sel === 'string' ? $(sel) : sel;
  if (!box) return;
  const cls = m.me ? 'me' : m.ai ? 'ai' : m.obs ? 'obs' : '';
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.innerHTML = `<span class="who">${esc(m.name || '')}</span>${nl(m.text || '')}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
async function sendChat() {
  const t = $('#chatText').value.trim();
  if (!t || !S.room) return;
  $('#chatText').value = '';
  if (S.chatScope === 'ai') {
    pushChat('#chatBox', { me: true, name: 'você → IA', text: t });
    try {
      const r = await api('/api/ai/ask', { method: 'POST', body: { q: t, context: 'OSCE ' + (S.room.name) + ' — estação ' + (S.room.active_station || '') } });
      setAiBadge(r.provider);
      pushChat('#chatBox', { ai: true, name: '🤖 IA', text: r.answer });
      evtSend('chat:obs', { name: '🤖 IA', text: r.answer, scope: 'obs' });
    } catch (e) { pushChat('#chatBox', { name: 'erro', text: e.message }); }
    return;
  }
  await api('/api/rooms/' + S.room.code + '/chat', { method: 'POST', body: { text: t, scope: S.chatScope } });
  pushChat('#chatBox', { me: true, name: 'você', text: t });
}
function evtSend(type, data) {
  if (!S.room) return;
  const body = type === 'rtc' ? data : Object.assign({}, data, { kind: type });
  return api('/api/rooms/' + S.room.code + (type === 'rtc' ? '/rtc' : '/chat'), {
    method: 'POST', silent: true,
    body: type === 'rtc' ? body : { text: JSON.stringify(body), scope: S.chatScope },
  }).catch(() => {});
}

/* ============================== TEMPO REAL (SSE) ============================== */
function startRealtime(code) {
  stopRealtime();
  const url = '/sse?room=' + encodeURIComponent(code) + '&since=' + (S.since || 0) + '&token=' + encodeURIComponent(S.token);
  const es = new EventSource(url);
  S.es = es;
  es.addEventListener('hello', e => { S.since = JSON.parse(e.data).since || S.since; });
  const names = ['room:members', 'room:station', 'timer:ctl', 'chat:room', 'chat:obs', 'chat:lobby',
                 'pep:result', 'dispute:frozen', 'station:finish', 'room:new', 'room:closed', 'rtc', 'rtc:tick', 'exams:release'];
  names.forEach(n => es.addEventListener(n, ev => handleEvent(n, safeJson(ev.data))));
  es.addEventListener('presence', ev => {
    const d = safeJson(ev.data);
    if (d.members) {
      S.roomMembers = d.members;
      if ($('#rMembers')) $('#rMembers').textContent = d.members.length + ' na sala';
      // inicia conexão com novos pares
      d.members.forEach(m => { if (m.peer_id !== S.peer && !S.peers[m.peer_id]) window.rtc && window.rtc.addPeer(m.peer_id, false); });
    }
  });
  es.onerror = () => { /* o navegador reconecta com `retry:`; sem polling extra */ };
  S.sinceClosed = false;
}
function stopRealtime() { try { S.es?.close(); } catch (_) {} S.es = null; }
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

function handleEvent(name, ev) {
  const p = ev.payload || {};
  switch (name) {
    case 'rtc':
      if (p.to && p.to !== S.peer && p.from !== S.peer) return;
      if (p.from === S.peer) return;
      window.rtc?.onSignal(p);
      if (p.data?.name) { const pp = S.peers[p.from]; if (pp) { pp.name = p.data.name; pp.role = p.data.role; } }
      break;
    case 'chat:room':
      if ($('#chatBox') && S.chatScope === 'room') pushChat('#chatBox', { name: p.name, text: p.text });
      if ($('#lobbyMsgs') && p.name) pushChat('#lobbyMsgs', { name: p.name, text: p.text });
      break;
    case 'chat:obs':
      if ($('#chatBox') && S.chatScope === 'obs') pushChat('#chatBox', { obs: true, name: '👀 ' + (p.name || ''), text: p.text });
      break;
    case 'chat:lobby':
      if ($('#lobbyMsgs')) pushChat('#lobbyMsgs', { name: p.name, text: p.text });
      break;
    case 'timer:ctl':
      if (!p.timer) return;
      syncTimerUi(p.timer);
      toast('⏱ ' + p.by + ' → ' + p.action, 'info', 2600);
      break;
    case 'room:station':
      toast('🎬 estação ativa alterada por ' + p.by, 'info');
      api('/api/rooms/' + S.room.code).then(d => { S.roomStations = d.stations; S.room.active_station = d.room.active_station; renderRoom(); }).catch(() => {});
      break;
    case 'room:members':
      api('/api/rooms/' + S.room.code, { silent: true }).then(d => {
        S.roomMembers = d.members;
        if ($('#rMembers')) $('#rMembers').textContent = d.members.length + ' na sala';
      }).catch(() => {});
      break;
    case 'pep:result':
      toast('✅ PEP de ' + p.user + ': ' + p.score + '%', 'ok');
      if ($('#pepScore')) $('#pepScore').textContent = p.score + '%';
      break;
    case 'dispute:frozen':
      toast('🧊 estação congelada para revisão (' + p.ratio + '% de anulação)', 'err', 7000);
      break;
    case 'station:finish':
      toast('✅ ' + p.by + ' encerrou a estação — anotações dos observadores reveladas', 'info', 7000);
      break;
    case 'room:closed':
      toast('A sala foi encerrada por ' + p.by, 'err', 7000);
      window.rtc?.stop(); stopRealtime(); go('lobby');
      break;
    case 'exams:release':
      toast('🖼 exame liberado para o candidato pela moderação', 'info');
      break;
  }
}

/* ================================ SRS / CARDS ================================= */
async function viewSrs() {
  const d = await api('/api/srs');
  const due = d.cards.filter(c => c.due);
  $('#tabhost').innerHTML = `
  <div class="card">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="text-[16px] font-black text-deep">🧠 Repetição espaçada</h3>
      <span class="badge teal">${d.total} cartões</span>
      <span class="badge coral">${d.due} vencidos hoje</span>
      <span class="badge gray">intervalos: ${d.intervals.join(' · ')} dias</span>
      <button class="btn violet ml-auto" id="srsPick">＋ gerar cartões de uma estação</button>
    </div>
    <p class="hint mt-2">Cada item do PEP vira um cartão (caso clínico + pergunta na frente, abordagem no verso),
    com atalho para a estação associada. “Errei” reinicia em 1 dia; “fácil” avança dois níveis.</p>
  </div>

  <div class="grid gap-4 lg:grid-cols-[1.4fr_1fr] mt-4">
    <div class="card">
      <h3 class="text-[15px] font-black text-deep">Revisar agora (${due.length})</h3>
      <div id="srsStage" class="mt-3"></div>
    </div>
    <div class="card">
      <h3 class="text-[15px] font-black text-deep">Agenda</h3>
      <div class="mt-2 max-h-[420px] scroll-y space-y-1.5" id="srsList"></div>
    </div>
  </div>`;
  $('#srsPick').onclick = pickStationForSrs;
  S.srs = d.cards;
  const q = due.length ? due.slice() : d.cards.slice(0, 6);
  S.srsQueue = q;
  renderSrsStage();
  $('#srsList').innerHTML = d.cards.map(c => `
    <div class="flex items-center gap-2 rounded-lg border border-line bg-white px-2 py-1.5 text-[12.2px]">
      <span class="badge ${c.due ? 'coral' : 'gray'}">${c.due ? 'vencido' : new Date(c.next_due * 1000).toLocaleDateString('pt-BR')}</span>
      <span class="truncate flex-1">${esc((c.front || '').split('\n').pop())}</span>
      <span class="badge violet">n${c.level}</span>
      <span class="badge teal">${esc(c.area || '')}</span></div>`).join('') || '<p class="hint">Nenhum cartão. Gere a partir de uma estação.</p>';
}

function renderSrsStage() {
  const host = $('#srsStage');
  const c = S.srsQueue?.[0];
  if (!c) { host.innerHTML = '<p class="hint">Nada para revisar agora. 🎉</p>'; return; }
  host.innerHTML = `
  <div class="rounded-xl border border-line bg-white p-4">
    <span class="badge violet">cartão · nível ${c.level}</span>
    <span class="badge teal">${esc(c.area || '')}</span>
    <span class="badge gray">${esc(c.tema || '')}</span>
    <p class="mt-3 text-[14px] font-bold leading-relaxed">${nl(c.front)}</p>
    <div id="srsBack" class="hidden mt-3 rounded-xl border border-teal3 bg-teal1/5 p-3 text-[13px]">${nl(c.back)}</div>
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn" id="srsShow">👁 mostrar resposta</button>
      <button class="btn coral sm hidden" data-g="again">errei</button>
      <button class="btn amber sm hidden" data-g="hard">difícil</button>
      <button class="btn sm hidden" data-g="good">acertei</button>
      <button class="btn sky sm hidden" data-g="easy">fácil</button>
      ${c.station_id ? `<button class="btn ghost sm ml-auto" id="srsOpen">abrir estação</button>` : ''}
    </div>
  </div>`;
  $('#srsShow').onclick = () => {
    $('#srsBack').classList.remove('hidden');
    $('#srsShow').classList.add('hidden');
    $$('#srsStage [data-g]').forEach(b => b.classList.remove('hidden'));
  };
  $$('#srsStage [data-g]').forEach(b => b.onclick = async () => {
    const r = await api('/api/srs/review', { method: 'POST', body: { id: c.id, grade: b.dataset.g } });
    toast(r.message);
    S.srsQueue.shift();
    renderSrsStage();
  });
  $('#srsOpen')?.addEventListener('click', () => openStation(c.station_id));
}

function pickStationForSrs() {
  openModal('Gerar cartões a partir de uma estação', `
    <label class="fl">Buscar estação<input class="in" id="srsQ" placeholder="tema…"></label>
    <div id="srsPool" class="mt-2 max-h-[360px] scroll-y space-y-1.5"></div>`, async root => {
    const load = async (q) => {
      const d = await api('/api/stations?limit=40&q=' + encodeURIComponent(q || ''));
      root.querySelector('#srsPool').innerHTML = d.stations.map(s => `
        <button class="w-full text-left rounded-lg border border-line bg-white px-2 py-1.5 text-[12.3px] hover:border-teal2">
          <span class="badge area" style="color:${s.area_color}">${s.area}</span> ${esc(s.tema)}</button>`).join('');
      $$('#srsPool button', root).forEach((b, i) => b.onclick = async () => {
        const s = d.stations[i];
        const r = await api('/api/srs/generate', { method: 'POST', body: { station_id: s.id } });
        toast(r.message); closeModal(); viewSrs();
      });
    };
    root.querySelector('#srsQ').oninput = e => load(e.target.value);
    load('');
  });
}

/* ========================= BIBLIOTECA DE CARDS (fluxograma) ==================== */
async function makeCard(stationId, marks) {
  const m = openModal('🗂️ Gerando card de procedimento…', `
    <p class="hint">A IA resume o contexto da estação (tema, cenário, roteiro e PEP) em uma abordagem
    ponta a ponta — da atenção inicial até a resolução — e o servidor desenha o fluxograma vetorial.</p>
    <div class="mt-3 rounded-xl border border-line bg-white p-4 text-[13px]">⏳ consultando a cadeia de IA…</div>`);
  void m;
  try {
    const r = await api('/api/flowcards', { method: 'POST', body: { station_id: stationId, marks: marks || {} } });
    setAiBadge(r.provider);
    openModal('🗂️ Card de procedimento', `
      <div class="flex flex-wrap items-center gap-2">
        <span class="badge teal">${esc((r.provider || 'local').toUpperCase())}</span>
        ${r.degraded ? '<span class="badge amber">fluxo XABCDE local (IA indisponível)</span>' : '<span class="badge violet">resumo gerado pela IA</span>'}
        <span class="badge gray">salvo na sua biblioteca de cards</span></div>
      <h4 class="mt-2 text-[16px] font-black text-deep">${esc(r.title)}</h4>
      <p class="mt-1 text-[12.8px] leading-relaxed">${nl(r.summary)}</p>
      <div class="card-svg mt-3">
        <object data="${esc(r.card.svg_url)}#token" type="image/svg+xml" class="w-full" style="min-height:260px"></object>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button class="btn" id="cOpen">🔎 ver em tela cheia</button>
        <button class="btn violet" id="cLib">🗂️ abrir minha biblioteca</button>
      </div>`, root => {
      root.querySelector('#cOpen').onclick = () => viewCardFull(r.card.id);
      root.querySelector('#cLib').onclick = () => { closeModal(); go('lib'); };
    });
  } catch (e) {
    openModal('Não foi possível gerar o card', `<p class="text-[12.8px]">${nl(e.message)}</p>
      <p class="hint mt-2">O fluxograma de fallback (XABCDE) continua disponível para consulta nas diretrizes.</p>`);
  }
}

async function viewCardFull(id) {
  try {
    const res = await fetch('/cards/' + encodeURIComponent(id) + '.svg', { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const svg = await res.text();
    $('#imgSlot').innerHTML = svg;
    $('#imgview').classList.remove('hidden');
    $('#imgview').classList.add('flex');
  } catch (e) { toast('Falha ao abrir o fluxograma: ' + e.message, 'err'); }
}

async function viewLib() {
  const d = await api('/api/flowcards?q=' + encodeURIComponent(S.libQ || ''));
  $('#tabhost').innerHTML = `
  <div class="card">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="text-[16px] font-black text-deep">🗂️ Minha biblioteca de cards</h3>
      <span class="badge teal">${d.cards.length}</span>
      <input class="in !w-[260px] ml-auto" id="libQ" placeholder="buscar no título, tema ou resumo…" value="${esc(S.libQ || '')}">
      <button class="btn ghost sm" id="libGo">🔎 buscar</button>
    </div>
    <p class="hint mt-2">Cada card guarda o resumo prático de abordagem ponta a ponta + o fluxograma vetorial da diretriz,
    prontos para imprimir em PDF e levar para o plantão.</p>
  </div>
  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mt-4">
    ${d.cards.map(c => `
      <div class="card raise !p-3">
        <div class="flex items-center gap-2">
          <span class="badge violet">${esc(c.kind || 'procedimento')}</span>
          <span class="badge gray">${new Date(c.created_at * 1000).toLocaleDateString('pt-BR')}</span>
        </div>
        <b class="block mt-1.5 text-[13.5px] leading-snug">${esc(c.title || c.tema)}</b>
        <p class="mt-1 text-[12.2px] text-mut line-clamp-3">${esc((c.summary || '').slice(0, 220))}</p>
        <div class="mt-2 flex flex-wrap gap-2">
          <button class="btn sm" data-see="${esc(c.id)}">👁 fluxograma</button>
          ${c.station_id ? `<button class="btn ghost sm" data-st="${esc(c.station_id)}">📚 estação</button>` : ''}
          <button class="btn coral sm" data-rm="${esc(c.id)}">🗑</button>
        </div>
      </div>`).join('') || '<div class="card md:col-span-3"><p class="hint">Sua biblioteca está vazia. Abra uma estação no catálogo e use “🗂️ card”.</p></div>'}
  </div>`;
  $('#libGo').onclick = () => { S.libQ = $('#libQ').value.trim(); viewLib(); };
  $$('#tabhost [data-see]').forEach(b => b.onclick = () => viewCardFull(b.dataset.see));
  $$('#tabhost [data-st]').forEach(b => b.onclick = () => openStation(b.dataset.st));
  $$('#tabhost [data-rm]').forEach(b => b.onclick = async () => {
    if (!confirm('Remover este card da biblioteca?')) return;
    await api('/api/flowcards/' + b.dataset.rm, { method: 'DELETE' });
    toast('Card removido'); viewLib();
  });
}

/* ================================= DESEMPENHO ================================= */
async function viewKpi() {
  const d = await api('/api/analytics');
  const res = (await api('/api/pep/results')).results;
  $('#tabhost').innerHTML = `
  <div class="card">
    <h3 class="text-[16px] font-black text-deep">📊 Analytics</h3>
    <div class="mt-3 grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      ${kpi('Treinos', d.kpis.treinos, '🎯')}${kpi('Nota média', d.kpis.media + '%', '⭐')}
      ${kpi('Tempo', d.kpis.tempo_min + ' min', '⏱')}${kpi('Concluídas', d.kpis.estacoes_concluidas, '✅')}
      ${kpi('Catálogo', d.kpis.estacoes_catalogo, '📚')}${kpi('Salas', d.kpis.salas, '🚪')}
    </div>
  </div>
  <div class="grid gap-4 lg:grid-cols-2 mt-4">
    <div class="card"><h3 class="text-[15px] font-black text-deep">Aproveitamento por grande área</h3>
      <div class="bars mt-2">${d.bars.map(b => `<div class="col">
        <span class="text-[11px] font-black" style="color:${b.color}">${b.media}%</span>
        <div class="bar" style="height:${Math.max(3, b.media)}%;background:linear-gradient(180deg,${b.color}cc,${b.color})"></div>
        <span class="badge area" style="color:${b.color}">${b.area} · ${b.treinos}</span></div>`).join('')}</div></div>
    <div class="card"><h3 class="text-[15px] font-black text-deep">Desempenho global</h3>
      <div class="mt-3 flex items-center gap-4">
        <div class="donut" style="--p:${d.donut.global}"><b>${d.donut.global}%</b></div>
        <div class="text-[12.5px]"><p>Rosca de desempenho global (todos os treinos avaliados).</p>
        <button class="btn violet sm mt-2" id="kCoach">🤖 coach de desempenho</button></div></div>
      <div id="kCoachOut" class="mt-3 hidden rounded-xl border border-line bg-white p-3 text-[12.5px]"></div></div>
  </div>
  <div class="card mt-4">
    <div class="flex items-center gap-2"><h3 class="text-[15px] font-black text-deep">Histórico de estações</h3>
      <button class="btn ghost sm ml-auto" id="kPrint">🖨 resumo em PDF</button></div>
    <div class="mt-2 overflow-x-auto"><table class="tb"><thead><tr>
      <th>Estação</th><th>Área</th><th>Nota</th><th>Data</th><th></th></tr></thead><tbody>
      ${res.map(r => `<tr><td>${esc(r.tema || '—')}</td>
        <td><span class="badge area" style="color:${areaColor(r.area)}">${esc(r.area || '')}</span></td>
        <td><b>${r.score}%</b></td><td class="text-mut">${new Date(r.created_at * 1000).toLocaleString('pt-BR')}</td>
        <td><button class="btn ghost sm" data-detail="${r.id}">ver justificativas</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="text-mut">Sem resultados.</td></tr>'}
    </tbody></table></div>
  </div>`;
  $('#kCoach').onclick = async (ev) => {
    ev.target.disabled = true;
    const r = await api('/api/ai/coach', { method: 'POST' });
    setAiBadge(r.provider);
    const o = $('#kCoachOut'); o.classList.remove('hidden');
    o.innerHTML = `<div class="text-[11px] font-black text-mut">PROVEDOR: ${esc((r.provider || 'local').toUpperCase())} · média ${r.media}%</div>` + mdLite(r.coach);
    ev.target.disabled = false;
  };
  $('#kPrint').onclick = () => openModal('🖨 Resumo final da estação', `
    <div class="text-[12.6px]">${res.slice(0, 20).map(r => `
      <div class="mb-3 border-b border-line pb-2"><b>${esc(r.tema)}</b> — <b>${r.score}%</b>
      <div class="text-mut">${new Date(r.created_at * 1000).toLocaleString('pt-BR')}</div></div>`).join('')}</div>
    <button class="btn mt-2" onclick="window.print()">🖨 imprimir / salvar PDF</button>`);
  $$('#tabhost [data-detail]').forEach(b => b.onclick = () => {
    const r = res.find(x => String(x.id) === b.dataset.detail);
    openModal('Justificativas — ' + (r.tema || ''), `<div class="text-[12.6px] space-y-2">
      ${(r.notes || []).map(d => `<div class="rounded-lg border ${d.cumprido ? 'border-teal3 bg-teal1/5' : 'border-line'} p-2">
        <b>${d.cumprido ? '✔' : '✘'} ${d.idx}. ${esc(d.item)}</b>
        ${d.citacao ? `<div class="text-mut mt-1">“${esc(d.citacao)}”</div>` : ''}
        ${d.justificativa ? `<div class="mt-1">${esc(d.justificativa)}</div>` : ''}</div>`).join('')
      || '<p class="hint">Sem detalhamento (nota marcada manualmente).</p>'}</div>`);
  });
}

/* ============================ GESTÃO (ROOT/ADMIN) ============================= */
async function viewAdmin() {
  const boot = await api('/api/admin/users');
  $('#tabhost').innerHTML = `
  <div class="card">
    <div class="flex items-center gap-2">
      <h3 class="text-[16px] font-black text-deep">🛡️ Gestão</h3>
      <span class="badge teal">${esc(S.user.role)}</span>
      ${S.user.role === 'root' ? '<span class="badge violet">root master — promove/revoga admins</span>' : '<span class="badge gray">acesso administrativo</span>'}
    </div>
    <div class="mt-3 flex gap-1.5 rounded-2xl bg-teal1/8 p-1.5 text-[12.5px] font-bold">
      <button class="tabbtn is-on" data-at="ai">🤖 Cadeia de IA</button>
      <button class="tabbtn" data-at="users">👥 Usuários & RBAC</button>
      <button class="tabbtn" data-at="stations">📚 Estações & importação</button>
      <button class="tabbtn" data-at="disputes">⚖ Contestações</button>
      <button class="tabbtn" data-at="ops">📋 Auditoria & chats</button>
    </div>
  </div>
  <div id="adminPane" class="mt-4"></div>`;
  $$('#tabhost [data-at]').forEach(b => b.onclick = () => {
    $$('#tabhost [data-at]').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on');
    adminPane(b.dataset.at);
  });
  adminPane('ai');
}

async function adminPane(which) {
  const host = $('#adminPane');
  host.innerHTML = '<div class="card">Carregando…</div>';
  if (which === 'ai') {
    const st = await api('/api/ai/status');
    const lg = await api('/api/ai/logs');
    host.innerHTML = `
    <div class="card">
      <div class="flex items-center gap-2">
        <h3 class="text-[15px] font-black text-deep">Diagnóstico real da cadeia</h3>
        <span class="badge gray">ordem: ${st.chain.join(' → ')}</span>
        <button class="btn sm ml-auto" id="aiRetest">↻ testar provedores ao vivo</button>
      </div>
      <div class="grid gap-3 md:grid-cols-3 mt-3">
        ${st.providers.map(p => `
          <div class="card !p-3">
            <div class="flex items-center gap-2"><b class="text-[13px]">${esc(p.provider)}</b>
              <span class="badge ${p.ok ? 'teal' : p.configured ? 'coral' : 'amber'} ml-auto">
                ${p.ok ? '✔ ok' : p.configured ? '✘ falhou' : '— sem chave'}</span></div>
            <div class="mt-1 text-[11.5px] text-mut">modelo: ${esc(p.model || '—')}</div>
            ${p.latency_ms ? `<div class="text-[11.5px]">latência: <b>${p.latency_ms} ms</b></div>` : ''}
            ${p.sample ? `<div class="text-[11.5px]">amostra: “${esc(p.sample)}”</div>` : ''}
            ${p.error ? `<div class="text-[11.5px] text-coral mt-1">${esc(p.error)}</div>` : ''}
            ${!p.configured ? '<div class="hint mt-1">defina a chave no <b>.env</b> do servidor</div>' : ''}
          </div>`).join('')}
      </div>
      <div class="mt-3 overflow-x-auto">
        <table class="tb"><thead><tr><th>quando</th><th>provedor</th><th>modelo</th><th>finalidade</th><th>latência</th><th>erro</th></tr></thead>
        <tbody>${lg.logs.slice(0, 40).map(l => `<tr>
          <td class="text-mut">${new Date(l.created_at * 1000).toLocaleTimeString('pt-BR')}</td>
          <td><span class="badge ${l.ok ? 'teal' : 'coral'}">${esc(l.provider)}</span></td>
          <td>${esc(l.model || '')}</td><td>${esc(l.purpose)}</td><td>${l.latency_ms} ms</td>
          <td class="text-coral">${esc((l.error || '').slice(0, 90))}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>`;
    $('#aiRetest').onclick = () => adminPane('ai');
  }

  if (which === 'users') {
    const d = await api('/api/admin/users');
    host.innerHTML = `
    <div class="card">
      <h3 class="text-[15px] font-black text-deep">Usuários, papéis e auditoria</h3>
      <p class="hint">Root promove/revoga administradores (set_role). A conta root é imune a exclusões e rebaixamento.</p>
      <table class="tb mt-2"><thead><tr><th>id</th><th>nome</th><th>e-mail</th><th>papel</th><th>criado</th><th>ação</th></tr></thead>
      <tbody>${d.users.map(u => `<tr>
        <td>${u.id}</td><td>${esc(u.avatar)} ${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td><span class="badge ${u.role === 'root' ? 'violet' : u.role === 'admin' ? 'teal' : 'gray'}">${esc(u.role)}</span></td>
        <td class="text-mut">${new Date(u.created_at * 1000).toLocaleDateString('pt-BR')}</td>
        <td>${S.user.role === 'root' && u.role !== 'root' ? `
          <select class="sel !w-[140px]" data-role="${esc(u.email)}">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>usuário</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>administrador</option>
          </select>` : '<span class="hint">—</span>'}</td></tr>`).join('')}</tbody></table>
    </div>`;
    $$('#adminPane [data-role]').forEach(sel => sel.onchange = async () => {
      await api('/api/admin/set_role', { method: 'POST', body: { email: sel.dataset.role, role: sel.value } });
      toast('Papel atualizado'); adminPane('users');
    });
  }

  if (which === 'stations') {
    const d = await api('/api/stations?limit=8');
    host.innerHTML = `
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card">
        <h3 class="text-[15px] font-black text-deep">Importação massiva</h3>
        <p class="hint">XLSX (aba “Estações”, cabeçalho flexível com aliases) ou JSON exportado pela plataforma.
        Deduplicação automática; <b>overwrite</b> atualiza pelo id e devolve o relatório de criadas/atualizadas/ignoradas.</p>
        <label class="flex items-center gap-2 mt-2 text-[12.5px] font-bold"><input type="checkbox" id="admOvw"> sobrescrever ids existentes</label>
        <input type="file" id="admFile" class="in mt-2" accept=".xlsx,.xls,.json,.csv">
        <button class="btn mt-2" id="admGo">⬆ Importar arquivo</button>
        <button class="btn ghost mt-2" id="admSync">🔄 Sincronizar a planilha do servidor (data/estacoes.xlsx)</button>
        <div id="admOut" class="mt-3 text-[12.4px]"></div>
      </div>
      <div class="card">
        <h3 class="text-[15px] font-black text-deep">Exportar pacote de estações</h3>
        <p class="hint">Gera um JSON reimportável (todas as estações ou uma grande área) e já compatível com o importador.</p>
        <div class="mt-2 flex flex-wrap gap-2">
          ${Object.keys(areaLabelMap()).map(a => `<button class="btn ghost sm" data-exp="${a}">⬇ ${a}</button>`).join('')}
          <button class="btn sm" id="admExpAll">⬇ todas</button>
        </div>
        <div class="mt-3 grid grid-cols-3 gap-2">
          ${Object.entries(d.by_area || {}).map(([a, n]) => `<div class="kpi"><b>${n}</b><span>${a} — ${esc(areaLabel(a))}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
    $('#admGo').onclick = async () => {
      const f = $('#admFile').files[0];
      if (!f) return toast('Escolha um arquivo', 'err');
      const rows = /\.(xlsx|xls)$/i.test(f.name) ? await sheetToRows(f) : JSON.parse(await f.text());
      const list = Array.isArray(rows) ? rows : (rows.estacoes || rows.rows || []);
      const r = await api('/api/stations/import', { method: 'POST', body: { rows: list, overwrite: $('#admOvw').checked ? '1' : '0', source: f.name } });
      $('#admOut').innerHTML = `<b class="text-deep">${esc(r.message)}</b>`;
      toast(r.message);
    };
    $('#admSync').onclick = async () => {
      const r = await api('/api/stations/sync', { method: 'POST' });
      $('#admOut').innerHTML = `<b>planilha sincronizada:</b> ${r.created} criadas · ${r.updated} atualizadas · ${r.skipped} ignoradas`;
    };
    $$('#adminPane [data-exp]').forEach(b => b.onclick = () => downloadExport('/api/stations/export?area=' + b.dataset.exp));
    $('#admExpAll').onclick = () => downloadExport('/api/stations/export');
  }

  if (which === 'disputes') {
    const d = await api('/api/disputes');
    host.innerHTML = `
    <div class="card">
      <h3 class="text-[15px] font-black text-deep">Contestações de PEP</h3>
      <p class="hint">Anulação acima de 40% dos itens congela a estação automaticamente e a envia para revisão aqui.</p>
      <table class="tb mt-2"><thead><tr><th>id</th><th>estação</th><th>item</th><th>motivo</th><th>por</th><th>status</th><th></th></tr></thead>
      <tbody>${d.disputes.map(x => `<tr>
        <td>${x.id}</td><td>${esc(x.tema || x.station_id)}</td><td>${x.item_idx}</td>
        <td>${esc((x.reason || '').slice(0, 90))}</td><td>${esc(x.user_name || '')}</td>
        <td><span class="badge ${x.status === 'closed' ? 'teal' : x.status === 'review' ? 'coral' : 'amber'}">${esc(x.status)}</span></td>
        <td>${x.status !== 'closed' ? `<button class="btn sm" data-close="${x.id}">resolver</button>` : `<button class="btn ghost sm" data-reopen="${x.id}">reabrir</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="text-mut">Nenhuma contestação.</td></tr>'}</tbody></table>
    </div>`;
    $$('#adminPane [data-close]').forEach(b => b.onclick = async () => {
      await api('/api/disputes/' + b.dataset.close, { method: 'POST', body: { action: 'close' } });
      toast('Contestação resolvida (estação descongelada se não houver outras abertas)'); adminPane('disputes');
    });
    $$('#adminPane [data-reopen]').forEach(b => b.onclick = async () => {
      await api('/api/disputes/' + b.dataset.reopen, { method: 'POST', body: { action: 'reopen' } });
      adminPane('disputes');
    });
  }

  if (which === 'ops') {
    const a = await api('/api/admin/audit');
    let archive = { archive: [] };
    try { archive = await api('/api/chat/archive'); } catch (_) {}
    host.innerHTML = `
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card">
        <h3 class="text-[15px] font-black text-deep">Auditoria</h3>
        <div class="mt-2 max-h-[420px] scroll-y overflow-x-auto"><table class="tb">
          <thead><tr><th>id</th><th>ator</th><th>ação</th><th>alvo</th><th>quando</th></tr></thead>
          <tbody>${a.audit.map(x => `<tr><td>${x.id}</td><td>${esc(x.actor_name || '')}</td>
            <td><span class="badge teal">${esc(x.action)}</span></td><td class="text-mut">${esc((x.target || '').slice(0, 40))}</td>
            <td class="text-mut">${new Date(x.created_at * 1000).toLocaleString('pt-BR')}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card">
        <h3 class="text-[15px] font-black text-deep">Chats arquivados</h3>
        <p class="hint">Lobby arquivado por hora; chats de sala indexados no momento do envio.</p>
        <div class="mt-2 max-h-[420px] scroll-y space-y-1.5 text-[12.3px]">
          ${archive.archive.map(c => `<div class="rounded-lg border border-line bg-white px-2 py-1.5">
            <b>${esc(c.user_name)}</b> <span class="badge gray">${esc(c.scope)}</span>
            <span class="text-mut">${esc(c.ref)}</span>
            <div>${nl(c.text)}</div></div>`).join('') || '<p class="hint">Sem mensagens arquivadas.</p>'}
        </div>
      </div>
    </div>`;
  }
}

/* =================================== PERFIL =================================== */
async function viewPerfil() {
  $('#tabhost').innerHTML = `
  <div class="grid gap-4 lg:grid-cols-2">
    <div class="card">
      <h3 class="text-[16px] font-black text-deep">Meu perfil</h3>
      <p class="hint">Avatar por emoji, dados pessoais e troca de senha. O layout dos quadros do painel também é salvo aqui.</p>
      <div class="mt-3 grid gap-3 md:grid-cols-2">
        <label class="fl">Nome<input class="in" id="pfName" value="${esc(S.user.name)}"></label>
        <label class="fl">E-mail<input class="in" value="${esc(S.user.email)}" disabled></label>
        <label class="fl">Avatar (emoji)<input class="in" id="pfAvatar" value="${esc(S.user.avatar)}" maxlength="4"></label>
        <label class="fl">Nova senha (opcional)<input class="in" type="password" id="pfPass" placeholder="••••••"></label>
      </div>
      <div class="mt-3 flex flex-wrap gap-2" id="avatarPick">
        ${['🩺', '👩‍⚕️', '👨‍⚕️', '🧑‍⚕️', '🦷', '💉', '🧠', '🫀', '🩻', '🧪', '👑', '🐧'].map(e =>
          `<button class="btn ghost sm !text-[16px]" data-av="${e}">${e}</button>`).join('')}
      </div>
      <button class="btn mt-3" id="pfSave">💾 Salvar perfil</button>
    </div>
    <div class="card">
      <h3 class="text-[16px] font-black text-deep">Segurança & sessão</h3>
      <div class="mt-2 text-[12.6px] space-y-1.5">
        <p>Sessão atual: <span class="badge teal">Bearer Token</span> válida por até <b>30 dias</b>.</p>
        <p>Senhas: <span class="badge violet">bcrypt</span> no servidor, nunca em texto claro.</p>
        <p>Papel: <span class="badge teal">${esc(S.user.role)}</span>${S.user.role === 'root' ? ' — conta mestre imune a exclusões.' : ''}</p>
        <p class="text-mut">Chaves de IA vivem apenas no <b>.env</b> do servidor; o navegador só conversa com <b>/api/ai/*</b>.</p>
      </div>
      <button class="btn coral mt-3" id="pfLogout">Encerrar sessão</button>
    </div>
  </div>`;
  $$('#avatarPick [data-av]').forEach(b => b.onclick = () => { $('#pfAvatar').value = b.dataset.av; });
  $('#pfSave').onclick = async () => {
    const body = { name: $('#pfName').value.trim(), avatar: $('#pfAvatar').value.trim() };
    if ($('#pfPass').value) body.pass = $('#pfPass').value;
    const r = await api('/api/profile', { method: 'POST', body });
    S.user = r.user;
    $('#userAvatar').textContent = S.user.avatar;
    $('#userName').textContent = S.user.name.split(' ')[0];
    toast('Perfil atualizado');
  };
  $('#pfLogout').onclick = () => logout();
}

/* ==================================== BOOT ==================================== */
function setAiBadge(p) {
  if (!p) return;
  const b = $('#aiBadge');
  if (b) { b.classList.remove('hidden'); $('#aiBadgeText').textContent = p; }
}

async function boot() {
  try {
    const m = await api('/api/meta', { silent: true });
    S.meta = m;
    const st = $('#authStats');
    if (st) st.innerHTML = `
      ${kpi('Estações', m.meta.stations, '📚')}${kpi('Salas', m.meta.rooms, '🚪')}${kpi('Usuários', m.meta.users, '👥')}`;
  } catch (_) {}

  // abas de autenticação
  $$('[data-authtab]').forEach(b => b.onclick = () => {
    $$('[data-authtab]').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on');
    ['login', 'register', 'forgot', 'reset'].forEach(t => $('#form' + t[0].toUpperCase() + t.slice(1))?.classList.add('hidden'));
    $('#form' + b.dataset.authtab[0].toUpperCase() + b.dataset.authtab.slice(1)).classList.remove('hidden');
  });

  const msg = $('#authMsg');
  const bindForm = (id, fn) => {
    $(id).onsubmit = async e => {
      e.preventDefault();
      msg.textContent = '';
      const data = Object.fromEntries(new FormData(e.target));
      try { await fn(data); } catch (err) { msg.innerHTML = '<span class="text-coral">' + esc(err.message) + '</span>'; }
    };
  };
  bindForm('#formLogin', async d => {
    const r = await api('/api/login', { method: 'POST', body: d });
    setToken(r.token); S.user = r; toast('Bem-vindo, ' + r.name); showApp();
  });
  bindForm('#formRegister', async d => {
    const r = await api('/api/register', { method: 'POST', body: d });
    setToken(r.token); S.user = r; toast('Conta criada — bom treino!'); showApp();
  });
  bindForm('#formForgot', async d => {
    const r = await api('/api/forgot', { method: 'POST', body: d });
    const out = $('#forgotOut');
    out.classList.remove('hidden');
    out.innerHTML = esc(r.message) + (r.reset_token
      ? `<div class="mt-2">token: <b>${esc(r.reset_token)}</b>
         <button class="btn sm ml-2" id="useToken">usar agora</button></div>
         <p class="hint">Em produção o token vai por e-mail — defina RESET_SHOW_TOKEN=0.</p>`
      : '');
    $('#useToken')?.addEventListener('click', () => {
      $$('[data-authtab]').find(b => b.dataset.authtab === 'reset').click();
      $('#formReset [name=token]').value = r.reset_token;
    });
  });
  bindForm('#formReset', async d => {
    const r = await api('/api/reset', { method: 'POST', body: d });
    msg.innerHTML = '<span class="text-deep font-black">' + esc(r.message) + '</span>';
  });

  // sessão de URL (link de reset)
  const url = new URL(location.href);
  if (url.searchParams.get('reset')) {
    $$('[data-authtab]').find(b => b.dataset.authtab === 'reset')?.click();
    const f = $('#formReset [name=token]');
    if (f) f.value = url.searchParams.get('reset');
  }

  $('#brandBtn').onclick = () => S.user ? go('dash') : null;
  $('#userChip').onclick = () => S.user && go('perfil');
  $('#btnLogout').onclick = () => logout();
  $('#btnMenu').onclick = () => {
    if (!S.user) return;
    openModal('Menu', `<div class="grid gap-2 sm:grid-cols-2">${NAV.filter(n => !n[2] || n[2].includes(S.user.role))
      .map(([k, label]) => `<button class="btn ghost" data-m="${k}">${label}</button>`).join('')}</div>`, root => {
      $$('[data-m]', root).forEach(b => b.onclick = () => { closeModal(); go(b.dataset.m); });
    });
  };

  // sessão existente
  if (S.token) {
    try {
      const me = await api('/api/me', { silent: true });
      S.user = me.user;
      if (S.user.layout) S.meta.layout = S.user.layout;
      showApp();
      return;
    } catch (_) { setToken(''); }
  }
  $('#view-auth').classList.remove('hidden');
  $$('[data-authtab]')[0]?.classList.add('is-on');
}

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('beforeunload', () => { try { S.es?.close(); } catch (_) {} });
