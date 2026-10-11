import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server as IOServer } from 'socket.io';
import pool, { q } from './db.js';
import { agoraConfigurado, gerarToken } from './agora.js';

const SEGREDO = process.env.JWT_SEGREDO || 'troque-em-producao';
const PORTA = Number(process.env.PORT || 3001);
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Mensagens genéricas: nunca revelam se e-mail, token ou conta existem.
const MSG_TOKEN = 'Token inválido, vencido ou emitido para outro e-mail.';
const MSG_LOGIN = 'E-mail ou senha incorretos.';
const MSG_PEDIDO = 'Pedido enviado. Quando receber o token, escolha "Tenho um token".';

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

const servidor = http.createServer(app);
const io = new IOServer(servidor, { cors: { origin: true } });

/* ---------------- autenticação ---------------- */

function autenticar(req, res, prox) {
  const cab = req.headers.authorization || '';
  const token = cab.startsWith('Bearer ') ? cab.slice(7) : null;
  try {
    req.usuario = jwt.verify(token, SEGREDO);
    prox();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
  }
}

function senhaValida(s) {
  return typeof s === 'string' && s.length >= 10 && /[A-Za-z]/.test(s) && /\d/.test(s);
}

app.post('/api/auth/registrar', async (req, res) => {
  const { nome, email, senha, token } = req.body || {};
  if (!nome || nome.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || !senhaValida(senha))
    return res.status(400).json({ erro: 'Confira nome, e-mail e senha (10+ caracteres, com letra e número).' });
  if (!token) return res.status(400).json({ erro: MSG_TOKEN });

  const cli = await pool.connect();
  try {
    await cli.query('begin');
    const tk = await cli.query(
      `select * from tokens_acesso where hash=$1 and not revogado
         and (expira_em is null or expira_em > now()) and usos < usos_max for update`,
      [sha256(String(token).trim())]
    );
    const t = tk.rows[0];
    if (!t || (t.email_preso && t.email_preso.toLowerCase() !== email.toLowerCase())) {
      await cli.query('rollback');
      return res.status(400).json({ erro: MSG_TOKEN });
    }
    const senhaHash = await bcrypt.hash(senha, 10);
    const u = await cli.query(
      `insert into usuarios (nome, email, senha_hash) values ($1,$2,$3) returning id, nome, papel_app`,
      [nome.trim(), email.trim(), senhaHash]
    );
    await cli.query('update tokens_acesso set usos = usos + 1 where id=$1', [t.id]);
    await cli.query('commit');
    res.json({ ok: true, mensagem: 'Conta criada. Entre com a senha que você definiu.' });
  } catch (e) {
    await cli.query('rollback');
    if (e.code === '23505') return res.status(400).json({ erro: 'Não foi possível concluir o cadastro.' });
    res.status(500).json({ erro: 'Erro interno. Tente de novo.' });
  } finally {
    cli.release();
  }
});

app.post('/api/auth/entrar', async (req, res) => {
  const { email, senha } = req.body || {};
  const r = await q('select * from usuarios where email=$1', [email || '']);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(senha || '', u.senha_hash)))
    return res.status(401).json({ erro: MSG_LOGIN });
  if (!u.ativo) return res.status(403).json({ erro: 'Conta bloqueada. Fale com o administrador.' });
  const token = jwt.sign({ id: u.id, nome: u.nome, papel_app: u.papel_app }, SEGREDO, { expiresIn: '12h' });
  res.json({ token, usuario: { id: u.id, nome: u.nome, papel_app: u.papel_app } });
});

app.post('/api/acesso/solicitar', (_req, res) => res.json({ ok: true, mensagem: MSG_PEDIDO }));

/* ---------------- estações e PEP ---------------- */

app.get('/api/estacoes', autenticar, async (_req, res) => {
  const r = await q(`select id, titulo, area, duracao_min, origem, status from estacoes where status='aprovada' order by area, titulo`);
  res.json(r.rows);
});

/* ---------------- sessões ---------------- */

async function participante(sessaoId, usuarioId) {
  const r = await q('select * from sessao_participantes where sessao_id=$1 and usuario_id=$2', [sessaoId, usuarioId]);
  return r.rows[0] || null;
}

