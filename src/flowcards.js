'use strict';
/**
 * Cards de procedimento com fluxograma vetorial (SVG gerado no servidor).
 * O "spec" (título + passos) vem da IA; se a IA falhar usa-se o template XABCDE local.
 * NENHUM dado ilustrativo falso: o fluxograma deriva apenas do spec real (IA ou
 * protocolo XABCDE) e o resumo é construído a partir do CONTEXTO do próprio card.
 */
const { db, now, jenc, jdec } = require('./db');

const FLOW_COLORS = {
  inicio: '#0d9488', avaliacao: '#0284c7', conduta: '#d97706',
  alerta: '#e11d48', reavaliacao: '#7c3aed', default: '#0f766e',
};

/** Template local XABCDE — protocolo real de avaliação inicial (não é dado fake). */
function xabcdeSpec(title) {
  return {
    title: title || 'Avaliação inicial — XABCDE',
    fonte: 'Protocolo XABCDE (template local)',
    steps: [
      { t: 'inicio', text: 'X — Hemorragia exsanguinante: identificar e controlar imediatamente (compressão, torniquete).' },
      { t: 'avaliacao', text: 'A — Vias aéreas: permeabilidade, proteção e necessidade de via definitiva.' },
      { t: 'avaliacao', text: 'B — Respiração: FR, SpO₂, expansibilidade, ausculta; O₂ e suporte ventilatório se indicado.' },
      { t: 'avaliacao', text: 'C — Circulação: pulso, PA, perfusão; 2 acessos venosos, reposição volêmica, hemostasia.' },
      { t: 'avaliacao', text: 'D — Neurológico: Glasgow, pupilas, glicemia capilar; corrigir hipoglicemia.' },
      { t: 'avaliacao', text: 'E — Exposição: despir e examinar por completo, prevenindo hipotermia.' },
      { t: 'conduta', text: 'Conduta dirigida à hipótese diagnóstica principal, conforme protocolo da estação.' },
      { t: 'reavaliacao', text: 'Reavaliar continuamente e registrar: exames complementares, monitorização e evolução.' },
    ],
  };
}

function wrap(s, max) {
  const words = String(s || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (t.length > max && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Desenha o fluxograma vertical em SVG — nítido em qualquer tela e impressão. */
function specToSvg(spec) {
  const W = 720, BX = 90, BW = W - 2 * BX, PAD = 18, STEP_H_MIN = 64, ARROW = 34;
  const steps = (spec.steps || []).map((st) => ({
    t: st.t || 'default',
    lines: wrap(st.text, 46).slice(0, 5),
  }));
  if (!steps.length) steps.push({ t: 'default', lines: ['Sem passos definidos.'] });

  const titleLines = wrap(spec.title || 'Fluxograma', 40).slice(0, 2);
  let y = 24 + titleLines.length * 34 + 14;
  const boxes = steps.map((st) => {
    const h = Math.max(STEP_H_MIN, PAD * 2 + st.lines.length * 21);
    const box = { ...st, y, h };
    y += h + ARROW;
    return box;
  });
  const H = y + (spec.fonte ? 34 : 10);

  let body = '';
  titleLines.forEach((ln, i) => {
    body += `<text x="${W / 2}" y="${44 + i * 34}" text-anchor="middle" font-size="${i ? 22 : 26}" font-weight="800" fill="#0f766e" font-family="system-ui,Segoe UI,sans-serif">${esc(ln)}</text>`;
  });
  boxes.forEach((b, i) => {
    const c = FLOW_COLORS[b.t] || FLOW_COLORS.default;
    if (i > 0) {
      const py = b.y - ARROW;
      body += `<line x1="${W / 2}" y1="${py}" x2="${W / 2}" y2="${b.y - 8}" stroke="#94a3b8" stroke-width="2.5"/>`;
      body += `<path d="M ${W / 2 - 7} ${b.y - 12} L ${W / 2 + 7} ${b.y - 12} L ${W / 2} ${b.y} Z" fill="#94a3b8"/>`;
    }
    body += `<rect x="${BX}" y="${b.y}" width="${BW}" height="${b.h}" rx="14" fill="#ffffff" stroke="${c}" stroke-width="2.5"/>`;
    body += `<rect x="${BX}" y="${b.y}" width="7" height="${b.h}" rx="3.5" fill="${c}"/>`;
    body += `<text x="${BX + 22}" y="${b.y + 17}" font-size="10.5" font-weight="800" letter-spacing="1.6" fill="${c}" font-family="system-ui,sans-serif">${esc(b.t.toUpperCase())}</text>`;
    b.lines.forEach((ln, li) => {
      body += `<text x="${BX + 22}" y="${b.y + PAD + 22 + li * 21}" font-size="15" fill="#134e4a" font-family="system-ui,Segoe UI,sans-serif">${esc(ln)}</text>`;
    });
  });
  if (spec.fonte) {
    body += `<text x="${W / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="#64748b" font-family="system-ui,sans-serif">Fonte: ${esc(spec.fonte)}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.title)}"><rect width="${W}" height="${H}" rx="18" fill="#f0fdfa"/>${body}</svg>`;
}

/** Resumo prático derivado do CONTEXTO do fluxograma (sem inventar dados). */
function summaryFromSpec(spec) {
  const parts = (spec.steps || []).map((s, i) => `${i + 1}. ${s.text}`);
  return [`${spec.title}`, spec.fonte ? `Fonte: ${spec.fonte}` : '', ...parts].filter(Boolean).join('\n');
}

function saveCard(userId, stationId, spec) {
  const info = db.prepare(`INSERT INTO flow_cards(user_id,station_id,title,spec,summary,created_at)
    VALUES(?,?,?,?,?,?)`)
    .run(userId, stationId || '', spec.title || 'Fluxograma', jenc(spec), summaryFromSpec(spec), now());
  return db.prepare('SELECT * FROM flow_cards WHERE id = ?').get(info.lastInsertRowid);
}

function cardSvg(id, userId, role) {
  const c = db.prepare('SELECT * FROM flow_cards WHERE id = ?').get(id);
  if (!c) return null;
  if (c.user_id !== userId && !['root', 'admin'].includes(role)) return null;
  return specToSvg(jdec(c.spec, {}));
}

module.exports = { xabcdeSpec, specToSvg, summaryFromSpec, saveCard, cardSvg, FLOW_COLORS };
