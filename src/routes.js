'use strict';
/** API REST da v6 — autenticação, catálogo, salas, SRS, flowcards, PEP, admin, IA, Agora. */
const express = require('express');
const multer = require('multer');
const { db, now, jenc, jdec, AREAS, AREA_LABELS, AREA_COLORS, SRS_INTERVALS } = require('./db');
const auth = require('./auth');
const { aiChat, aiJson, aiStatus, CHAIN } = require('./ai');
const agora = require('./agora');
const flow = require('./flowcards');
const sio = require('./stations_io');
const R = require('./rooms');
const cfg = require('./config');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const ok = (res, data = {}) => res.json({ ok: true, ...data });
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

module.exports = function buildRoutes(io, hub) {
  const r = express.Router();

  /* ---------------------------------------------------------------- meta --- */
  r.get('/api/meta', (req, res) => ok(res, {
    area_labels: AREA_LABELS, area_colors: AREA_COLORS, areas: AREAS,
    stats: {
      stations: db.prepare('SELECT COUNT(*) n FROM stations').get().n,
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
      rooms_open: db.prepare('SELECT COUNT(*) n FROM rooms WHERE open = 1').get().n,
    },
    srs_intervals: SRS_INTERVALS,
  }));

  /** Config pública do cliente de vídeo — sem nenhuma credencial. */
  r.get('/api/video/config', (req, res) => {
    const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (cfg.TURN_URLS) ice.push({
      urls: cfg.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: cfg.TURN_USERNAME || undefined,
      credential: cfg.TURN_CREDENTIAL || undefined,
    });
    ok(res, {
      iceServers: ice,
      p2p_watchdog_ms: cfg.P2P_WATCHDOG_MS,
      agora: { available: agora.configured(), appId: agora.configured() ? agora.appId() : null },
    });
  });

  /** Token Agora por sala — certificado fica apenas no servidor. */
  r.post('/api/agora/token', auth.requireAuth(), (req, res) => {
    if (!agora.configured()) return bad(res, 'Agora não configurada no servidor.', 503);
    const room = R.roomByCode(req.body.room);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    const uid = String(req.user.id);
    try {
      const token = agora.buildToken(`m3d-${room.code}`, uid);
      ok(res, { appId: agora.appId(), channel: `m3d-${room.code}`, token, uid });
    } catch (e) { bad(res, e.message, 500); }
  });

  /* ---------------------------------------------------------------- auth --- */
  r.post('/api/register', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || String(password).length < 4)
      return bad(res, 'Informe nome, e-mail e senha (mín. 4 caracteres).');
    try {
      const u = auth.register(name, email, password);
      const s = auth.tokenFor(u.id);
      ok(res, { user: auth.publicUser(u), ...s });
    } catch { bad(res, 'E-mail já cadastrado.', 409); }
  });

  r.post('/api/login', (req, res) => {
    const u = auth.login(String(req.body.login || ''), req.body.password);
    if (!u) return bad(res, 'Credenciais inválidas.', 401);
    ok(res, { user: auth.publicUser(u), ...auth.tokenFor(u.id) });
  });

  r.post('/api/logout', (req, res) => { auth.logout(auth.bearer(req)); ok(res); });
  r.get('/api/me', auth.requireAuth(), (req, res) => ok(res, { user: auth.publicUser(req.user) }));

  /* ------------------------------------------------------------ estações --- */
  r.get('/api/stations', auth.requireAuth(), (req, res) => {
    const { area, q } = req.query;
    let rows = db.prepare('SELECT * FROM stations ORDER BY area, tema').all();
    if (area) rows = rows.filter((s) => s.area === String(area).toUpperCase());
    if (q) { const k = String(q).toLowerCase(); rows = rows.filter((s) => (s.tema + ' ' + s.especialidade).toLowerCase().includes(k)); }
    ok(res, { stations: rows.map((s) => ({ ...s, checklist: jdec(s.checklist, []) })) });
  });

  r.get('/api/stations/:id', auth.requireAuth(), (req, res) => {
    const s = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
    if (!s) return bad(res, 'Estação não encontrada.', 404);
    ok(res, { station: { ...s, checklist: jdec(s.checklist, []) } });
  });

  r.post('/api/stations', auth.requireAuth(['root', 'admin']), (req, res) => {
    const { imported, updated, total } = sio.importRows([req.body || {}]);
    ok(res, { imported, updated, total });
  });

  r.delete('/api/stations/:id', auth.requireAuth(['root', 'admin']), (req, res) => {
    db.prepare('DELETE FROM stations WHERE id = ?').run(req.params.id);
    ok(res);
  });

  r.post('/api/stations/import', auth.requireAuth(['root', 'admin']), upload.single('file'), (req, res) => {
    try {
      const rows = req.file ? sio.parseXlsx(req.file.buffer)
        : Array.isArray(req.body.rows) ? req.body.rows : [];
      if (!rows.length) return bad(res, 'Nenhuma linha válida encontrada (aba "Estações").');
      ok(res, sio.importRows(rows));
    } catch (e) { bad(res, 'Falha ao ler a planilha: ' + e.message, 422); }
  });

  r.get('/api/stations/export.json', auth.requireAuth(), (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="estacoes.json"');
    res.json(sio.exportJson());
  });
  r.get('/api/stations/export.xlsx', auth.requireAuth(), (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="estacoes.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(sio.exportXlsx());
  });

  /* ---------------------------------------------------------------- salas --- */
  r.get('/api/rooms', auth.requireAuth(), (req, res) => {
    const rows = db.prepare('SELECT * FROM rooms WHERE open = 1 ORDER BY created_at DESC LIMIT 100').all();
    ok(res, { rooms: rows.map(R.roomPublic) });
  });

  r.post('/api/rooms', auth.requireAuth(), (req, res) => {
    const room = R.createRoom(req.user, req.body || {});
    ok(res, { room: R.roomPublic(room) });
  });

  r.get('/api/rooms/:code', auth.requireAuth(), (req, res) => {
    const room = R.roomByCode(req.params.code);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    const station = room.active_station
      ? db.prepare('SELECT * FROM stations WHERE id = ?').get(room.active_station) : null;
    ok(res, {
      room: R.roomPublic(room),
      station: station ? { ...station, checklist: jdec(station.checklist, []) } : null,
      participants: hub.roomParticipants(room.code),
    });
  });

  r.post('/api/rooms/:code/station', auth.requireAuth(), (req, res) => {
    const room = R.roomByCode(req.params.code);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    const st = db.prepare('SELECT * FROM stations WHERE id = ?').get(String(req.body.station_id || ''));
    if (!st) return bad(res, 'Estação não encontrada.', 404);
    db.prepare('UPDATE rooms SET active_station = ? WHERE code = ?').run(st.id, room.code);
    hub.emitRoom(room.code, 'room:station', { station: { ...st, checklist: jdec(st.checklist, []) } });
    ok(res, { station: { ...st, checklist: jdec(st.checklist, []) } });
  });

  r.post('/api/rooms/:code/timer', auth.requireAuth(), (req, res) => {
    const room = R.roomByCode(req.params.code);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    const t = R.timerControl(room, req.body.action, req.body.duration);
    hub.emitRoom(room.code, 'room:timer', { timer: t });
    ok(res, { timer: t });
  });

  r.post('/api/rooms/:code/close', auth.requireAuth(), (req, res) => {
    const room = R.roomByCode(req.params.code);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    if (room.creator_id !== req.user.id && !['root', 'admin'].includes(req.user.role))
      return bad(res, 'Apenas o criador pode encerrar.', 403);
    db.prepare('UPDATE rooms SET open = 0 WHERE code = ?').run(room.code);
    hub.emitRoom(room.code, 'room:closed', {});
    ok(res);
  });

  r.post('/api/rooms/:code/marks', auth.requireAuth(), (req, res) => {
    const room = R.roomByCode(req.params.code);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    const { station_id, candidate_id, item_idx, value } = req.body || {};
    R.setMark(room.code, String(station_id), req.user.id, +candidate_id, +item_idx, value ? 1 : 0);
    hub.emitRoom(room.code, 'room:mark', {
      station_id, candidate_id: +candidate_id, item_idx: +item_idx, value: value ? 1 : 0, by: req.user.id,
    });
    ok(res);
  });

  r.get('/api/rooms/:code/marks', auth.requireAuth(), (req, res) => {
    ok(res, { marks: R.getMarks(req.params.code.toUpperCase(), String(req.query.station_id || ''), +(req.query.candidate_id || 0)) });
  });

  r.post('/api/rooms/:code/pep', auth.requireAuth(), async (req, res) => {
    const room = R.roomByCode(req.params.code);
    if (!room) return bad(res, 'Sala não encontrada.', 404);
    const st = db.prepare('SELECT * FROM stations WHERE id = ?').get(room.active_station);
    if (!st) return bad(res, 'Nenhuma estação ativa.', 409);
    const pep = await R.closePep(room.code, st, +req.body.candidate_id, req.user);
    hub.emitRoom(room.code, 'room:pep', { pep_id: pep.id, candidate_id: pep.candidate_id });
    ok(res, { pep: { ...pep, items: jdec(pep.items, []) } });
  });

  /* ----------------------------------------------------------- PEP/disputa - */
  r.get('/api/peps', auth.requireAuth(), (req, res) => {
    const rows = ['root', 'admin'].includes(req.user.role)
      ? db.prepare('SELECT * FROM peps ORDER BY id DESC LIMIT 200').all()
      : db.prepare('SELECT * FROM peps WHERE candidate_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
    ok(res, { peps: rows.map((p) => ({ ...p, items: jdec(p.items, []), ai: jdec(p.ai_json, null) })) });
  });

  r.get('/api/peps/:id', auth.requireAuth(), (req, res) => {
    const p = db.prepare('SELECT * FROM peps WHERE id = ?').get(req.params.id);
    if (!p) return bad(res, 'PEP não encontrado.', 404);
    if (p.candidate_id !== req.user.id && p.evaluator_id !== req.user.id && !['root', 'admin'].includes(req.user.role))
      return bad(res, 'Sem permissão.', 403);
    const disputes = db.prepare('SELECT * FROM disputes WHERE pep_id = ? ORDER BY id').all(p.id)
      .map((d) => ({ ...d, ai: jdec(d.ai_json, null) }));
    ok(res, { pep: { ...p, items: jdec(p.items, []), ai: jdec(p.ai_json, null) }, disputes });
  });

  r.post('/api/peps/:id/dispute', auth.requireAuth(), (req, res) => {
    const p = db.prepare('SELECT * FROM peps WHERE id = ?').get(req.params.id);
    if (!p) return bad(res, 'PEP não encontrado.', 404);
    if (p.candidate_id !== req.user.id) return bad(res, 'Apenas o candidato pode disputar.', 403);
    if (!String(req.body.reason || '').trim()) return bad(res, 'Descreva o motivo da disputa.');
    ok(res, { dispute: R.openDispute(p, req.user, req.body.reason) });
  });

  r.post('/api/disputes/:id/resolve', auth.requireAuth(['root', 'admin']), (req, res) => {
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
    if (!d) return bad(res, 'Disputa não encontrada.', 404);
    const status = req.body.status === 'rejected' ? 'rejected' : 'resolved';
    db.prepare('UPDATE disputes SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?')
      .run(status, String(req.body.resolution || '').slice(0, 2000), now(), d.id);
    ok(res);
  });

  /* ----------------------------------------------------------------- SRS --- */
  r.get('/api/srs', auth.requireAuth(), (req, res) => {
    const rows = db.prepare(`SELECT c.*, s.tema, s.area FROM srs_cards c
      LEFT JOIN stations s ON s.id = c.station_id
      WHERE c.user_id = ? ORDER BY c.next_due ASC LIMIT 400`).all(req.user.id);
    const t = now();
    ok(res, {
      cards: rows.map((c) => ({ ...c, due: +c.next_due <= t })),
      due: rows.filter((c) => +c.next_due <= t).length,
      total: rows.length, intervals: SRS_INTERVALS,
    });
  });

  r.post('/api/srs', auth.requireAuth(), (req, res) => {
    const { station_id = '', front, back } = req.body || {};
    if (!front || !back) return bad(res, 'Informe frente e verso do card.');
    const info = db.prepare('INSERT INTO srs_cards(user_id,station_id,front,back,stage,next_due,created_at) VALUES(?,?,?,?,0,?,?)')
      .run(req.user.id, String(station_id), String(front).slice(0, 500), String(back).slice(0, 4000), now(), now());
    ok(res, { id: info.lastInsertRowid });
  });

  r.post('/api/srs/:id/review', auth.requireAuth(), (req, res) => {
    const c = db.prepare('SELECT * FROM srs_cards WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!c) return bad(res, 'Card não encontrado.', 404);
    ok(res, R.reviewCard(c, +req.body.quality || 0));
  });

  r.delete('/api/srs/:id', auth.requireAuth(), (req, res) => {
    db.prepare('DELETE FROM srs_cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    ok(res);
  });

  /** Gera cards SRS a partir dos critérios NÃO marcados de um PEP (aprendizado dirigido). */
  r.post('/api/srs/from-pep', auth.requireAuth(), (req, res) => {
    const p = db.prepare('SELECT * FROM peps WHERE id = ? AND candidate_id = ?').get(req.params.id, req.user.id);
    if (!p) return bad(res, 'PEP não encontrado.', 404);
    const st = db.prepare('SELECT * FROM stations WHERE id = ?').get(p.station_id);
    const missed = jdec(p.items, []).filter((it) => !it.marcado);
    if (!missed.length) return ok(res, { created: 0 });
    const ins = db.prepare('INSERT INTO srs_cards(user_id,station_id,front,back,stage,next_due,created_at) VALUES(?,?,?,?,0,?,?)');
    missed.forEach((it) => ins.run(req.user.id, p.station_id,
      `${st ? st.tema : p.station_id} — o que faltou?`, it.item, now(), now()));
    ok(res, { created: missed.length });
  });

  /* ------------------------------------------------------------ flowcards -- */
  r.get('/api/flowcards', auth.requireAuth(), (req, res) => {
    const rows = db.prepare(`SELECT f.*, s.tema AS station_tema FROM flow_cards f
      LEFT JOIN stations s ON s.id = f.station_id
      WHERE f.user_id = ? ORDER BY f.id DESC LIMIT 200`).all(req.user.id);
    ok(res, { cards: rows.map((c) => ({ ...c, spec: undefined, has_svg: true })) });
  });

  r.post('/api/flowcards', auth.requireAuth(), async (req, res) => {
    const st = db.prepare('SELECT * FROM stations WHERE id = ?').get(String(req.body.station_id || ''));
    if (!st) return bad(res, 'Estação não encontrada.', 404);
    let spec, source = 'ai';
    try {
      const prompt = [
        'Crie um fluxograma de procedimento clínico para treino OSCE, seguindo diretrizes do Ministério da Saúde quando aplicável.',
        `Estação: ${st.tema} (${AREA_LABELS[st.area] || st.area}). Cenário: ${st.cenario}. Protocolo: ${st.protocolo}`,
        'Responda SOMENTE em JSON: {"title":"...","fonte":"...","steps":[{"t":"inicio|avaliacao|conduta|alerta|reavaliacao","text":"..."}]} — entre 5 e 12 passos, textos curtos.',
      ].join('\n');
      spec = (await aiJson('flowcard', [{ role: 'user', content: prompt }])).data;
      if (!Array.isArray(spec.steps) || spec.steps.length < 3) throw new Error('spec inválido');
    } catch {
      spec = flow.xabcdeSpec(st.tema); source = 'xabcde';
    }
    const card = flow.saveCard(req.user.id, st.id, spec);
    ok(res, { card: { ...card, spec: undefined }, source, svg_url: `/cards/${card.id}.svg?token=${auth.bearer(req)}` });
  });

  r.delete('/api/flowcards/:id', auth.requireAuth(), (req, res) => {
    db.prepare('DELETE FROM flow_cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    ok(res);
  });

  /* ------------------------------------------------------------------- IA --- */
  r.get('/api/ai/status', auth.requireAuth(['root', 'admin']), (req, res) => {
    ok(res, { providers: aiStatus(), chain: CHAIN });
  });

  r.get('/api/ai/logs', auth.requireAuth(['root', 'admin']), (req, res) => {
    const logs = db.prepare('SELECT * FROM ai_calls ORDER BY id DESC LIMIT 120').all();
    const summary = db.prepare(`SELECT provider, COUNT(*) n, SUM(ok) oks, ROUND(AVG(latency_ms)) avg_ms
      FROM ai_calls GROUP BY provider`).all();
    ok(res, { logs, summary });
  });

  r.post('/api/ai/station', auth.requireAuth(['root', 'admin']), async (req, res) => {
    try {
      const { data, provider } = await aiJson('station_gen', [{
        role: 'user',
        content: [
          'Crie uma estação OSCE/Revalida completa e realista.',
          `Tema desejado: ${req.body.tema || 'livre'}. Área: ${req.body.area || 'CM'}.`,
          'Responda SOMENTE em JSON com as chaves: tema, area (CM|CIR|GO|PED|MFC), especialidade, nivel, duracao (min), fonte, instrucoes, cenario, roteiro_ator, protocolo, exames, checklist (array de {"item","peso"}).',
        ].join('\n'),
      }]);
      const { total } = sio.importRows([data]);
      ok(res, { created: total, provider });
    } catch (e) { bad(res, 'IA indisponível: ' + e.message, 502); }
  });

  r.post('/api/ai/chat', auth.requireAuth(), async (req, res) => {
    try {
      const { text, provider } = await aiChat('chat', [
        { role: 'system', content: 'Você é tutor de preparação para OSCE/Revalida. Responda em pt-BR, objetivo e didático.' },
        { role: 'user', content: String(req.body.message || '').slice(0, 4000) },
      ]);
      ok(res, { reply: text, provider });
    } catch (e) { bad(res, 'IA indisponível no momento.', 502); }
  });

  /* --------------------------------------------------------------- admin --- */
  r.get('/api/admin/users', auth.requireAuth(['root', 'admin']), (req, res) => {
    ok(res, {
      users: db.prepare('SELECT id,name,email,role,banned,created_at FROM users ORDER BY id').all(),
    });
  });

  r.post('/api/admin/users/:id/role', auth.requireAuth(['root']), (req, res) => {
    const role = ['user', 'admin'].includes(req.body.role) ? req.body.role : 'user';
    db.prepare('UPDATE users SET role = ? WHERE id = ? AND role != \'root\'').run(role, req.params.id);
    ok(res);
  });

  r.post('/api/admin/users/:id/ban', auth.requireAuth(['root', 'admin']), (req, res) => {
    db.prepare('UPDATE users SET banned = ? WHERE id = ? AND role != \'root\'').run(req.body.banned ? 1 : 0, req.params.id);
    if (req.body.banned) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
    ok(res);
  });

  /* ------------------------------------------------------------ analytics -- */
  r.get('/api/analytics', auth.requireAuth(), (req, res) => {
    const byArea = db.prepare(`SELECT s.area, COUNT(p.id) n, ROUND(AVG(p.pct),1) avg_pct
      FROM peps p JOIN stations s ON s.id = p.station_id
      WHERE p.candidate_id = ? GROUP BY s.area`).all(req.user.id);
    const recent = db.prepare(`SELECT p.id, p.pct, p.created_at, s.tema, s.area FROM peps p
      LEFT JOIN stations s ON s.id = p.station_id
      WHERE p.candidate_id = ? ORDER BY p.id DESC LIMIT 30`).all(req.user.id);
    ok(res, { by_area: byArea, recent, area_colors: AREA_COLORS, area_labels: AREA_LABELS });
  });

  /* ----------------------------------------------------- cards SVG públicos  */
  r.get('/cards/:id.svg', (req, res) => {
    const u = auth.userByToken(auth.bearer(req));
    if (!u) return bad(res, 'Não autenticado.', 401);
    const svg = flow.cardSvg(+req.params.id, u.id, u.role);
    if (!svg) return bad(res, 'Card não encontrado.', 404);
    res.type('image/svg+xml').setHeader('Cache-Control', 'private, max-age=300').send(svg);
  });

  return r;
};
