// Servidor HTTP de teste: liga as rotas REAIS (auth, recuperação, admin) a um Postgres real e serve o front compilado.
// Só bcrypt, jwt e express são substitutos mínimos (ver ../ajuda.mjs). Não use fora de testes.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { bcryptFalso, criarBanco, criarQ, jwtFalso } from '../ajuda.mjs';
import { criarAssinar, criarAutenticar, registrarLogin, registrarSolicitacao } from '../../src/auth.js';
import { registrarRecuperacao } from '../../src/recuperacao.js';
import { registrarAdmin } from '../../src/admin.js';
import { garantirRoot } from '../../src/bootstrap.js';

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export async function iniciar({ pastaWeb, porta = 0 }) {
  const banco = criarBanco('rv_e2e');
  const q = criarQ(banco.nome);
  const emails = [];
  const rotas = [];
  const reg = (m) => (c, ...hs) => rotas.push({ m, c, hs });
  const app = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH') };
  const assinar = criarAssinar({ jwt: jwtFalso, segredo: 'e2e' });
  const autenticar = criarAutenticar({ q, jwt: jwtFalso, segredo: 'e2e' });
  const enviar = async (m) => { emails.push(m); return true; };
  registrarLogin(app, { q, bcrypt: bcryptFalso, assinar, dummyHash: bcryptFalso.hashSync('x') });
  registrarSolicitacao(app, { q });
  registrarRecuperacao(app, { q, autenticar, bcrypt: bcryptFalso, assinar, enviar, appUrl: 'http://localhost' });
  registrarAdmin(app, { q, autenticar, enviar, appUrl: 'http://localhost' });
  await garantirRoot({ q, bcrypt: bcryptFalso, env: { ROOT_EMAIL: 'root@m3d.pro', ROOT_SENHA: 'arcano123' }, log: { log() {} } });
  const mkUser = async (nome, email, senha, papel = 'usuario') =>
    q('insert into usuarios (nome,email,senha_hash,papel_app) values ($1,$2,$3,$4)', [nome, email, await bcryptFalso.hash(senha), papel]);
  await mkUser('Ana Souza', 'ana@x.com', 'senhaforte123');
  await mkUser('Moda Dora', 'moda@x.com', 'senhaforte123', 'moderador');
  await q(`insert into solicitacoes_acesso (nome,email,mensagem) values ('Rafael Lima','rafael@ex.com','Prova em novembro')`);
  await q(`insert into estacoes (titulo, area, status) values ('Dor torácica na UBS','clinica_medica','revisao')`);

  const servidor = http.createServer(async (req, resp) => {
    const url = new URL(req.url, 'http://x');
    const enviarJson = (status, corpo) => { resp.writeHead(status, { 'Content-Type': 'application/json' }); resp.end(JSON.stringify(corpo)); };
    if (url.pathname === '/__emails') return enviarJson(200, emails);
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
    if (!existsSync(arq)) arq = join(pastaWeb, 'index.html');
    resp.writeHead(200, { 'Content-Type': TIPOS[extname(arq)] ?? 'application/octet-stream' });
    resp.end(readFileSync(arq));
  });
  await new Promise((r) => servidor.listen(porta, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${servidor.address().port}`, emails, q, fechar: () => { servidor.close(); banco.derrubar(); } };
}
