// Instalador do primeiro acesso e permissões de vídeo/áudio, contra um Postgres de verdade.
import test, { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { bcryptFalso, criarApp, criarBanco, criarQ, jwtFalso } from './ajuda.mjs';
import { criarAssinar, criarAutenticar } from '../src/auth.js';
import { criarAgora, permissoesDeMidia, VALIDADE_AUDIO_OBS_S, VALIDADE_TOKEN_S } from '../src/agora.js';
import { criarConfig, cifrar, decifrar } from '../src/config.js';
import { registrarVideo } from '../src/video.js';
import { reconhecerInstalacaoExistente, registrarInstalacao } from '../src/instalacao.js';
import { criarEmailer } from '../src/email.js';

const banco = criarBanco();
const q = criarQ(banco.nome);
const SEG = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const silencioso = { log() {}, warn() {}, error() {} };
const assinar = criarAssinar({ jwt: jwtFalso, segredo: SEG });
const autenticar = criarAutenticar({ q, jwt: jwtFalso, segredo: SEG });
const mk = async (nome, email, papel = 'usuario') =>
  (await q(`insert into usuarios (nome,email,senha_hash,papel_app) values ($1,$2,'x',$3) returning id`, [nome, email, papel])).rows[0].id;
const tk = (id) => assinar({ id, papel_app: 'usuario', sessao_versao: 0 });

/* ================================ permissões de mídia ================================ */
test('permissoesDeMidia: vídeo para todos; áudio de observador só se liberado', () => {
  for (const p of ['candidato', 'avaliador_ator', 'observador']) assert.equal(permissoesDeMidia(p, false).video, true);
  assert.equal(permissoesDeMidia('candidato', false).audio, true);
  assert.equal(permissoesDeMidia('avaliador_ator', false).audio, true);
  assert.equal(permissoesDeMidia('observador', false).audio, false);
  assert.equal(permissoesDeMidia('observador', true).audio, true);
  assert.equal(permissoesDeMidia('observador', 'true').audio, false, 'só boolean true libera');
  assert.equal(permissoesDeMidia('observador', undefined).audio, false);
  assert.equal(permissoesDeMidia('avaliador_ator', false).chefe, true);
  assert.equal(permissoesDeMidia('candidato', true).chefe, false);
});

test('agora.gerarToken: privilégios separados, durações relativas, áudio 0 = sem privilégio', async () => {
  const chamadas = [];
  const Builder = { buildTokenWithUidAndPrivilege: (...a) => { chamadas.push(a); return `007tok${chamadas.length}`; } };
  const cfg = criarConfig({ q, env: { AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) }, segredo: SEG });
  const ag = criarAgora({ cfg, carregarBuilder: async () => Builder });
  assert.equal(ag.configurado(), true);
  await ag.gerarToken({ canal: 'c', uid: 7, audio: 'nenhum' });
  await ag.gerarToken({ canal: 'c', uid: 7, audio: 'curto' });
  await ag.gerarToken({ canal: 'c', uid: 7, audio: 'sempre' });
  const audio = chamadas.map((c) => c[6]), video = chamadas.map((c) => c[7]);
  assert.deepEqual(audio, [0, VALIDADE_AUDIO_OBS_S, VALIDADE_TOKEN_S]);
  assert.deepEqual(video, [VALIDADE_TOKEN_S, VALIDADE_TOKEN_S, VALIDADE_TOKEN_S], 'vídeo liberado para todos');
  assert.ok(chamadas.every((c) => c[5] === VALIDADE_TOKEN_S && c[8] === 0 && c[4] === VALIDADE_TOKEN_S));
  assert.ok(chamadas.every((c) => c[4] < 100000), 'duração é relativa (segundos), não epoch');
  const velho = criarAgora({ cfg, carregarBuilder: async () => ({ buildTokenWithUid() {} }) });
  await assert.rejects(velho.gerarToken({ canal: 'c', uid: 1, audio: 'nenhum' }), /privilégios/);
});

