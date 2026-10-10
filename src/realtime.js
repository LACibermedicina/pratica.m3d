'use strict';
/**
 * Tempo real da v6 — Socket.io (substitui o SSE + polling da v5):
 * presença por sala, sinalização WebRTC (mesh), coordenação do failsafe Agora,
 * chat (sala/privado) e eventos de marcação/timer.
 */
const { socketUser } = require('./auth');
const { db, now } = require('./db');
const { roomByCode } = require('./rooms');

function createHub(io) {
  /** code -> Map<userId, {socketIds:Set, name, role}> */
  const rooms = new Map();
  const socketIndex = new Map(); // socketId -> {code, userId}

  const roomState = (code) => {
    if (!rooms.has(code)) rooms.set(code, new Map());
    return rooms.get(code);
  };

  function participants(code) {
    const m = rooms.get(code);
    if (!m) return [];
    return [...m.entries()].map(([id, p]) => ({ id, name: p.name, role: p.role, sockets: p.sockets.size }));
  }

  function emitRoom(code, event, payload) {
    io.to(`room:${code}`).emit(event, payload);
  }

  function emitPresence(code) {
    emitRoom(code, 'room:participants', { participants: participants(code) });
  }

  io.use((socket, next) => {
    const u = socketUser(socket);
    if (!u) return next(new Error('unauthorized'));
    socket.user = u;
    next();
  });

  io.on('connection', (socket) => {
    const u = socket.user;

    socket.on('room:join', ({ code, role }) => {
      code = String(code || '').toUpperCase();
      const room = roomByCode(code);
      if (!room || !room.open) return socket.emit('room:error', { error: 'Sala inexistente ou encerrada.' });

      // sai da sala anterior, se houver
      leave(socket);

      const m = roomState(code);
      if (!m.has(u.id)) m.set(u.id, { socketIds: new Set(), name: u.name, role: 'observer' });
      const p = m.get(u.id);
      p.socketIds.add(socket.id);
      p.role = ['candidato', 'avaliador', 'ator', 'observer'].includes(role) ? role : p.role;
      socketIndex.set(socket.id, { code, userId: u.id });
      socket.join(`room:${code}`);

      socket.emit('room:joined', {
        code, self: u.id,
        participants: participants(code),
        history: db.prepare(`SELECT * FROM messages WHERE room = ? AND (scope = 'room' OR to_id = ? OR from_id = ?)
                             ORDER BY id DESC LIMIT 60`).all(code, u.id, u.id).reverse(),
      });
      socket.to(`room:${code}`).emit('room:user_joined', { id: u.id, name: u.name, role: p.role });
      emitPresence(code);
    });

    socket.on('room:leave', () => leave(socket));

    socket.on('room:role', ({ role }) => {
      const ctx = socketIndex.get(socket.id);
      if (!ctx) return;
      const m = rooms.get(ctx.code);
      const p = m && m.get(u.id);
      if (p && ['candidato', 'avaliador', 'ator', 'observer'].includes(role)) {
        p.role = role;
        emitPresence(ctx.code);
      }
    });

    /* ------------------------------------------------ sinalização WebRTC ---- */
    // Relay endereçado: {to, data} — data carrega offer/answer/candidate opacos.
    socket.on('rtc:signal', ({ to, data }) => {
      const ctx = socketIndex.get(socket.id);
      if (!ctx) return;
      const m = rooms.get(ctx.code);
      const target = m && m.get(+to);
      if (!target) return;
      for (const sid of target.socketIds) {
        io.to(sid).emit('rtc:signal', { from: u.id, data });
      }
    });

    // Broadcast de intenção (ex.: "p2p falhou, migrando para Agora")
    socket.on('rtc:mode', ({ mode }) => {
      const ctx = socketIndex.get(socket.id);
      if (!ctx || !['p2p', 'agora'].includes(mode)) return;
      socket.to(`room:${ctx.code}`).emit('rtc:mode', { from: u.id, mode });
    });

    /* ----------------------------------------------------------- chat ------- */
    socket.on('chat:send', ({ text, to }) => {
      const ctx = socketIndex.get(socket.id);
      if (!ctx) return;
      const msg = String(text || '').trim().slice(0, 1000);
      if (!msg) return;
      const scope = to ? 'private' : 'room';
      const info = db.prepare('INSERT INTO messages(room,scope,from_id,from_name,to_id,text,ts) VALUES(?,?,?,?,?,?,?)')
        .run(ctx.code, scope, u.id, u.name, to ? +to : 0, msg, now());
      const payload = { id: info.lastInsertRowid, room: ctx.code, scope, from_id: u.id, from_name: u.name, to_id: to ? +to : 0, text: msg, ts: now() };
      if (scope === 'room') emitRoom(ctx.code, 'chat:message', payload);
      else {
        const m = rooms.get(ctx.code);
        const dst = m && m.get(+to);
        const mine = m && m.get(u.id);
        for (const sid of [...(dst ? dst.socketIds : []), ...(mine ? mine.socketIds : [])]) {
          io.to(sid).emit('chat:message', payload);
        }
      }
    });

    socket.on('disconnect', () => leave(socket));

    function leave(s) {
      const ctx = socketIndex.get(s.id);
      if (!ctx) return;
      socketIndex.delete(s.id);
      const m = rooms.get(ctx.code);
      if (!m) return;
      const p = m.get(u.id);
      if (p) {
        p.socketIds.delete(s.id);
        if (p.socketIds.size === 0) {
          m.delete(u.id);
          s.to(`room:${ctx.code}`).emit('room:user_left', { id: u.id });
        }
      }
      if (m.size === 0) rooms.delete(ctx.code);
      else emitPresence(ctx.code);
      s.leave(`room:${ctx.code}`);
    }
  });

  return { emitRoom, roomParticipants: participants };
}

module.exports = { createHub };
