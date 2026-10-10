'use strict';
/** Salas OSCE: timer autoritativo do servidor, marcação de checklist, PEP e disputa. */
const crypto = require('crypto');
const { db, now, jenc, jdec, SRS_INTERVALS } = require('./db');
const { aiJson } = require('./ai');

const roomByCode = (code) => db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(code || '').toUpperCase());

/** Timer calculado no servidor — fonte única da verdade. */
function roomTimer(r) {
  const dur = +r.timer_duration;
  if (r.timer_started_at > 0) {
    const elapsed = Math.floor((now() - +r.timer_started_at) / 1000);
    const left = Math.max(0, dur - elapsed);
    return { running: left > 0 ? 1 : 0, duration: dur, left, server_now: now() };
  }
  return { running: 0, duration: dur, left: r.timer_paused_left > 0 ? +r.timer_paused_left : dur, server_now: now() };
}

function roomPublic(r) {
  return {
    code: r.code, name: r.name,
    station_ids: jdec(r.station_ids, []), active_station: r.active_station,
    rtype: r.rtype, open: +r.open, study_mode: +r.study_mode,
    creator_id: +r.creator_id, creator_name: r.creator_name,
    timer: roomTimer(r), created_at: +r.created_at,
  };
}

function createRoom(user, { name, station_ids = [], rtype = 'live', timer_duration = 600, study_mode = 0 }) {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (roomByCode(code));
  db.prepare(`INSERT INTO rooms(code,name,station_ids,active_station,rtype,open,study_mode,creator_id,creator_name,timer_duration,timer_started_at,timer_paused_left,created_at)
    VALUES(?,?,?,?,?,1,?,?,?,?,0,0,?)`)
    .run(code, String(name || 'Sala OSCE').slice(0, 80), jenc(station_ids), station_ids[0] || '',
      rtype === 'study' ? 'study' : 'live', study_mode ? 1 : 0, user.id, user.name,
      Math.max(60, +timer_duration || 600), now());
  return roomByCode(code);
}

function timerControl(r, action, duration) {
  if (action === 'start') {
    const left = r.timer_paused_left > 0 ? +r.timer_paused_left : +r.timer_duration;
    db.prepare('UPDATE rooms SET timer_started_at = ?, timer_paused_left = 0 WHERE code = ?')
      .run(now() - 0, r.code);
    if (r.timer_paused_left > 0) {
      // retomar: ajusta o início para que reste `left` segundos
      db.prepare('UPDATE rooms SET timer_started_at = ? WHERE code = ?')
        .run(now() - (+r.timer_duration - left) * 1000, r.code);
    }
  } else if (action === 'pause') {
    const t = roomTimer(r);
    db.prepare('UPDATE rooms SET timer_started_at = 0, timer_paused_left = ? WHERE code = ?').run(t.left, r.code);
  } else if (action === 'reset') {
    const dur = Math.max(60, +duration || +r.timer_duration);
    db.prepare('UPDATE rooms SET timer_duration = ?, timer_started_at = 0, timer_paused_left = 0 WHERE code = ?')
      .run(dur, r.code);
  }
  return roomTimer(roomByCode(r.code));
}

/* ---------------------------------------------------------- marcação/PEP --- */
function setMark(room, stationId, evaluatorId, candidateId, itemIdx, value) {
  db.prepare(`INSERT INTO marks(room,station_id,evaluator_id,candidate_id,item_idx,value,ts)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(room,station_id,evaluator_id,candidate_id,item_idx)
    DO UPDATE SET value = excluded.value, ts = excluded.ts`)
    .run(room, stationId, evaluatorId, candidateId, itemIdx, value ? 1 : 0, now());
}

function getMarks(room, stationId, candidateId) {
  return db.prepare(`SELECT * FROM marks WHERE room = ? AND station_id = ? AND candidate_id = ?`)
    .all(room, stationId, candidateId);
}