/* ================================ rotas de vídeo ================================ */
const ctxVideo = {};
before(async () => {
  const { app, chamar } = criarApp();
  const eventos = [];
  const chamadas = [];
  const agoraFalso = { on: true, configurado() { return this.on; }, appId: () => 'app123', gerarToken: async (a) => { chamadas.push(a); return { token: '007x', expiraEm: 1, audioExpiraEm: null }; } };
  const cfg = criarConfig({ q, env: {}, segredo: SEG });
  registrarVideo(app, { q, autenticar, agora: agoraFalso, cfg, emitir: (...a) => eventos.push(a) });
  Object.assign(ctxVideo, { chamar, eventos, chamadas, agoraFalso });
});
after(() => banco.derrubar());

async function sala() {
  const n = Math.random().toString(36).slice(2, 8);
  const [chefe, cand, obs, fora] = await Promise.all([mk('Chefe', `ch${n}@x.com`), mk('Cand', `ca${n}@x.com`), mk('Obs', `ob${n}@x.com`), mk('Fora', `fo${n}@x.com`)]);
  const e = (await q(`insert into estacoes (titulo, area, status) values ('T','cirurgia','aprovada') returning id`)).rows[0].id;
  const s = (await q(`insert into sessoes (estacao_id, dono_id) values ($1,$2) returning id`, [e, chefe])).rows[0].id;
  for (const [u, p] of [[chefe, 'avaliador_ator'], [cand, 'candidato'], [obs, 'observador']]) await q(`insert into sessao_participantes (sessao_id, usuario_id, papel) values ($1,$2,$3)`, [s, u, p]);
  return { s, chefe: tk(chefe), cand: tk(cand), obs: tk(obs), fora: tk(fora) };
}

test('vídeo: observador entra SEM áudio por padrão; chefe libera e o token passa a ter áudio curto', async () => {
  const { chamar, chamadas } = ctxVideo;
  const r = await sala();
  chamadas.length = 0;
  const o1 = await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.obs });
  assert.equal(o1.corpo.modo, 'agora');
  assert.equal(o1.corpo.audioObservadores, false);
  assert.equal(o1.corpo.pode.audio, false); assert.equal(o1.corpo.pode.video, true);
  assert.equal(chamadas.at(-1).audio, 'nenhum');
  const c1 = await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.cand });
  assert.equal(chamadas.at(-1).audio, 'sempre'); assert.equal(c1.corpo.pode.audio, true);
  await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.chefe });
  assert.equal(chamadas.at(-1).audio, 'sempre');

  const lib = await chamar('PATCH', `/api/sessoes/${r.s}/audio-observadores`, { token: r.chefe, corpo: { liberado: true } });
  assert.equal(lib.status, 200);
  assert.deepEqual(ctxVideo.eventos.at(-1), [r.s, 'video:permissao', { audio_observadores: true }]);
  const o2 = await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.obs });
  assert.equal(o2.corpo.pode.audio, true); assert.equal(chamadas.at(-1).audio, 'curto');

  await chamar('PATCH', `/api/sessoes/${r.s}/audio-observadores`, { token: r.chefe, corpo: { liberado: false } });
  const o3 = await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.obs });
  assert.equal(o3.corpo.pode.audio, false); assert.equal(chamadas.at(-1).audio, 'nenhum', 'revogação vale já no próximo token');
});

