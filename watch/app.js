// Revalida Relógio: versão compacta para smartwatch (tela pequena, botões grandes).
// Faz: entrar, ver suas salas, cronômetro com vibração (1 min e fim), iniciar/pausar, e (chefe) liberar/bloquear áudio dos observadores.
// Não faz: marcar o checklist PEP nem vídeo (use o celular/computador). Toda regra continua no servidor.
import { acaoDoTimer, alertaVibracao, controlaTimer, corDoTimer, ehChefe, estadoTexto, fmt } from './logica.js';

const RAIZ = document.getElementById('app');
let token = null; try { token = localStorage.getItem('rv-watch'); } catch { /* sem storage */ }
let sala = null; let iv = null;

const api = async (url, { metodo = 'GET', corpo } = {}) => {
  const r = await fetch(url, { method: metodo, headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { sair(); throw new Error('Sessão encerrada.'); }
  if (!r.ok) throw new Error(d.erro || 'Algo deu errado.');
  return d;
};
const el = (html) => { RAIZ.innerHTML = html; return RAIZ; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sair() { token = null; try { localStorage.removeItem('rv-watch'); } catch { /* ok */ } parar(); telaEntrar(); }
function parar() { clearInterval(iv); iv = null; sala = null; }

function telaEntrar(msg = '') {
  el(`<h1>Revalida</h1><input id="e" type="email" placeholder="e-mail" autocomplete="username"><input id="s" type="password" placeholder="senha" autocomplete="current-password">
    <div class="erro" role="alert">${esc(msg)}</div><button id="b">Entrar</button>`);
  const ir = async () => {
    try {
      const r = await api('/api/auth/entrar', { metodo: 'POST', corpo: { email: document.getElementById('e').value, senha: document.getElementById('s').value } });
      token = r.token; try { localStorage.setItem('rv-watch', token); } catch { /* ok */ }
      telaSalas();
    } catch (e) { telaEntrar(e.message); }
  };
  document.getElementById('b').onclick = ir;
  document.getElementById('s').onkeydown = (e) => e.key === 'Enter' && ir();
}

async function telaSalas() {
  parar();
  el('<h1>Minhas salas</h1><div class="sub">carregando…</div>');
  try {
    const l = (await api('/api/sessoes')).filter((s) => s.status !== 'finalizada').slice(0, 6);
    el(`<h1>Minhas salas</h1>${l.length ? l.map((s) => `<button class="sala" data-id="${esc(s.id)}">${esc(s.titulo)}<div class="sub">${s.status === 'em_andamento' ? 'ao vivo' : 'aguardando'}</div></button>`).join('')
      : '<div class="sub">Nenhuma sala ativa. Crie uma no celular ou no computador.</div>'}<button class="cinza" id="x">Sair</button>`);
    RAIZ.querySelectorAll('.sala').forEach((b) => { b.onclick = () => abrirSala(b.dataset.id); });
    document.getElementById('x').onclick = sair;
    const c = document.createElement('button'); c.className = 'cinza'; c.textContent = 'App completo';
    c.onclick = () => { try { localStorage.setItem('rv-modo', 'completo'); } catch { /* ok */ } window.location.href = '/'; };
    RAIZ.appendChild(c);
  } catch (e) { if (token) el(`<div class="erro" role="alert">${esc(e.message)}</div><button id="r">Tentar de novo</button>`).querySelector('#r').onclick = telaSalas; }
}

async function abrirSala(id) {
  parar();
  let d;
  try { d = await api(`/api/sessoes/${id}`); } catch (e) { return telaSalas(); }
  const total = d.sessao.duracao_min * 60000;
  sala = { id, papel: d.meuPapel, modo: d.sessao.modo, total, timer: d.timer, audioObs: !!d.sessao.audio_observadores, titulo: d.sessao.titulo };
  let ultimoSync = Date.now();
  const desenhar = () => {
    const { timer, papel, modo } = sala;
    const a = acaoDoTimer(timer, total);
    el(`<div class="sub">${esc(sala.titulo)}</div><div class="tempo ${corDoTimer(timer.restante_ms)}" role="timer">${fmt(timer.restante_ms)}</div><div class="sub">${estadoTexto(timer, total)}</div>
      ${controlaTimer(papel, modo) && timer.restante_ms > 0 ? `<button id="t" class="menta">${a.rotulo}</button>` : ''}
      ${ehChefe(papel, modo) ? `<button id="au" aria-pressed="${sala.audioObs}">Áudio dos observadores: ${sala.audioObs ? 'LIBERADO' : 'bloqueado'}</button>` : ''}
      <div class="erro" id="er" role="alert"></div><button class="cinza" id="v">Voltar</button>`);
    document.getElementById('v').onclick = telaSalas;
    const t = document.getElementById('t');
    if (t) t.onclick = async () => { try { sala.timer = await api(`/api/sessoes/${id}/timer`, { metodo: 'POST', corpo: { acao: a.acao } }); desenhar(); } catch (e) { document.getElementById('er').textContent = e.message; } };
    const au = document.getElementById('au');
    if (au) au.onclick = async () => { try { const r = await api(`/api/sessoes/${id}/audio-observadores`, { metodo: 'PATCH', corpo: { liberado: !sala.audioObs } }); sala.audioObs = r.audio_observadores; desenhar(); } catch (e) { document.getElementById('er').textContent = e.message; } };
  };
  desenhar();
  iv = setInterval(async () => {
    if (!sala) return;
    const antes = sala.timer.restante_ms;
    if (sala.timer.status === 'rodando') sala.timer = { ...sala.timer, restante_ms: Math.max(0, antes - 1000) };
    if (Date.now() - ultimoSync > 4000) { // reconcilia com o servidor
      ultimoSync = Date.now();
      try { const n = await api(`/api/sessoes/${id}`); sala.timer = n.timer; sala.audioObs = !!n.sessao.audio_observadores; } catch { /* mantém contagem local */ }
    }
    const v = alertaVibracao(antes, sala.timer.restante_ms);
    if (v) navigator.vibrate?.(v);
    const r = RAIZ.querySelector('[role=timer]');
    if (r) { r.textContent = fmt(sala.timer.restante_ms); r.className = `tempo ${corDoTimer(sala.timer.restante_ms)}`; }
    const au = document.getElementById('au');
    if (au && au.getAttribute('aria-pressed') !== String(sala.audioObs)) desenhar();
  }, 1000);
}

token ? telaSalas() : telaEntrar();
