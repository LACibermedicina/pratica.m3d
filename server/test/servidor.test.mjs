// Testa recuperação de senha, conta root e rotas administrativas contra um Postgres de verdade.
// (bcrypt, jwt e express são substituídos por versões mínimas só para teste; ver ajuda.mjs)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bcryptFalso, criarApp, criarBanco, criarQ, jwtFalso } from './ajuda.mjs';
import { criarAssinar, criarAutenticar, registrarLogin, registrarSolicitacao, MSG_LOGIN } from '../src/auth.js';
import { registrarRecuperacao, MSG_RECUPERAR } from '../src/recuperacao.js';
import { registrarAdmin } from '../src/admin.js';
import { garantirRoot } from '../src/bootstrap.js';
import { sha256 } from '../src/seguranca.js';

const banco = criarBanco();
const q = criarQ(banco.nome);
const { app, chamar } = criarApp();
const emails = [];
const enviar = async (m) => { emails.push(m); return true; };
const SEG = 'segredo-de-teste';
const assinar = criarAssinar({ jwt: jwtFalso, segredo: SEG });
const autenticar = criarAutenticar({ q, jwt: jwtFalso, segredo: SEG });
const silencioso = { log() {}, warn() {}, error() {} };
let ipN = 0;
const ip = () => `10.1.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;

before(() => {
  registrarLogin(app, { q, bcrypt: bcryptFalso, assinar, dummyHash: bcryptFalso.hashSync('falsa') });
  registrarSolicitacao(app, { q });
  registrarRecuperacao(app, { q, autenticar, bcrypt: bcryptFalso, assinar, enviar, appUrl: 'https://app.exemplo' });
  registrarAdmin(app, { q, autenticar, enviar, appUrl: 'https://app.exemplo' });
});
after(() => banco.derrubar());

const criarUsuario = async (nome, email, papel = 'usuario', senha = 'senhaforte123') => {
  const r = await q(`insert into usuarios (nome,email,senha_hash,papel_app) values ($1,$2,$3,$4) returning id`, [nome, email, await bcryptFalso.hash(senha), papel]);
  return r.rows[0].id;
};
const entrar = async (email, senha, i = ip()) => chamar('POST', '/api/auth/entrar', { corpo: { email, senha }, ip: i });
const tokenDe = async (email, senha) => (await entrar(email, senha)).corpo.token;
const ultimoEmail = () => emails.at(-1);
const tokenDoEmail = (m) => m.texto.match(/#\/redefinir\/([0-9a-f]{64})/)?.[1];

/* ---------------------------------------------------------------- root */
test('root: criado a partir do ambiente, com senha provisória; não duplica', async () => {
  const env = { ROOT_EMAIL: 'Root@M3D.pro', ROOT_SENHA: 'arcano123' };
  const r1 = await garantirRoot({ q, bcrypt: bcryptFalso, env, log: silencioso });
  assert.equal(r1.acao, 'criado'); assert.equal(r1.provisoria, true);
  const u = (await q(`select papel_app, ativo, senha_provisoria, email::text e from usuarios where email='root@m3d.pro'`)).rows[0];
  assert.deepEqual([u.papel_app, u.ativo, u.senha_provisoria, u.e], ['root', true, true, 'root@m3d.pro']);
  assert.equal((await garantirRoot({ q, bcrypt: bcryptFalso, env, log: silencioso })).acao, 'mantido');
  assert.equal((await q(`select count(*)::int c from usuarios where papel_app='root'`)).rows[0].c, 1);
  // o banco recusa um segundo root, mesmo por SQL direto
  await assert.rejects(() => q(`insert into usuarios (nome,email,senha_hash,papel_app) values ('x','x@x.com','h','root')`));
  // sem variáveis: não cria nada
  assert.equal((await garantirRoot({ q, bcrypt: bcryptFalso, env: {}, log: silencioso })).acao, 'ignorado');
});

test('root: troca de e-mail no ambiente rebaixa o root antigo e promove o novo', async () => {
  await criarUsuario('Outro', 'outro-root@m3d.pro');
  const r = await garantirRoot({ q, bcrypt: bcryptFalso, env: { ROOT_EMAIL: 'outro-root@m3d.pro', ROOT_SENHA: 'umaSenhaForte99' }, log: silencioso });
  assert.equal(r.acao, 'promovido');
  assert.equal((await q(`select papel_app from usuarios where email='root@m3d.pro'`)).rows[0].papel_app, 'admin');
  // volta ao padrão para os testes seguintes
  await garantirRoot({ q, bcrypt: bcryptFalso, env: { ROOT_EMAIL: 'root@m3d.pro', ROOT_SENHA: 'arcano123' }, log: silencioso });
  assert.equal((await q(`select papel_app from usuarios where email='root@m3d.pro'`)).rows[0].papel_app, 'root');
  await q(`delete from usuarios where email='outro-root@m3d.pro'`);
});

test('login: root entra com a senha informada; erro igual para senha errada e e-mail inexistente', async () => {
  const ok = await entrar('root@m3d.pro', 'arcano123');
  assert.equal(ok.status, 200);
  assert.equal(ok.corpo.usuario.papel_app, 'root'); assert.equal(ok.corpo.senhaProvisoria, true); assert.ok(ok.corpo.token);
  const errada = await entrar('root@m3d.pro', 'errada1234');
  const inexistente = await entrar('ninguem@x.com', 'errada1234');
  assert.equal(errada.status, 401); assert.deepEqual(errada.corpo, inexistente.corpo); assert.equal(errada.corpo.erro, MSG_LOGIN);
});

test('login: após 5 erros do mesmo IP e e-mail, bloqueia (429), mesmo com a senha certa; outro IP segue livre', async () => {
  await criarUsuario('Lia', 'lia@x.com');
  const meu = ip();
  for (let i = 0; i < 5; i++) assert.equal((await entrar('lia@x.com', 'errada1234', meu)).status, 401);
  assert.equal((await entrar('lia@x.com', 'senhaforte123', meu)).status, 429);
  assert.equal((await entrar('lia@x.com', 'senhaforte123', ip())).status, 200);
});

test('sessão: token inválido, conta bloqueada e papel lido do banco', async () => {
  assert.equal((await chamar('GET', '/api/admin/resumo', { token: 'lixo' })).status, 401);
  assert.equal((await chamar('GET', '/api/admin/resumo')).status, 401);
  const t = await tokenDe('lia@x.com', 'senhaforte123');
  assert.equal((await chamar('GET', '/api/admin/resumo', { token: t })).status, 403);   // usuário comum
  await q(`update usuarios set papel_app='moderador' where email='lia@x.com'`);
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: t })).status, 200); // vale já, sem novo login
  await q(`update usuarios set papel_app='usuario' where email='lia@x.com'`);
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: t })).status, 403);
  await q(`update usuarios set ativo=false where email='lia@x.com'`);
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: t })).status, 401);
  await q(`update usuarios set ativo=true where email='lia@x.com'`);
});

/* ------------------------------------------------------ pedidos de acesso */
test('pedido de acesso: guarda, não duplica pendente, resposta sempre igual', async () => {
  const a = await chamar('POST', '/api/acesso/solicitar', { corpo: { nome: 'Rafael Souza', email: 'Rafael@Ex.com', mensagem: 'Prova em novembro' }, ip: ip() });
  const b = await chamar('POST', '/api/acesso/solicitar', { corpo: { nome: 'Rafael Souza', email: 'rafael@ex.com' }, ip: ip() });
  assert.equal(a.status, 200); assert.deepEqual(a.corpo, b.corpo);
  assert.equal((await q(`select count(*)::int c from solicitacoes_acesso where email='rafael@ex.com'`)).rows[0].c, 1);
  assert.equal((await chamar('POST', '/api/acesso/solicitar', { corpo: { nome: 'A', email: 'ruim' }, ip: ip() })).status, 400);
});

test('admin aprova pedido: gera token de 1 uso preso ao e-mail, envia por e-mail e audita; só uma vez', async () => {
  const tk = await tokenDe('root@m3d.pro', 'arcano123');
  const lista = await chamar('GET', '/api/admin/pedidos', { token: tk });
  assert.equal(lista.corpo.length, 1);
  const id = lista.corpo[0].id;
  assert.equal((await chamar('POST', `/api/admin/pedidos/${id}/aprovar`, { token: tk, corpo: { validadeH: 0 } })).status, 400);
  const r = await chamar('POST', `/api/admin/pedidos/${id}/aprovar`, { token: tk, corpo: { validadeH: 48 } });
  assert.equal(r.status, 200); assert.equal(r.corpo.emailEnviado, true);
  const linha = (await q(`select tipo, email_preso::text e, usos_max, usos, revogado, (expira_em > now() + interval '47 hours') longo from tokens_acesso where hash=$1`, [sha256(r.corpo.token)])).rows[0];
  assert.deepEqual([linha.tipo, linha.e, linha.usos_max, linha.usos, linha.revogado, linha.longo], ['solicitacao', 'rafael@ex.com', 1, 0, false, true]);
  assert.match(ultimoEmail().texto, new RegExp(r.corpo.token));
  assert.equal((await q(`select count(*)::int c from tokens_acesso where hash=$1`, [r.corpo.token])).rows[0].c, 0, 'token em claro nunca vai ao banco');
  assert.equal((await chamar('POST', `/api/admin/pedidos/${id}/aprovar`, { token: tk, corpo: {} })).status, 404);
  assert.equal((await chamar('POST', '/api/admin/pedidos/nao-e-uuid/recusar', { token: tk })).status, 400);
  assert.equal((await q(`select count(*)::int c from auditoria_admin where acao='pedido_aprovado'`)).rows[0].c, 1);
});

test('admin recusa pedido', async () => {
  await chamar('POST', '/api/acesso/solicitar', { corpo: { nome: 'Ana Lima', email: 'ana@ex.com' }, ip: ip() });
  const tk = await tokenDe('root@m3d.pro', 'arcano123');
  const id = (await chamar('GET', '/api/admin/pedidos', { token: tk })).corpo[0].id;
  assert.equal((await chamar('POST', `/api/admin/pedidos/${id}/recusar`, { token: tk })).status, 200);
  assert.equal((await chamar('GET', '/api/admin/pedidos', { token: tk })).corpo.length, 0);
});

/* ------------------------------------------------------------ permissões */
test('permissões: moderador, admin e root', async () => {
  await criarUsuario('Moda', 'moda@x.com', 'moderador');
  await criarUsuario('Adm', 'adm@x.com', 'admin');
  await criarUsuario('Adm2', 'adm2@x.com', 'admin');
  const alvo = await criarUsuario('Alvo', 'alvo@x.com');
  const tm = await tokenDe('moda@x.com', 'senhaforte123');
  const ta = await tokenDe('adm@x.com', 'senhaforte123');
  const tr = await tokenDe('root@m3d.pro', 'arcano123');
  const admId = (await q(`select id from usuarios where email='adm2@x.com'`)).rows[0].id;
  const rootId = (await q(`select id from usuarios where email='root@m3d.pro'`)).rows[0].id;
  const meuAdmId = (await q(`select id from usuarios where email='adm@x.com'`)).rows[0].id;

  assert.equal((await chamar('GET', '/api/admin/pedidos', { token: tm })).status, 403);
  assert.equal((await chamar('GET', '/api/admin/usuarios', { token: tm })).status, 403);
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: tm })).status, 200);

  // admin: bloqueia usuário comum, mas não admin, root nem a si mesmo, e não muda papéis
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${alvo}`, { token: ta, corpo: { ativo: false } })).status, 200);
  assert.equal((await q(`select ativo from usuarios where id=$1`, [alvo])).rows[0].ativo, false);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${admId}`, { token: ta, corpo: { ativo: false } })).status, 403);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${rootId}`, { token: ta, corpo: { ativo: false } })).status, 403);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${meuAdmId}`, { token: ta, corpo: { ativo: false } })).status, 403);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${alvo}`, { token: ta, corpo: { papel_app: 'admin' } })).status, 403);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${alvo}`, { token: ta, corpo: {} })).status, 400);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${alvo}`, { token: ta, corpo: { ativo: 'sim' } })).status, 400);

  // root: muda papéis, age sobre admin; ninguém vira root pela API; root não é tocado nem por ele
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${alvo}`, { token: tr, corpo: { ativo: true, papel_app: 'moderador' } })).status, 200);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${admId}`, { token: tr, corpo: { papel_app: 'usuario' } })).status, 200);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${alvo}`, { token: tr, corpo: { papel_app: 'root' } })).status, 400);
  assert.equal((await chamar('PATCH', `/api/admin/usuarios/${rootId}`, { token: tr, corpo: { ativo: false } })).status, 403);

  // tokens: admin só de 1 uso; root de vários
  const body = { validadeH: 24, email: 'novo@x.com', nota: 'colega' };
  assert.equal((await chamar('POST', '/api/admin/tokens', { token: ta, corpo: { ...body, usosMax: 5 } })).status, 403);
  const um = await chamar('POST', '/api/admin/tokens', { token: ta, corpo: body });
  assert.equal(um.status, 201); assert.match(um.corpo.token, /^[0-9a-f]{32}$/);
  const varios = await chamar('POST', '/api/admin/tokens', { token: tr, corpo: { validadeH: 24, usosMax: 5 } });
  assert.equal(varios.status, 201);
  assert.equal((await q(`select usos_max from tokens_acesso where hash=$1`, [sha256(varios.corpo.token)])).rows[0].usos_max, 5);
  assert.equal((await chamar('POST', '/api/admin/tokens', { token: ta, corpo: { validadeH: 24, email: 'sem-arroba' } })).status, 400);
  assert.equal((await chamar('POST', '/api/admin/tokens', { token: ta, corpo: { validadeH: 9999 } })).status, 400);

  // listagem não expõe hash; revogar
  const lista = (await chamar('GET', '/api/admin/tokens', { token: ta })).corpo;
  assert.ok(lista.length >= 2); assert.ok(lista.every((t) => !('hash' in t)));
  const id1 = lista.find((t) => t.email_preso === 'novo@x.com').id;
  assert.equal((await chamar('POST', `/api/admin/tokens/${id1}/revogar`, { token: ta })).status, 200);
  assert.equal((await chamar('POST', `/api/admin/tokens/${id1}/revogar`, { token: ta })).status, 404);

  // usuários: busca e curingas escapados
  const todos = (await chamar('GET', '/api/admin/usuarios', { token: ta })).corpo;
  assert.ok(todos.length >= 6); assert.ok(todos.every((u) => !('senha_hash' in u)));
  assert.equal((await chamar('GET', '/api/admin/usuarios?busca=moda', { token: ta })).corpo.length, 1);
  assert.equal((await chamar('GET', '/api/admin/usuarios?busca=%25', { token: ta })).corpo.length, 0, '% literal não vira curinga');
});

test('bloquear derruba a sessão na hora e o desbloqueio exige novo login', async () => {
  await criarUsuario('Beto', 'beto@x.com');
  const tb = await tokenDe('beto@x.com', 'senhaforte123');
  const id = (await q(`select id from usuarios where email='beto@x.com'`)).rows[0].id;
  const tr = await tokenDe('root@m3d.pro', 'arcano123');
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: tb })).status, 403); // sessão válida (sem permissão)
  await chamar('PATCH', `/api/admin/usuarios/${id}`, { token: tr, corpo: { ativo: false } });
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: tb })).status, 401);
  assert.equal((await entrar('beto@x.com', 'senhaforte123')).status, 403);
  await chamar('PATCH', `/api/admin/usuarios/${id}`, { token: tr, corpo: { ativo: true } });
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: tb })).status, 401, 'token antigo não ressuscita');
  assert.equal((await entrar('beto@x.com', 'senhaforte123')).status, 200);
});

test('estações: moderador aprova; status inválido recusado', async () => {
  const e = await q(`insert into estacoes (titulo, area, status) values ('Teste', 'cirurgia', 'revisao') returning id`);
  const tm = await tokenDe('moda@x.com', 'senhaforte123');
  const lista = await chamar('GET', '/api/admin/estacoes', { token: tm });
  assert.ok(lista.corpo.some((x) => x.id === e.rows[0].id));
  assert.equal((await chamar('POST', `/api/admin/estacoes/${e.rows[0].id}/status`, { token: tm, corpo: { status: 'qualquer' } })).status, 400);
  assert.equal((await chamar('POST', `/api/admin/estacoes/${e.rows[0].id}/status`, { token: tm, corpo: { status: 'aprovada' } })).status, 200);
  assert.equal((await q(`select status from estacoes where id=$1`, [e.rows[0].id])).rows[0].status, 'aprovada');
});

/* --------------------------------------------------- recuperação de senha */
test('recuperar senha: mesma resposta com ou sem conta; e-mail só para conta ativa', async () => {
  emails.length = 0;
  await criarUsuario('Cris', 'cris@x.com');
  const a = await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'CRIS@x.com' }, ip: ip() });
  const b = await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'fantasma@x.com' }, ip: ip() });
  assert.equal(a.status, 200); assert.deepEqual(a.corpo, b.corpo); assert.equal(a.corpo.mensagem, MSG_RECUPERAR);
  assert.equal(emails.length, 1); assert.equal(emails[0].para, 'cris@x.com');
  assert.match(emails[0].texto, /https:\/\/app\.exemplo\/#\/redefinir\/[0-9a-f]{64}/);
  await q(`update usuarios set ativo=false where email='cris@x.com'`);
  await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'cris@x.com' }, ip: ip() });
  assert.equal(emails.length, 1, 'conta bloqueada não recebe link');
  await q(`update usuarios set ativo=true where email='cris@x.com'`);
  assert.equal((await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'ruim' }, ip: ip() })).status, 400);
});

test('redefinir: link de uso único troca a senha e derruba sessões antigas', async () => {
  emails.length = 0;
  const antigo = await tokenDe('cris@x.com', 'senhaforte123');
  await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'cris@x.com' }, ip: ip() });
  const link = tokenDoEmail(ultimoEmail());
  const i = ip();
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: link, senha: 'curta1' }, ip: i })).status, 400);   // senha fraca não gasta o link
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: 'x'.repeat(64), senha: 'NovaSenha2026' }, ip: i })).status, 400);
  const ok = await chamar('POST', '/api/auth/redefinir', { corpo: { token: link, senha: 'NovaSenha2026' }, ip: i });
  assert.equal(ok.status, 200);
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: link, senha: 'OutraSenha2026' }, ip: i })).status, 400, 'uso único');
  assert.equal((await entrar('cris@x.com', 'senhaforte123')).status, 401);
  assert.equal((await entrar('cris@x.com', 'NovaSenha2026')).status, 200);
  assert.equal((await chamar('GET', '/api/admin/estacoes', { token: antigo })).status, 401, 'sessão antiga caiu');
  assert.equal((await q(`select count(*)::int c from recuperacoes_senha where hash=$1`, [link])).rows[0].c, 0, 'token em claro nunca vai ao banco');
});

test('redefinir: link vencido ou substituído por um mais novo não funciona', async () => {
  emails.length = 0;
  await criarUsuario('Edu', 'edu@x.com');
  const ipa = ip();
  await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'edu@x.com' }, ip: ipa });
  const velho = tokenDoEmail(ultimoEmail());
  await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'edu@x.com' }, ip: ipa });
  const novo = tokenDoEmail(ultimoEmail());
  assert.notEqual(velho, novo);
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: velho, senha: 'SenhaNova12345' }, ip: ip() })).status, 400, 'o anterior é invalidado');
  await q(`update recuperacoes_senha set expira_em = now() - interval '1 minute' where hash=$1`, [sha256(novo)]);
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: novo, senha: 'SenhaNova12345' }, ip: ip() })).status, 400, 'vencido');
});

test('recuperar: no máximo 3 e-mails por hora para o mesmo endereço (resposta continua igual)', async () => {
  emails.length = 0;
  await criarUsuario('Duda', 'duda@x.com');
  const respostas = [];
  for (let k = 0; k < 5; k++) respostas.push(await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'duda@x.com' }, ip: ip() }));
  assert.ok(respostas.every((r) => r.status === 200));
  assert.equal(emails.filter((m) => m.para === 'duda@x.com').length, 3);
});

test('root recupera a senha por e-mail e deixa de ser provisória', async () => {
  emails.length = 0;
  await chamar('POST', '/api/auth/recuperar', { corpo: { email: 'root@m3d.pro' }, ip: ip() });
  const link = tokenDoEmail(ultimoEmail());
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: link, senha: 'RootForte-2026' }, ip: ip() })).status, 200);
  assert.equal((await entrar('root@m3d.pro', 'arcano123')).status, 401);
  const ok = await entrar('root@m3d.pro', 'RootForte-2026');
  assert.equal(ok.status, 200); assert.equal(ok.corpo.senhaProvisoria, false); assert.equal(ok.corpo.usuario.papel_app, 'root');
  // volta à senha de teste (como no início)
  await q(`update usuarios set senha_hash=$1, senha_provisoria=true, sessao_versao=sessao_versao+1 where email='root@m3d.pro'`, [await bcryptFalso.hash('arcano123')]);
});

test('admin gera link de senha para usuário comum (não para admin/root) e o link funciona', async () => {
  const ta = await tokenDe('adm@x.com', 'senhaforte123');
  const comum = (await q(`select id from usuarios where email='duda@x.com'`)).rows[0].id;
  const outroAdmin = (await q(`select id from usuarios where email='adm2@x.com'`)).rows[0].id; // virou 'usuario' no teste de permissões
  await q(`update usuarios set papel_app='admin' where id=$1`, [outroAdmin]);
  assert.equal((await chamar('POST', `/api/admin/usuarios/${outroAdmin}/redefinicao`, { token: ta })).status, 403);
  const r = await chamar('POST', `/api/admin/usuarios/${comum}/redefinicao`, { token: ta });
  assert.equal(r.status, 200); assert.equal(r.corpo.validadeMin, 60);
  const t = r.corpo.link.match(/#\/redefinir\/([0-9a-f]{64})$/)[1];
  assert.equal((await chamar('POST', '/api/auth/redefinir', { corpo: { token: t, senha: 'EscolhaDaDuda2026' }, ip: ip() })).status, 200);
  assert.equal((await entrar('duda@x.com', 'EscolhaDaDuda2026')).status, 200);
});

/* ------------------------------------------------------------ trocar senha */
test('trocar senha logado: exige a atual, valida a nova, devolve sessão nova e derruba a antiga', async () => {
  const velho = await tokenDe('root@m3d.pro', 'arcano123');
  const T = (corpo) => chamar('POST', '/api/auth/trocar-senha', { token: velho, corpo });
  assert.equal((await T({ atual: 'errada12345', nova: 'NovaRoot-2026' })).status, 400);
  assert.equal((await T({ atual: 'arcano123', nova: 'curta' })).status, 400);
  assert.equal((await T({ atual: 'arcano123', nova: 'arcano123' })).status, 400);
  const ok = await T({ atual: 'arcano123', nova: 'NovaRoot-2026' });
  assert.equal(ok.status, 200); assert.equal(ok.corpo.senhaProvisoria, false); assert.equal(ok.corpo.usuario.papel_app, 'root');
  assert.equal((await chamar('GET', '/api/admin/resumo', { token: velho })).status, 401);
  assert.equal((await chamar('GET', '/api/admin/resumo', { token: ok.corpo.token })).status, 200);
  assert.equal((await entrar('root@m3d.pro', 'NovaRoot-2026')).status, 200);
});

test('trocar senha: 5 senhas atuais erradas bloqueiam por 15 min', async () => {
  const t = await tokenDe('beto@x.com', 'senhaforte123');
  for (let k = 0; k < 5; k++) assert.equal((await chamar('POST', '/api/auth/trocar-senha', { token: t, corpo: { atual: 'x', nova: 'NovaSenha2026' } })).status, 400);
  assert.equal((await chamar('POST', '/api/auth/trocar-senha', { token: t, corpo: { atual: 'senhaforte123', nova: 'NovaSenha2026' } })).status, 429);
});

/* --------------------------------------------------------------- auditoria */
test('auditoria: registra ações e só admin/root leem', async () => {
  const tr = await tokenDe('root@m3d.pro', 'NovaRoot-2026');
  const r = await chamar('GET', '/api/admin/auditoria', { token: tr });
  assert.equal(r.status, 200);
  const acoes = new Set(r.corpo.map((x) => x.acao));
  for (const a of ['pedido_aprovado', 'pedido_recusado', 'token_criado', 'token_revogado', 'usuario_alterado', 'link_senha_gerado', 'estacao_status', 'root_bootstrap']) assert.ok(acoes.has(a), `faltou ${a}`);
  const tm = await tokenDe('moda@x.com', 'senhaforte123');
  assert.equal((await chamar('GET', '/api/admin/auditoria', { token: tm })).status, 403);
  assert.equal((await chamar('GET', '/api/admin/resumo', { token: tr })).corpo.usuarios >= 6, true);
});