app.post('/api/sessoes', autenticar, async (req, res) => {
  const { estacaoId, modo } = req.body || {};
  const est = await q(`select id from estacoes where id=$1 and status='aprovada'`, [estacaoId]);
  if (!est.rows[0]) return res.status(400).json({ erro: 'Estação não encontrada.' });
  const papelDono = modo === 'solo' ? 'candidato' : 'avaliador_ator';
  const s = await q(
    `insert into sessoes (estacao_id, dono_id, modo) values ($1,$2,$3) returning id`,
    [estacaoId, req.usuario.id, modo === 'solo' ? 'solo' : 'dupla']
  );
  await q('insert into sessao_participantes (sessao_id, usuario_id, papel) values ($1,$2,$3)',
    [s.rows[0].id, req.usuario.id, papelDono]);
  res.status(201).json({ id: s.rows[0].id, papel: papelDono });
});

app.post('/api/sessoes/:id/entrar', autenticar, async (req, res) => {
  const sessaoId = req.params.id;
  const pedido = req.body?.papel;
  const s = await q('select * from sessoes where id=$1', [sessaoId]);
  if (!s.rows[0]) return res.status(404).json({ erro: 'Sala não encontrada.' });
  const sessao = s.rows[0];

  const ja = await participante(sessaoId, req.usuario.id);
  if (ja) return res.json({ papel: ja.papel }); // quem já está na sala volta sem gastar vaga

  let papel = 'observador';
  if (['candidato', 'avaliador_ator'].includes(pedido) && sessao.status !== 'finalizada') {
    const vaga = await q(
      `select 1 from sessao_participantes where sessao_id=$1 and papel=$2`, [sessaoId, pedido]);
    if (!vaga.rows[0]) papel = pedido;
  }
  if (papel === 'observador') {
    if (!sessao.permite_observadores) return res.status(403).json({ erro: 'Esta sala não permite observadores.' });
    const n = await q(`select count(*)::int c from sessao_participantes where sessao_id=$1 and papel='observador'`, [sessaoId]);
    if (n.rows[0].c >= sessao.max_observadores) return res.status(403).json({ erro: 'Sala de observadores lotada.' });
  }
  try {
    await q('insert into sessao_participantes (sessao_id, usuario_id, papel) values ($1,$2,$3)',
      [sessaoId, req.usuario.id, papel]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Essa vaga acabou de ser ocupada. Entre como observador.' });
    throw e;
  }
  res.json({ papel });
});

app.get('/api/sessoes', autenticar, async (req, res) => {
  const r = await q(
    `select s.id, s.status, s.modo, e.titulo, e.area, sp.papel,
       (select count(*)::int from sessao_participantes p2 where p2.sessao_id=s.id and p2.papel='observador') as observadores
     from sessao_participantes sp
     join sessoes s on s.id = sp.sessao_id
     join estacoes e on e.id = s.estacao_id
     where sp.usuario_id=$1 order by s.criado_em desc limit 20`, [req.usuario.id]);
  res.json(r.rows);
});

function tempoRestanteMs(sessao) {
  const total = sessao.duracao_min * 60000;
  const decorrido = Number(sessao.timer_acumulado_ms) +
    (sessao.timer_status === 'rodando' && sessao.timer_inicio_em
      ? Date.now() - new Date(sessao.timer_inicio_em).getTime() : 0);
  return Math.max(0, total - decorrido);
}

app.get('/api/sessoes/:id', autenticar, async (req, res) => {
  const sessaoId = req.params.id;
  const p = await participante(sessaoId, req.usuario.id);
  if (!p) return res.status(403).json({ erro: 'Você não está nesta sala.' });
  const s = await q(
    `select s.*, e.titulo, e.area, e.duracao_min, e.script_ator from sessoes s join estacoes e on e.id=s.estacao_id where s.id=$1`,
    [sessaoId]);
  const sessao = s.rows[0];
  const parts = await q(
    `select sp.papel, u.nome from sessao_participantes sp join usuarios u on u.id=sp.usuario_id where sp.sessao_id=$1`,
    [sessaoId]);

  // PEP e script do ator só saem para o avaliador (ou no modo solo). Candidato nunca recebe durante a prova.
  const vePep = p.papel === 'avaliador_ator' || sessao.modo === 'solo';
  let pep = [];
  if (vePep || sessao.status === 'finalizada') {
    const r = await q('select id, secao, ordem, descricao, pontos_total, pontos_parcial, critico from pep_itens where estacao_id=$1 order by ordem', [sessao.estacao_id]);
    pep = r.rows;
  }
  const coment = await q(
    `select c.id, c.tempo_ms, c.texto, u.nome as autor from comentarios_observador c join usuarios u on u.id=c.autor_id
      where c.sessao_id=$1 and ($2::boolean or c.autor_id=$3) order by c.tempo_ms`,
    [sessaoId, sessao.status === 'finalizada', req.usuario.id]);
  const av = await q('select nota, nota_max from avaliacoes where sessao_id=$1 and finalizada_em is not null', [sessaoId]);

  res.json({
    sessao: {
      id: sessao.id, titulo: sessao.titulo, area: sessao.area, modo: sessao.modo, status: sessao.status,
      canal: sessao.canal_video, duracao_min: sessao.duracao_min,
      script_ator: p.papel === 'avaliador_ator' ? sessao.script_ator : null,
    },
    meuPapel: p.papel,
    participantes: parts.rows,
    timer: { status: sessao.timer_status, restante_ms: tempoRestanteMs(sessao) },
    pep,
    comentarios: coment.rows,
    resultado: av.rows[0] || null,
  });
});

/* ---------------- token Agora (com failsafe) ---------------- */

app.get('/api/sessoes/:id/agora-token', autenticar, async (req, res) => {
  const sessaoId = req.params.id;
  const p = await participante(sessaoId, req.usuario.id);
  if (!p) return res.status(403).json({ erro: 'Você não está nesta sala.' });
  const s = await q('select canal_video from sessoes where id=$1', [sessaoId]);
  const canal = s.rows[0].canal_video;

  // Failsafe 1: sem credenciais Agora no servidor, a sala abre em modo demo (nada quebra).
  if (!agoraConfigurado()) return res.json({ modo: 'demo', canal, papel: p.papel });

  // uid numérico estável por usuário (Agora exige inteiro de 32 bits)
  const uid = (parseInt(crypto.createHash('md5').update(req.usuario.id).digest('hex').slice(0, 8), 16) % 2000000000) + 1;
  const publica = p.papel === 'candidato' || p.papel === 'avaliador_ator';
  const { token, expiraEm } = gerarToken(canal, uid, publica);
  res.json({
    modo: 'agora', appId: process.env.AGORA_APP_ID, canal, uid, token, expiraEm,
    papel: p.papel, publica,
    // Failsafe 2: endpoint PHP reserva (o front tenta se esta rota falhar)
    fallbackUrl: process.env.PHP_TOKEN_URL || null,
  });
});

/* ---------------- cronômetro, PEP, finalizar ---------------- */

async function estadoTimer(sessaoId) {
  const s = await q('select s.*, e.duracao_min from sessoes s join estacoes e on e.id=s.estacao_id where s.id=$1', [sessaoId]);
  return { status: s.rows[0].timer_status, restante_ms: tempoRestanteMs(s.rows[0]) };
}

async function acaoTimer(sessaoId, usuarioId, acao) {
  const p = await participante(sessaoId, usuarioId);
  const s = await q('select * from sessoes where id=$1', [sessaoId]);
  const sessao = s.rows[0];
  const pode = p && (p.papel === 'avaliador_ator' || sessao.modo === 'solo');
  if (!pode) return { erro: 'Só o avaliador controla o cronômetro.' };
  if (sessao.status === 'finalizada') return { erro: 'Sessão já finalizada.' };

  if (acao === 'iniciar' || acao === 'retomar') {
    await q(`update sessoes set timer_status='rodando', timer_inicio_em=now(), status='em_andamento' where id=$1`, [sessaoId]);
  } else if (acao === 'pausar') {
    await q(`update sessoes set timer_status='pausado',
             timer_acumulado_ms = timer_acumulado_ms + extract(epoch from now()-timer_inicio_em)*1000,
             timer_inicio_em=null where id=$1 and timer_status='rodando'`, [sessaoId]);
  } else if (acao === 'zerar') {
    await q(`update sessoes set timer_status='parado', timer_acumulado_ms=0, timer_inicio_em=null where id=$1`, [sessaoId]);
  } else {
    return { erro: 'Ação desconhecida.' };
  }
  return { ok: true, timer: await estadoTimer(sessaoId) };
}

app.post('/api/sessoes/:id/timer', autenticar, async (req, res) => {
  const r = await acaoTimer(req.params.id, req.usuario.id, req.body?.acao);
  if (r.erro) return res.status(403).json({ erro: r.erro });
  io.to(`sessao:${req.params.id}`).emit('timer:estado', r.timer);
  res.json(r.timer);
});

async function obterOuCriarAvaliacao(sessaoId, avaliadorId) {
  const a = await q('select * from avaliacoes where sessao_id=$1', [sessaoId]);
  if (a.rows[0]) return a.rows[0];
  const cand = await q(`select usuario_id from sessao_participantes where sessao_id=$1 and papel='candidato'`, [sessaoId]);
  const r = await q(
    'insert into avaliacoes (sessao_id, avaliador_id, candidato_id) values ($1,$2,$3) returning *',
    [sessaoId, avaliadorId, cand.rows[0]?.usuario_id || null]);
  return r.rows[0];
}

async function placarDa(avaliacaoId) {
  const r = await q(
    `select coalesce(sum(ai.pontos),0)::float total, coalesce((select sum(pontos_total) from pep_itens pi
        join avaliacoes a on a.sessao_id=$2 join sessoes s on s.id=a.sessao_id where a.id=$1 and pi.estacao_id=s.estacao_id),0)::float max
     from avaliacao_itens ai where ai.avaliacao_id=$1`, [avaliacaoId, null]);
  return r.rows[0];
}

/* ---------------- tempo real (Socket.IO) ---------------- */

io.use((socket, prox) => {
  try {
    socket.data.usuario = jwt.verify(socket.handshake.auth?.token, SEGREDO);
    prox();
  } catch { prox(new Error('não autorizado')); }
});

io.on('connection', (socket) => {
  socket.on('sala:entrar', async ({ sessaoId }, cb) => {
    const p = await participante(sessaoId, socket.data.usuario.id);
    if (!p) return cb?.({ erro: 'Você não está nesta sala.' });
    socket.data.papel = p.papel;
    socket.data.sessaoId = sessaoId;
    socket.join(`sessao:${sessaoId}`);
    const parts = await q(
      `select sp.papel, u.nome from sessao_participantes sp join usuarios u on u.id=sp.usuario_id where sp.sessao_id=$1`, [sessaoId]);
    io.to(`sessao:${sessaoId}`).emit('sala:presenca', parts.rows);
    cb?.({ ok: true });
  });

  socket.on('timer:acao', async ({ acao }) => {
    const sessaoId = socket.data.sessaoId;
    if (!sessaoId) return;
    const r = await acaoTimer(sessaoId, socket.data.usuario.id, acao);
    if (r.ok) io.to(`sessao:${sessaoId}`).emit('timer:estado', r.timer);
  });

  socket.on('pep:marcar', async ({ pepItemId, nivel }) => {
    const sessaoId = socket.data.sessaoId;
    if (!sessaoId || socket.data.papel !== 'avaliador_ator' && true) { /* papel conferido abaixo */ }
    const p = await participante(sessaoId, socket.data.usuario.id);
    if (!p || (p.papel !== 'avaliador_ator')) {
      const s = await q('select modo from sessoes where id=$1', [sessaoId]);
      if (!(p && s.rows[0]?.modo === 'solo')) return;
    }
    if (!['nao_realizado', 'parcial', 'total'].includes(nivel)) return;
    const item = await q('select * from pep_itens where id=$1', [pepItemId]);
    if (!item.rows[0]) return;
    const it = item.rows[0];
    const pontos = nivel === 'total' ? Number(it.pontos_total)
      : nivel === 'parcial' ? Number(it.pontos_parcial ?? it.pontos_total / 2) : 0;
    const av = await obterOuCriarAvaliacao(sessaoId, socket.data.usuario.id);
    await q(
      `insert into avaliacao_itens (avaliacao_id, pep_item_id, nivel, pontos) values ($1,$2,$3,$4)
       on conflict (avaliacao_id, pep_item_id) do update set nivel=$3, pontos=$4`,
      [av.id, pepItemId, nivel, pontos]);
    // O candidato não vê as marcações durante a prova: placar só para quem não é candidato.
    const sockets = await io.in(`sessao:${sessaoId}`).fetchSockets();
    for (const sk of sockets) if (sk.data.papel !== 'candidato') {
      sk.emit('pep:placar', await placarDa(av.id));
    }
  });

  socket.on('pep:finalizar', async () => {
    const sessaoId = socket.data.sessaoId;
    if (!sessaoId) return;
    const p = await participante(sessaoId, socket.data.usuario.id);
    const s = await q('select * from sessoes where id=$1', [sessaoId]);
    const sessao = s.rows[0];
    if (!p || (p.papel !== 'avaliador_ator' && sessao.modo !== 'solo')) return;
    if (sessao.status === 'finalizada') return;

    const av = await obterOuCriarAvaliacao(sessaoId, socket.data.usuario.id);
    // itens sem marcação entram como não realizado
    await q(
      `insert into avaliacao_itens (avaliacao_id, pep_item_id, nivel, pontos)
       select $1, pi.id, 'nao_realizado', 0 from pep_itens pi
       where pi.estacao_id=$2
       on conflict (avaliacao_id, pep_item_id) do nothing`, [av.id, sessao.estacao_id]);
    const pl = await q(
      `select coalesce(sum(pontos),0)::float nota from avaliacao_itens where avaliacao_id=$1`, [av.id]);
    const mx = await q(`select coalesce(sum(pontos_total),0)::float m from pep_itens where estacao_id=$1`, [sessao.estacao_id]);
    await q(`update avaliacoes set nota=$2, nota_max=$3, finalizada_em=now() where id=$1`,
      [av.id, pl.rows[0].nota, mx.rows[0].m]);
    await q(`update sessoes set status='finalizada', timer_status='parado', timer_inicio_em=null where id=$1`, [sessaoId]);
    io.to(`sessao:${sessaoId}`).emit('sessao:finalizada', { nota: pl.rows[0].nota, max: mx.rows[0].m });
  });

  socket.on('comentario:novo', async ({ texto, tempoMs }) => {
    const sessaoId = socket.data.sessaoId;
    if (!sessaoId || socket.data.papel !== 'observador') return;
    const limpo = String(texto || '').trim().slice(0, 500);
    if (!limpo) return;
    await q('insert into comentarios_observador (sessao_id, autor_id, tempo_ms, texto) values ($1,$2,$3,$4)',
      [sessaoId, socket.data.usuario.id, Math.max(0, Number(tempoMs) || 0), limpo]);
    const sockets = await io.in(`sessao:${sessaoId}`).fetchSockets();
    for (const sk of sockets) if (sk.data.papel === 'observador') {
      sk.emit('comentario:novo', { autor: socket.data.usuario.nome, texto: limpo, tempo_ms: Math.max(0, Number(tempoMs) || 0) });
    }
  });
});

/* ---------------- painel ---------------- */

app.get('/api/desempenho', autenticar, async (req, res) => {
  const g = await q(
    `select count(*)::int estacoes,
            coalesce(avg(case when nota_max>0 then nota/nota_max*10 end),0)::float nota_media
     from avaliacoes where candidato_id=$1 and finalizada_em is not null`, [req.usuario.id]);
  const area = await q(
    `select e.area, coalesce(avg(case when a.nota_max>0 then a.nota/a.nota_max*10 end),0)::float nota
     from avaliacoes a join sessoes s on s.id=a.sessao_id join estacoes e on e.id=s.estacao_id
     where a.candidato_id=$1 and a.finalizada_em is not null group by e.area`, [req.usuario.id]);
  res.json({ ...g.rows[0], por_area: area.rows });
});

app.get('/api/saude', (_req, res) => res.json({ ok: true, agora: agoraConfigurado() ? 'configurado' : 'demo' }));

servidor.listen(PORTA, () => console.log(`API Revalida Prático na porta ${PORTA}`));
