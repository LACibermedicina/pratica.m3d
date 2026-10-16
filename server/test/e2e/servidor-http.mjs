// Servidor HTTP de teste: liga as rotas REAIS (auth, recuperação, admin) a um Postgres real e serve o front compilado.
// Só bcrypt, jwt e express são substitutos mínimos (ver ../ajuda.mjs). Não use fora de testes.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { bcryptFalso, criarBanco, criarQ, jwtFalso } from '../ajuda.mjs';
import { criarAssinar, criarAutenticar, registrarLogin, registrarSolicitacao } from '../../src/auth.js';
import { registrarRecuperacao } from '../../src/recuperacao.js';
import { registrarAdmin } from '../../src/admin.js';
import { garantirRoot } from '../../src/bootstrap.js';
import { criarAgora } from '../../src/agora.js';
import { criarConfig } from '../../src/config.js';
import { criarEmailer } from '../../src/email.js';
import { registrarVideo } from '../../src/video.js';
import { registrarInstalacao, registrarManutencao } from '../../src/instalacao.js';

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export const CODIGO_INSTALACAO = 'E2E0-C0DE-1234';

export async function iniciar({ pastaWeb, porta = 0, instalado = true, extras = true, agoraAtivo = false }) {
  const banco = criarBanco('rv_e2e');
  const q = criarQ(banco.nome);
  const emails = [];
  const rotas = [];
  const reg = (m) => (c, ...hs) => rotas.push({ m, c, hs });
  const app = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH') };
  const eventos = [];
  const assinar = criarAssinar({ jwt: jwtFalso, segredo: 'e2e' });
  const autenticar = criarAutenticar({ q, jwt: jwtFalso, segredo: 'e2e' });
  const enviar = async (m) => { emails.push(m); return true; };
  registrarLogin(app, { q, bcrypt: bcryptFalso, assinar, dummyHash: bcryptFalso.hashSync('x') });
  registrarSolicitacao(app, { q });
  registrarRecuperacao(app, { q, autenticar, bcrypt: bcryptFalso, assinar, enviar, appUrl: 'http://localhost' });
  registrarAdmin(app, { q, autenticar, enviar, appUrl: 'http://localhost' });
  await garantirRoot({ q, bcrypt: bcryptFalso, env: { ROOT_EMAIL: 'root@m3d.pro', ROOT_SENHA: 'arcano123' }, log: { log() {} } });
  const cfg = criarConfig({ q, env: agoraAtivo ? { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) } : {}, segredo: 'e2e-segredo-com-mais-de-32-caracteres!' });
  const builder = { buildTokenWithUidAndPrivilege: (a, c, ch, uid, t, j, audio) => `007${audio > 0 ? 'A' : 'M'}.${ch}.${uid}` };
  const agora = criarAgora({ cfg, carregarBuilder: async () => builder });
  const emailer = criarEmailer({ env: { NODE_ENV: 'test' }, log: { log() {}, warn() {}, error() {} } });
  registrarVideo(app, { q, autenticar, agora, cfg, emitir: (sala, evento, dados) => eventos.push({ sala, evento, dados }) });
  let codigoAtual = CODIGO_INSTALACAO;
  registrarInstalacao(app, { q, bcrypt: bcryptFalso, cfg, agora, emailer, codigo: () => codigoAtual, segredoJwt: 'e2e-segredo-com-mais-de-32-caracteres!', log: { log() {} } });
  registrarManutencao(app, { q, autenticar, bcrypt: bcryptFalso, novoCodigo: () => (codigoAtual = `NOVO-${Date.now().toString(36).toUpperCase()}`), log: { log() {} } });
  if (instalado) await q(`insert into config_servidor (chave, valor) values ('instalado_em','e2e')`);

  // rotas de sala SÓ PARA TESTE (espelham as de src/index.js, que depende de express/socket.io reais)
  const part = async (sid, uid) => (await q('select * from sessao_participantes where sessao_id=$1 and usuario_id=$2', [sid, uid])).rows[0];
  app.post('/api/sessoes/:id/entrar', autenticar, async (rq, rs) => {
    const papel = ['candidato', 'avaliador_ator'].includes(rq.body?.papel) ? rq.body.papel : 'observador';
    if (!(await part(rq.params.id, rq.usuario.id))) await q('insert into sessao_participantes (sessao_id, usuario_id, papel) values ($1,$2,$3)', [rq.params.id, rq.usuario.id, papel]);
    rs.json({ papel: (await part(rq.params.id, rq.usuario.id)).papel });
  });
  app.get('/api/sessoes/:id', autenticar, async (rq, rs) => {
    const p = await part(rq.params.id, rq.usuario.id);
    if (!p) return rs.status(403).json({ erro: 'Você não está nesta sala.' });
    const x = (await q('select s.*, e.titulo, e.area, e.duracao_min, e.script_ator from sessoes s join estacoes e on e.id=s.estacao_id where s.id=$1', [rq.params.id])).rows[0];
    const ps = (await q('select sp.papel, u.nome from sessao_participantes sp join usuarios u on u.id=sp.usuario_id where sp.sessao_id=$1', [rq.params.id])).rows;
    rs.json({ meuPapel: p.papel, participantes: ps, pep: [], comentarios: [], resultado: null,
      timer: { status: x.timer_status, restante_ms: x.duracao_min * 60000 },
      sessao: { id: x.id, titulo: x.titulo, area: x.area, modo: x.modo, status: x.status, canal: x.canal_video, audio_observadores: x.audio_observadores, duracao_min: x.duracao_min, script_ator: null } });
  });

  const mkUser = async (nome, email, senha, papel = 'usuario') =>
    q('insert into usuarios (nome,email,senha_hash,papel_app) values ($1,$2,$3,$4)', [nome, email, await bcryptFalso.hash(senha), papel]);
  if (extras) {
    await mkUser('Ana Souza', 'ana@x.com', 'senhaforte123');
    await mkUser('Moda Dora', 'moda@x.com', 'senhaforte123', 'moderador');
    await q(`insert into solicitacoes_acesso (nome,email,mensagem) values ('Rafael Lima','rafael@ex.com','Prova em novembro')`);
    await q(`insert into estacoes (titulo, area, status) values ('Dor torácica na UBS','clinica_medica','revisao')`);
  }

  const servidor = http.createServer(async (req, resp) => {
    const url = new URL(req.url, 'http://x');
    const enviarJson = (status, corpo) => { resp.writeHead(status, { 'Content-Type': 'application/json' }); resp.end(JSON.stringify(corpo)); };
    if (url.pathname === '/__emails') return enviarJson(200, emails);
    if (url.pathname === '/__eventos') return enviarJson(200, eventos.slice(Number(url.searchParams.get('desde') || 0)));
    if (url.pathname.startsWith('/api/')) {
      let texto = ''; for await (const c of req) texto += c;
      let corpo; try { corpo = texto ? JSON.parse(texto) : undefined; } catch { return enviarJson(400, { erro: 'json' }); }
      const alvo = rotas.find((r) => r.m === req.method && r.c.split('/').length === url.pathname.split('/').length && r.c.split('/').every((p, i) => p.startsWith(':') || p === url.pathname.split('/')[i]));
      if (!alvo) return enviarJson(404, { erro: 'não encontrado' });
      const params = {}; alvo.c.split('/').forEach((p, i) => { if (p.startsWith(':')) params[p.slice(1)] = url.pathname.split('/')[i]; });
      const rq = { method: req.method, path: url.pathname, body: corpo, params, headers: req.headers, ip: '127.0.0.1', query: Object.fromEntries(url.searchParams) };
      const rs = { statusCode: 200, headersSent: false, status(n) { this.statusCode = n; return this; }, json(o) { this.headersSent = true; enviarJson(this.statusCode, o); } };
      let i = 0; const prox = () => { const h = alvo.hs[i++]; if (h) void Promise.resolve(h(rq, rs, prox)).catch(() => enviarJson(500, { erro: 'erro' })); };
      return prox();
    }
    let arq = join(pastaWeb, url.pathname === '/' ? 'index.html' : url.pathname);
    if (existsSync(arq) && statSync(arq).isDirectory()) arq = join(arq, 'index.html');
    if (!existsSync(arq)) arq = join(pastaWeb, 'index.html');
    resp.writeHead(200, { 'Content-Type': TIPOS[extname(arq)] ?? 'application/octet-stream' });
    resp.end(readFileSync(arq));
  });
  await new Promise((r) => servidor.listen(porta, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${servidor.address().port}`, codigo: () => codigoAtual, emails, q, eventos, cfg, assinar, mkUser, fechar: () => { servidor.close(); banco.derrubar(); } };
}