test('vídeo: só o chefe muda a permissão; ninguém de fora recebe token', async () => {
  const { chamar } = ctxVideo;
  const r = await sala();
  for (const quem of ['obs', 'cand', 'fora']) {
    const x = await chamar('PATCH', `/api/sessoes/${r.s}/audio-observadores`, { token: r[quem], corpo: { liberado: true } });
    assert.equal(x.status, 403, quem);
  }
  assert.equal((await q(`select audio_observadores a from sessoes where id='${r.s}'`)).rows[0].a, false);
  assert.equal((await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.fora })).status, 403);
  assert.equal((await chamar('GET', `/api/sessoes/não-é-uuid/agora-token`, { token: r.obs })).status, 403);
  for (const ruim of [{}, { liberado: 'true' }, { liberado: 1 }]) {
    assert.equal((await chamar('PATCH', `/api/sessoes/${r.s}/audio-observadores`, { token: r.chefe, corpo: ruim })).status, 400);
  }
  await q(`update sessoes set status='finalizada' where id='${r.s}'`);
  assert.equal((await chamar('PATCH', `/api/sessoes/${r.s}/audio-observadores`, { token: r.chefe, corpo: { liberado: true } })).status, 409);
});

test('vídeo: sem credenciais Agora a sala abre em modo demonstração, com as mesmas permissões', async () => {
  const { chamar, agoraFalso } = ctxVideo;
  const r = await sala();
  agoraFalso.on = false;
  try {
    const x = await chamar('GET', `/api/sessoes/${r.s}/agora-token`, { token: r.obs });
    assert.equal(x.corpo.modo, 'demo'); assert.equal(x.corpo.pode.audio, false); assert.equal(x.corpo.token, undefined);
  } finally { agoraFalso.on = true; }
});

test('esquema: sessões novas nascem com áudio de observadores BLOQUEADO', async () => {
  const r = await sala();
  assert.equal((await q(`select audio_observadores a from sessoes where id='${r.s}'`)).rows[0].a, false);
});

/* ================================ config ================================ */
test('config: ambiente vence o banco; segredos cifrados em repouso e ausentes da visão', async () => {
  const cfg = criarConfig({ q, env: { APP_URL: 'https://do-ambiente.com' }, segredo: SEG });
  await cfg.definir('AGORA_APP_CERTIFICATE', 'c'.repeat(32));
  await cfg.definir('APP_URL', 'https://do-banco.com');
  assert.equal(cfg.obter('APP_URL'), 'https://do-ambiente.com'); assert.equal(cfg.origem('APP_URL'), 'ambiente');
  const guardado = (await q(`select valor, segredo from config_servidor where chave='AGORA_APP_CERTIFICATE'`)).rows[0];
  assert.equal(guardado.segredo, true); assert.ok(!guardado.valor.includes('cccc'));
  const v = cfg.visao();
  assert.equal(v.AGORA_APP_CERTIFICATE.definido, true); assert.equal('valor' in v.AGORA_APP_CERTIFICATE, false);
  assert.ok(!JSON.stringify(v).includes('cccc'));
  const outra = criarConfig({ q, env: {}, segredo: SEG }); await outra.carregar();
  assert.equal(outra.obter('AGORA_APP_CERTIFICATE'), 'c'.repeat(32));
  const trocada = criarConfig({ q, env: {}, segredo: 'outro-segredo' }); await trocada.carregar();
  assert.equal(trocada.obter('AGORA_APP_CERTIFICATE'), undefined, 'JWT_SEGREDO diferente não decifra');
  assert.equal(decifrar(cifrar('x', SEG), SEG), 'x'); assert.equal(decifrar('lixo', SEG), undefined);
  await q(`delete from config_servidor`);
});