/** Fecha o PEP do candidato e dispara correção por IA (com failsafe de cadeia). */
async function closePep(room, station, candidateId, evaluator) {
  const marks = getMarks(room, station.id, candidateId);
  const checklist = jdec(station.checklist, []);
  const items = checklist.map((c, i) => ({
    item: c.item, peso: +c.peso || 1,
    marcado: marks.some((m) => m.item_idx === i && m.value) ? 1 : 0,
  }));
  const score = items.reduce((s, it) => s + (it.marcado ? it.peso : 0), 0);
  const max = items.reduce((s, it) => s + it.peso, 0) || 1;
  const info = db.prepare(`INSERT INTO peps(room,station_id,candidate_id,evaluator_id,evaluator_name,items,score,max_score,pct,ai_status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`)
    .run(room, station.id, candidateId, evaluator.id, evaluator.name, jenc(items), score, max,
      Math.round((score / max) * 1000) / 10, now());
  const pepId = info.lastInsertRowid;

  // Correção por IA — assíncrona, não bloqueia o fechamento do PEP
  (async () => {
    try {
      const prompt = [
        'Você é um examinador OSCE/Revalida. Analise o desempenho do candidato na estação abaixo.',
        `Estação: ${station.tema} (${station.area}). Instruções: ${station.instrucoes}`,
        `Checklist com marcações: ${jenc(items)}`,
        `Nota: ${score}/${max} (${Math.round((score / max) * 100)}%).`,
        'Responda SOMENTE em JSON: {"pontos_fortes":[...],"lacunas":[...],"erros_criticos":[...],"conduta_ideal":"...","comentario":"..."}',
      ].join('\n');
      const { data } = await aiJson('pep_review', [{ role: 'user', content: prompt }]);
      db.prepare('UPDATE peps SET ai_json = ?, ai_status = ? WHERE id = ?')
        .run(jenc(data), 'done', pepId);
    } catch {
      db.prepare('UPDATE peps SET ai_status = ? WHERE id = ?').run('failed', pepId);
    }
  })();

  return db.prepare('SELECT * FROM peps WHERE id = ?').get(pepId);
}

function openDispute(pep, user, reason) {
  const info = db.prepare('INSERT INTO disputes(pep_id,by_id,by_name,reason,status,created_at) VALUES(?,?,?,?,\'open\',?)')
    .run(pep.id, user.id, user.name, String(reason || '').slice(0, 2000), now());
  (async () => {
    try {
      const items = jdec(pep.items, []);
      const prompt = [
        'Você é árbitro de uma disputa de correção OSCE/Revalida.',
        `Estação: ${pep.station_id}. Checklist avaliado: ${jenc(items)}`,
        `Nota atual: ${pep.score}/${pep.max_score} (${pep.pct}%).`,
        `Alegação do candidato: ${reason}`,
        'Responda SOMENTE em JSON: {"parecer":"procedente|improcedente|parcial","justificativa":"...","itens_revisados":[{"item":"...","novo_valor":0}]}',
      ].join('\n');
      const { data } = await aiJson('dispute_review', [{ role: 'user', content: prompt }]);
      db.prepare('UPDATE disputes SET ai_json = ? WHERE id = ?').run(jenc(data), info.lastInsertRowid);
    } catch { /* parecer humano continua disponível */ }
  })();
  return db.prepare('SELECT * FROM disputes WHERE id = ?').get(info.lastInsertRowid);
}

/* ----------------------------------------------------------------- SRS ----- */
function reviewCard(card, quality) {
  // quality: 0=errei, 1=difícil, 2=bom, 3=fácil
  let stage = +card.stage;
  if (quality <= 0) stage = 0;
  else stage = Math.min(stage + (quality >= 2 ? 1 : 0), SRS_INTERVALS.length - 1);
  const days = SRS_INTERVALS[stage];
  const next = now() + days * 86400 * 1000;
  db.prepare('UPDATE srs_cards SET stage = ?, next_due = ? WHERE id = ?').run(stage, next, card.id);
  return { stage, next_due: next, interval_days: days };
}

module.exports = { roomByCode, roomTimer, roomPublic, createRoom, timerControl, setMark, getMarks, closePep, openDispute, reviewCard };
