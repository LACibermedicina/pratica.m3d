'use strict';
/**
 * Importação XLSX/JSON e exportação de pacotes de estações.
 * XLSX lido no servidor com a lib `xlsx` — aba "Estações", cabeçalho flexível,
 * case-insensitive, com aliases. O frontend também pode colar linhas em JSON.
 */
const XLSX = require('xlsx');
const { db, now, jenc, jdec, normalizeStation } = require('./db');

const FIELDS = ['id', 'tema', 'area', 'especialidade', 'nivel', 'duracao', 'fonte',
  'instrucoes', 'cenario', 'roteiro_ator', 'protocolo', 'exames', 'checklist'];

const ALIASES = {
  roteiroator: 'roteiro_ator', roteiro: 'roteiro_ator', 'roteiro do ator': 'roteiro_ator',
  'tema/titulo': 'tema', titulo: 'tema', 'título': 'tema',
  'grande area': 'area', 'grande área': 'area', 'área': 'area', 'area medica': 'area',
  'duração': 'duracao', tempo: 'duracao', 'nível': 'nivel', 'nivel de complexidade': 'nivel',
  'instruções': 'instrucoes', instrucao: 'instrucoes', 'instrução': 'instrucoes',
  'cenário': 'cenario', protocolos: 'protocolo', 'exames complementares': 'exames',
};

function canonHeader(h) {
  const k = String(h || '').trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');
  if (FIELDS.includes(k.replace(/ /g, '_'))) return k.replace(/ /g, '_');
  if (ALIASES[k]) return ALIASES[k];
  const k2 = k.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return ALIASES[k2] || (FIELDS.includes(k2.replace(/ /g, '_')) ? k2.replace(/ /g, '_') : null);
}

/** Lê um buffer XLSX e devolve linhas normalizadas para importação. */
function parseXlsx(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase().startsWith('esta')) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      const f = canonHeader(k);
      if (f && out[f] === undefined) out[f] = typeof v === 'string' ? v.trim() : v;
    }
    if (typeof out.checklist === 'string' && out.checklist) {
      const items = out.checklist.split(/[\n;|]+/).map((s) => s.trim()).filter(Boolean);
      out.checklist = items.map((item) => ({ item, peso: 1 }));
    }
    return out;
  }).filter((r) => r.tema);
}

/** Upsert em lote; devolve {imported, updated}. */
function importRows(rows) {
  const up = db.prepare(`INSERT INTO stations
    (id,tema,area,especialidade,nivel,duracao,fonte,instrucoes,cenario,roteiro_ator,protocolo,exames,checklist,created_at)
    VALUES (@id,@tema,@area,@especialidade,@nivel,@duracao,@fonte,@instrucoes,@cenario,@roteiro_ator,@protocolo,@exames,@checklist,@created_at)
    ON CONFLICT(id) DO UPDATE SET tema=@tema,area=@area,especialidade=@especialidade,nivel=@nivel,
      duracao=@duracao,fonte=@fonte,instrucoes=@instrucoes,cenario=@cenario,roteiro_ator=@roteiro_ator,
      protocolo=@protocolo,exames=@exames,checklist=@checklist`);
  let imported = 0, updated = 0;
  const exists = db.prepare('SELECT 1 FROM stations WHERE id = ?');
  const tx = db.transaction(() => {
    rows.forEach((s, i) => {
      const st = normalizeStation(s, i);
      if (!st.tema || st.tema === 'Estação sem título') return;
      if (exists.get(st.id)) updated++; else imported++;
      up.run({ ...st, checklist: jenc(st.checklist), created_at: now() });
    });
  });
  tx();
  return { imported, updated, total: imported + updated };
}

function exportJson() {
  const rows = db.prepare('SELECT * FROM stations ORDER BY area, tema').all();
  return rows.map((r) => ({ ...r, checklist: jdec(r.checklist, []) }));
}

function exportXlsx() {
  const rows = exportJson().map((r) => ({
    ...r, checklist: (r.checklist || []).map((c) => c.item).join('; '),
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { header: FIELDS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estações');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseXlsx, importRows, exportJson, exportXlsx, FIELDS };