/* ================================ instalador ================================ */
const inst = {};
before(async () => {
  await q(`delete from config_servidor`); await q(`delete from usuarios where email::text like '%@x.com'`);
  const { app, chamar } = criarApp();
  const emails = [];
  const cfg = criarConfig({ q, env: {}, segredo: SEG });
  const builder = { buildTokenWithUidAndPrivilege: (a, c, ch, u, t, j, au) => `007${au}-${ch}` };
  const agora = criarAgora({ cfg, carregarBuilder: async () => builder });
  const emailer = criarEmailer({ env: { SMTP_URL: undefined, NODE_ENV: 'test' }, log: silencioso });
  const real = emailer.enviar; emailer.enviar = async (m) => { emails.push(m); return real(m); };
  registrarInstalacao(app, { q, bcrypt: bcryptFalso, cfg, agora, emailer, codigo: 'ABCD-1234-EF56', segredoJwt: SEG, producao: false, log: silencioso });
  Object.assign(inst, { chamar, cfg, emails });
});
const I = (m, u, corpo, codigo = 'ABCD-1234-EF56', ip = '10.9.0.1') =>
  inst.chamar(m, `/api/instalacao/${u}`, { corpo, ip, headers: undefined, token: undefined, ...(codigo ? { codigo } : {}) });

test('instalador: servidor novo informa não instalado; rotas exigem o código de instalação', async () => {
  assert.deepEqual((await I('GET', 'estado')).corpo, { instalado: false });
  for (const rota of ['verificar', 'config-ler', 'admins-lista']) {
    assert.equal((await I('POST', rota, {}, null)).status, 401, rota);
    assert.equal((await I('POST', rota, {}, 'ERRADO')).status, 401, rota);
  }
  assert.equal((await I('POST', 'root', { senha: 'senhaforte123', email: 'a@x.com' }, null)).status, 401);
  assert.equal((await q(`select count(*)::int c from usuarios where papel_app='root'`)).rows[0].c, 0, 'nada foi criado sem o código');
});

test('instalador: código errado repetido bloqueia o IP (429), mesmo depois com o código certo', async () => {
  let ultimo;
  for (let i = 0; i < 10; i++) ultimo = await I('POST', 'verificar', {}, 'ERRADO', '10.9.9.9');
  assert.equal(ultimo.status, 401);
  assert.equal((await I('POST', 'verificar', {}, 'ABCD-1234-EF56', '10.9.9.9')).status, 429);
  assert.equal((await I('POST', 'verificar', {}, 'ABCD-1234-EF56', '10.9.8.8')).status, 200, 'outro IP não é afetado');
});

test('instalador: verificações de banco, estrutura, segredo, e-mail e vídeo', async () => {
  const r = await I('POST', 'verificar', {});
  const por = Object.fromEntries(r.corpo.itens.map((i) => [i.id, i]));
  assert.equal(por.banco.status, 'ok'); assert.equal(por.esquema.status, 'ok'); assert.equal(por.jwt.status, 'ok');
  assert.equal(por.email.status, 'aviso'); assert.equal(por.video.status, 'aviso');
  assert.equal(r.corpo.admins, 0);
  // estrutura incompleta é detectada
  const ddl = (sql) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', banco.nome, '-c', sql]);
  ddl('alter table sessoes rename column audio_observadores to audio_x');
  try { assert.equal((await I('POST', 'verificar', {})).corpo.itens.find((i) => i.id === 'esquema').status, 'erro'); }
  finally { ddl('alter table sessoes rename column audio_x to audio_observadores'); }
});

test('instalador: parâmetros validados; segredos aceitos mas nunca devolvidos', async () => {
  const ruim = await I('POST', 'config', { AGORA_APP_ID: 'curto', APP_URL: 'ftp://x' });
  assert.equal(ruim.status, 400); assert.deepEqual(ruim.corpo.invalidos.sort(), ['AGORA_APP_ID', 'APP_URL']);
  const bom = await I('POST', 'config', { APP_URL: 'https://prova.exemplo/qualquer/caminho', NOME_INSTITUICAO: 'Cursinho X', AGORA_APP_ID: 'A'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32), SMTP_URL: 'smtps://u:senhasecreta@smtp.exemplo.com' });
  assert.equal(bom.status, 200);
  assert.equal(inst.cfg.obter('APP_URL'), 'https://prova.exemplo');
  assert.equal(inst.cfg.obter('AGORA_APP_ID'), 'a'.repeat(32));
  const txt = JSON.stringify((await I('POST', 'config-ler', {})).corpo) + JSON.stringify(bom.corpo);
  assert.ok(!txt.includes('senhasecreta') && !txt.includes('bbbbbbbb'), 'segredos não voltam ao navegador');
  // segredo vazio = manter
  await I('POST', 'config', { AGORA_APP_CERTIFICATE: '' });
  assert.equal(inst.cfg.obter('AGORA_APP_CERTIFICATE'), 'b'.repeat(32));
  // agora configurado: a verificação gera tokens com e sem áudio
  const v = (await I('POST', 'verificar', {})).corpo.itens.find((i) => i.id === 'video');
  assert.equal(v.status, 'ok', v.detalhe);
  await I('POST', 'config', { AGORA_APP_ID: '' }); // apagar não-segredo
  assert.equal(inst.cfg.obter('AGORA_APP_ID'), undefined);
});

