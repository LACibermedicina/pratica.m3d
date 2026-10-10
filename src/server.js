'use strict';
/**
 * pratica.M3D v6 — ponto de entrada único (Express + Socket.io + SQLite).
 * Uso:  npm start   (ou: node src/server.js)
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cfg = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const buildRoutes = require('./routes');
const { createHub } = require('./realtime');
const { aiStatus, CHAIN } = require('./ai');
const agora = require('./agora');

if(cfg.NODE_ENV === 'production' && (!process.env.ROOT_PASSWORD || cfg.ROOT_PASSWORD === '@0Arcano')) throw Error('Defina ROOT_PASSWORD forte antes de iniciar em produção.');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// estáticos com cache curto (SPA sem build; versões via querystring)
app.use(express.static(path.join(cfg.ROOT, 'public'), { maxAge: '5m', index: 'index.html' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const hub = createHub(io);

app.use(require('./consolidation').security);
app.use(buildRoutes(io, hub));

app.get('/health', (req, res) => {
  res.json({
    ok: true, app: 'pratica.M3D v6.2 · m3d.pro', node: process.version,
    stations: db.prepare('SELECT COUNT(*) n FROM stations').get().n,
    ai_chain: CHAIN.map((p) => ({ provider: p, configured: aiStatus().find((s) => s.provider === p)?.configured })),
    agora: agora.configured(),
    realtime: 'socket.io',
  });
});

// SPA fallback (Express 5: middleware no lugar de app.get('*'))
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') || req.path.startsWith('/cards/')) {
    return res.status(404).json({ ok: false, error: 'Rota não encontrada: ' + req.path });
  }
  res.sendFile(path.join(cfg.ROOT, 'public', 'index.html'));
});

app.use((err, req, res, next) => { console.error('[request]', err.message); if (!res.headersSent) res.status(err.status || 500).json({ok:false,error:err.status ? err.message : 'Falha interna. Consulte o log do servidor.'}); });

// limpeza de sessões expiradas a cada 6h
setInterval(auth.gcSessions, 6 * 3600 * 1000).unref();

server.listen(cfg.PORT, () => {
  console.log(`▶ pratica.M3D v6 em http://localhost:${cfg.PORT}`);
  console.log(`  banco: ${path.join(cfg.STORAGE_DIR, 'pratica_m3d.sqlite')}`);
  console.log(`  IA: ${CHAIN.join(' → ')} | Agora: ${agora.configured() ? 'configurada' : 'não configurada'}`);
});
