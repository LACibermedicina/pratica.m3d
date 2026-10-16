// Ajudas de teste: Postgres real via psql (sem driver), "express" mínimo e bcrypt/jwt falsos (só para teste).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMA = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

const psql = (db, entrada) => execFileSync('psql', ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: entrada, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

export function criarBanco(prefixo = 'rv_test') {
  const nome = `${prefixo}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  execFileSync('createdb', [nome]);
  psql(nome, readFileSync(SCHEMA, 'utf8'));
  return { nome, derrubar: () => { try { execFileSync('dropdb', ['--if-exists', nome]); } catch { /* ignora */ } } };
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'boolean' ? (v ? 'true' : 'false') : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const aspas = (s) => (s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s);

function csv(texto) {
  const linhas = []; let campo = ''; let linha = []; let q = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (q) { if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += c; }
    else if (c === '"') q = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}
void aspas;

/** q(sql, params) com a mesma forma do `pg`: { rows }. Valida o SQL como o driver faz (PREPARE com parâmetros sem tipo) e executa com literais. */
export function criarQ(db) {
  return async (sql, params = []) => {
    const sqlLit = sql.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
    // 1) sintaxe e inferência de tipos dos parâmetros ($1 sem tipo), como no node-pg
    const desc = psql(db, `PREPARE s AS ${sql.replace(/;\s*$/, '')};\nDEALLOCATE s;\n${sqlLit.replace(/;\s*$/, '')}\n\\gdesc\n`);
    const tipos = csv(desc).slice(1).map(([nome, tipo]) => [nome, tipo]);
    if (!tipos.length) { psql(db, sqlLit.replace(/;\s*$/, '') + ';\n'); return { rows: [] }; }
    // 2) execução (uma vez)
    const saida = csv(psql(db, sqlLit.replace(/;\s*$/, '') + ';\n'));
    const rows = saida.slice(1).map((l) => Object.fromEntries(tipos.map(([nome, tipo], i) => {
      const v = l[i];
      if (v === '' && tipo !== 'text' && tipo !== 'citext') return [nome, null];
      if (tipo === 'boolean') return [nome, v === 't'];
      if (/^(integer|bigint|smallint)$/.test(tipo)) return [nome, Number(v)];
      if (/^(json|jsonb)$/.test(tipo)) return [nome, JSON.parse(v)];
      if (/^(numeric|double precision|real)/.test(tipo)) return [nome, Number(v)];
      return [nome, v];
    })));
    return { rows };
  };
}

/** Mini "express": registra rotas e permite chamá-las sem rede. */
export function criarApp() {
  const rotas = [];
  const reg = (metodo) => (caminho, ...hs) => rotas.push({ metodo, caminho, hs });
  const app = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE'), use() {}, set() {} };
  async function chamar(metodo, url, { corpo, token, ip = '10.0.0.1', query, codigo, headers: hExtra } = {}) {
    const [caminho, qs] = url.split('?');
    const alvo = rotas.find((r) => {
      if (r.metodo !== metodo) return false;
      const a = r.caminho.split('/'), b = caminho.split('/');
      return a.length === b.length && a.every((p, i) => p.startsWith(':') || p === b[i]);
    });
    if (!alvo) throw new Error(`rota inexistente: ${metodo} ${caminho}`);
    const params = {};
    alvo.caminho.split('/').forEach((p, i) => { if (p.startsWith(':')) params[p.slice(1)] = caminho.split('/')[i]; });
    const req = { method: metodo, path: caminho, body: corpo, params, ip, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(codigo ? { 'x-codigo-instalacao': codigo } : {}), ...(hExtra ?? {}) }, query: query ?? Object.fromEntries(new URLSearchParams(qs ?? '')) };
    let fim;
    const respondeu = new Promise((r) => { fim = r; });
    const res = { statusCode: 200, corpo: undefined, headersSent: false, status(n) { this.statusCode = n; return this; }, json(o) { this.corpo = o; this.headersSent = true; fim(); return this; } };
    let i = 0;
    // como no Express: o middleware chama prox() sem esperar; quem encerra é res.json()
    const prox = () => { const h = alvo.hs[i++]; if (h) void Promise.resolve(h(req, res, prox)).catch((e) => { console.error('exceção na rota', e); fim(); }); };
    prox();
    await Promise.race([respondeu, new Promise((_, rej) => setTimeout(() => rej(new Error(`sem resposta: ${metodo} ${caminho}`)), 20000))]);
    return { status: res.statusCode, corpo: res.corpo };
  }
  return { app, chamar };
}

/** bcrypt e jwt de mentira: determinísticos e rápidos. NÃO usar fora de testes. */
export const bcryptFalso = {
  hash: async (s) => `h$${Buffer.from(s).toString('base64')}`,
  compare: async (s, h) => h === `h$${Buffer.from(s).toString('base64')}`,
  hashSync: (s) => `h$${Buffer.from(s).toString('base64')}`,
};
export const jwtFalso = {
  sign: (p, segredo) => `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${segredo}`,
  verify: (t, segredo) => {
    const [corpo, seg] = String(t).split('.');
    if (!corpo || seg !== segredo) throw new Error('jwt inválido');
    return JSON.parse(Buffer.from(corpo, 'base64url').toString());
  },
};