test('instalador: e-mail de teste', async () => {
  assert.equal((await I('POST', 'email-teste', { para: 'invalido' })).status, 400);
  const r = await I('POST', 'email-teste', { para: 'dono@x.com' });
  assert.equal(r.corpo.entregue, false, 'sem SMTP real, não conta como entregue');
  assert.equal(inst.emails.at(-1).para, 'dono@x.com');
});

test('instalador: conta raiz e administradores com senha própria; não conclui sem admin definitivo', async () => {
  // root vindo do ambiente com senha provisória
  await q(`insert into usuarios (nome,email,senha_hash,papel_app,senha_provisoria) values ('Administrador raiz','root@m3d.pro','h','root',true)`);
  assert.equal((await I('POST', 'concluir', {})).status, 409, 'só há root provisório');
  assert.equal((await I('POST', 'root', { senha: 'curta' })).status, 400);
  const r = await I('POST', 'root', { senha: 'novaSenhaRoot99' });
  assert.equal(r.corpo.email, 'root@m3d.pro'); assert.equal(r.corpo.criado, false);
  const u = (await q(`select senha_provisoria p, sessao_versao v from usuarios where papel_app='root'`)).rows[0];
  assert.equal(u.p, false); assert.equal(u.v, 1, 'sessões antigas do root caem');
  assert.equal((await I('POST', 'admins', { nome: 'Ana', email: 'ana@x.com', senha: 'fraca' })).status, 400);
  assert.equal((await I('POST', 'admins', { nome: 'Ana', email: 'ana@x.com', senha: 'senhaforte123', papel: 'admin' })).status, 200);
  assert.equal((await I('POST', 'admins', { nome: 'Ana2', email: 'ANA@x.com', senha: 'senhaforte123' })).status, 409);
  assert.equal((await I('POST', 'admins', { nome: 'Bia', email: 'bia@x.com', senha: 'senhaforte123', papel: 'root' })).corpo.papel, 'admin', 'não dá para criar um segundo root');
  const lista = (await I('POST', 'admins-lista', {})).corpo.usuarios;
  assert.ok(lista.some((x) => x.email === 'ana@x.com' && x.papel === 'admin' && !x.provisoria));
  assert.ok(!JSON.stringify(lista).includes('senha_hash'));
});

test('instalador: conclui, tranca para sempre e registra na auditoria', async () => {
  const c = await I('POST', 'concluir', {});
  assert.equal(c.status, 200, JSON.stringify(c.corpo));
  assert.deepEqual((await I('GET', 'estado')).corpo, { instalado: true });
  for (const [m, rota] of [['POST', 'verificar'], ['POST', 'config'], ['POST', 'root'], ['POST', 'admins'], ['POST', 'concluir'], ['POST', 'config-ler']]) {
    assert.equal((await I(m, rota, { senha: 'senhaforte123', email: 'z@x.com', nome: 'Zed' })).status, 403, rota);
  }
  assert.equal((await q(`select count(*)::int c from usuarios where email='z@x.com'`)).rows[0].c, 0);
  assert.equal((await q(`select count(*)::int c from auditoria_admin where acao='instalacao_concluida'`)).rows[0].c, 1);
});

test('instalador: servidor que já tem usuários reais é reconhecido como instalado', async () => {
  await q(`delete from config_servidor where chave='instalado_em'`);
  await q(`delete from sessoes`);
  await q(`delete from usuarios where papel_app<>'root'`);
  assert.equal(await reconhecerInstalacaoExistente(q, silencioso), false, 'só root = servidor novo');
  await mk('Gente', 'gente@x.com');
  assert.equal(await reconhecerInstalacaoExistente(q, silencioso), true);
  assert.equal((await q(`select count(*)::int c from config_servidor where chave='instalado_em'`)).rows[0].c, 1);
});

/* ================================ reinstalação e limpeza ================================ */
test('manutenção: reinstalar e limpar banco são só do root, com senha e frase; reabrem o instalador', async () => {
  const { registrarManutencao, estaInstalado } = await import('../src/instalacao.js');
  await q(`delete from sessoes`); await q(`delete from avaliacoes`); await q(`delete from usuarios`); await q(`delete from config_servidor`);
  const hash = await bcryptFalso.hash('SenhaRoot123');
  const ins = async (nome, email, papel) => (await q(`insert into usuarios (nome,email,senha_hash,papel_app,senha_provisoria) values ($1,$2,$3,$4,false) returning id`, [nome, email, hash, papel])).rows[0].id;
  const rootId = await ins('Raiz', 'root@m3d.pro', 'root'); const adminId = await ins('Adm', 'adm@x.com', 'admin');
  const { app, chamar } = criarApp();
  const cfg = criarConfig({ q, env: {}, segredo: SEG });
  const agora = criarAgora({ cfg, carregarBuilder: async () => ({}) });
  const emailer = criarEmailer({ env: { NODE_ENV: 'test' }, log: silencioso });
  let codigo = 'CODIGO-VELHO'; let gerados = 0;
  registrarInstalacao(app, { q, bcrypt: bcryptFalso, cfg, agora, emailer, codigo: () => codigo, segredoJwt: SEG, log: silencioso });
  registrarManutencao(app, { q, autenticar, bcrypt: bcryptFalso, novoCodigo: () => { gerados++; return (codigo = `NOVO-${gerados}`); }, log: silencioso });
  const R = (rota, token, corpo) => chamar('POST', `/api/admin/instalacao/${rota}`, { token, corpo, ip: '10.7.7.7' });
  const tkRoot = tk(rootId), tkAdm = tk(adminId);
  await q(`insert into config_servidor (chave, valor) values ('instalado_em','x')`);
  await q(`insert into config_servidor (chave, valor) values ('APP_URL','https://meu.site')`);
  assert.equal(await estaInstalado(q), true);

  // permissões e confirmações
  assert.equal((await R('reinstalar', tkAdm, { senha: 'SenhaRoot123', confirmacao: 'REINSTALAR' })).status, 403, 'admin comum não');
  assert.equal((await R('reinstalar', null, {})).status, 401);
  assert.equal((await R('reinstalar', tkRoot, { senha: 'errada12345', confirmacao: 'REINSTALAR' })).status, 400);
  assert.equal((await R('reinstalar', tkRoot, { senha: 'SenhaRoot123', confirmacao: 'reinstalar' })).status, 400, 'frase exata');
  assert.equal(await estaInstalado(q), true, 'nada mudou');

  // reinstalar: reabre o instalador SEM apagar dados; código novo; reinício não "reconhece" como instalado
  const r1 = await R('reinstalar', tkRoot, { senha: 'SenhaRoot123', confirmacao: 'REINSTALAR' });
  assert.equal(r1.status, 200);
  assert.equal(await estaInstalado(q), false); assert.equal(gerados, 1);
  assert.equal((await q(`select count(*)::int c from usuarios`)).rows[0].c, 2, 'dados intactos');
  assert.equal(await reconhecerInstalacaoExistente(q, silencioso), false, 'há usuários, mas a reinstalação está pendente');
  assert.equal((await chamar('POST', '/api/instalacao/verificar', { codigo: 'CODIGO-VELHO', corpo: {}, ip: '10.7.7.8' })).status, 401, 'código antigo não vale');
  assert.equal((await chamar('POST', '/api/instalacao/verificar', { codigo: 'NOVO-1', corpo: {}, ip: '10.7.7.8' })).status, 200);
  const c = await chamar('POST', '/api/instalacao/concluir', { codigo: 'NOVO-1', corpo: {}, ip: '10.7.7.8' });
  assert.equal(c.status, 200, JSON.stringify(c.corpo));
  assert.equal(await estaInstalado(q), true);
  assert.equal((await q(`select count(*)::int c from config_servidor where chave='reinstalacao_pendente'`)).rows[0].c, 0);
  assert.equal(await reconhecerInstalacaoExistente(q, silencioso), true);
  assert.equal((await chamar('POST', '/api/instalacao/verificar', { codigo: 'NOVO-1', corpo: {}, ip: '10.7.7.8' })).status, 403, 'trancado de novo');

  // limpar banco
  const est = (await q(`insert into estacoes (titulo, area, status) values ('E','cirurgia','aprovada') returning id`)).rows[0].id;
  const sid = (await q(`insert into sessoes (estacao_id, dono_id) values ($1,$2) returning id`, [est, adminId])).rows[0].id;
  await q(`insert into sessao_participantes (sessao_id, usuario_id, papel) values ($1,$2,'avaliador_ator')`, [sid, adminId]);
  await q(`insert into tokens_acesso (tipo, token_hash, usos_max) values ('master','mh',1000), ('indicacao','ih',1)`).catch(async () => {});
  const nEstAntes = (await q(`select count(*)::int c from estacoes`)).rows[0].c;
  const l1 = await R('limpar-banco', tkRoot, { senha: 'SenhaRoot123', confirmacao: 'REINSTALAR' });
  assert.equal(l1.status, 400, 'frase da outra ação não serve');
  const l = await R('limpar-banco', tkRoot, { senha: 'SenhaRoot123', confirmacao: 'APAGAR TUDO' });
  assert.equal(l.status, 200, JSON.stringify(l.corpo));
  const n = async (t) => (await q(`select count(*)::int c from ${t}`)).rows[0].c;
  assert.deepEqual([await n('usuarios'), await n('sessoes'), await n('sessao_participantes')], [0, 0, 0]);
  assert.equal(await n('estacoes'), nEstAntes, 'estações mantidas por padrão');
  assert.equal((await q(`select count(*)::int c from config_servidor where chave='APP_URL'`)).rows[0].c, 1, 'parâmetros mantidos');
  assert.equal(await estaInstalado(q), false);
  assert.equal((await q(`select count(*)::int c from tokens_acesso where tipo<>'master'`)).rows[0].c, 0);
  assert.equal((await q(`select count(*)::int c from auditoria_admin where acao='banco_limpo'`)).rows[0].c, 1);
  assert.equal((await chamar('GET', '/api/admin/instalacao/x', { token: tkRoot }).catch(() => ({ status: 404 }))).status, 404);
  const sessaoVelha = await autenticar.length; void sessaoVelha;
  assert.equal(await reconhecerInstalacaoExistente(q, silencioso), false, 'sem usuários e pendente: instalador');
  // a sessão do root apagado não vale mais
  const { app: a2, chamar: ch2 } = criarApp(); registrarManutencao(a2, { q, autenticar, bcrypt: bcryptFalso, novoCodigo: () => 'X', log: silencioso });
  assert.equal((await ch2('POST', '/api/admin/instalacao/reinstalar', { token: tkRoot, corpo: {} })).status, 401);
  // opção de apagar também as estações
  await limparBancoDireto(q);
  async function limparBancoDireto(qq) { const { limparBanco } = await import('../src/instalacao.js'); await limparBanco(qq, { apagarEstacoes: true }); assert.equal(await n('estacoes'), 0); }
});

test('manutenção: 5 senhas erradas bloqueiam o root por alguns minutos', async () => {
  const { registrarManutencao } = await import('../src/instalacao.js');
  await q(`delete from sessoes`); await q(`delete from usuarios`);
  const hash = await bcryptFalso.hash('SenhaRoot123');
  const id = (await q(`insert into usuarios (nome,email,senha_hash,papel_app) values ('Raiz','root@m3d.pro',$1,'root') returning id`, [hash])).rows[0].id;
  const { app, chamar } = criarApp();
  registrarManutencao(app, { q, autenticar, bcrypt: bcryptFalso, novoCodigo: () => 'X', log: silencioso });
  let ult;
  for (let i = 0; i < 5; i++) ult = await chamar('POST', '/api/admin/instalacao/reinstalar', { token: tk(id), corpo: { senha: 'errada', confirmacao: 'REINSTALAR' } });
  assert.equal(ult.status, 400);
  assert.equal((await chamar('POST', '/api/admin/instalacao/reinstalar', { token: tk(id), corpo: { senha: 'SenhaRoot123', confirmacao: 'REINSTALAR' } })).status, 429);
});

/* ================================ regressões da hospedagem real ================================ */
test('agora-token (CommonJS) é achado em mod.RtcTokenBuilder OU mod.default.RtcTokenBuilder; ausência dá erro claro', async () => {
  const { resolverBuilder } = await import('../src/agora.js');
  const B = { buildTokenWithUidAndPrivilege() {} };
  assert.equal(resolverBuilder({ RtcTokenBuilder: B }), B);
  assert.equal(resolverBuilder({ default: { RtcTokenBuilder: B } }), B, 'caso do erro "reading buildTokenWithUidAndPrivilege"');
  assert.throws(() => resolverBuilder({}), /agora-token/);
  assert.throws(() => resolverBuilder(undefined), /agora-token/);
});

test('ambiente: SMTP_HOST/PORT/USER/PASS e MAIL_FROM viram SMTP_URL/EMAIL_DE; ROOT_PASSWORD vale como ROOT_SENHA', async () => {
  const { valorDoAmbiente } = await import('../src/config.js');
  const env = { SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'info@m3d.pro', SMTP_PASS: '@2x/y', MAIL_FROM: 'info@m3d.pro' };
  assert.equal(valorDoAmbiente(env, 'SMTP_URL'), 'smtps://info%40m3d.pro:%402x%2Fy@smtp.hostinger.com:465');
  assert.equal(valorDoAmbiente(env, 'EMAIL_DE'), 'info@m3d.pro');
  assert.equal(valorDoAmbiente({ SMTP_HOST: 'h', SMTP_PORT: '587' }, 'SMTP_URL'), 'smtp://h:587');
  assert.equal(valorDoAmbiente({ SMTP_URL: 'smtps://a:b@c:1', SMTP_HOST: 'x' }, 'SMTP_URL'), 'smtps://a:b@c:1', 'SMTP_URL explícito vence');
  assert.equal(valorDoAmbiente({}, 'SMTP_URL'), undefined);
  const { garantirRoot } = await import('../src/bootstrap.js');
  await q(`delete from sessoes`); await q(`delete from usuarios`);
  const r = await garantirRoot({ q, bcrypt: bcryptFalso, env: { ROOT_PASSWORD: 'Senha-Boa-123' }, log: silencioso });
  assert.equal(r.acao, 'criado');
  assert.equal((await q(`select email::text e from usuarios where papel_app='root'`)).rows[0].e, 'root@m3d.pro');
});
