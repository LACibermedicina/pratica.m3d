// E2E: instalador do primeiro acesso + vídeo/áudio da sala. Chromium real → front React → HTTP → rotas reais → Postgres real.
// Agora e Socket.IO são substituídos por stubs: o stub de vídeo pede o token à rota REAL (regras de papel e áudio vêm do servidor),
// e o stub de Socket.IO repassa os eventos que o servidor emitiu. Vídeo ao vivo de verdade não é testável aqui.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { iniciar, CODIGO_INSTALACAO } from './servidor-http.mjs';

const NPM = process.env.NPM_TOOLS || '/opt/npm-tools/node_modules';
const req = createRequire(`${NPM}/x.js`);
const esbuild = req('esbuild');
const { chromium } = req('playwright');
const aqui = fileURLToPath(new URL('.', import.meta.url));
const web = join(aqui, '../../../web');
const saida = process.env.SAIDA || join(aqui, 'capturas');
const pub = join(saida, 'pub2');
mkdirSync(pub, { recursive: true });

writeFileSync(join(saida, 'stub-io2.js'), `
export const io = () => {
  const ouvintes = {}; let desde = 0; let sala = null; let ocupado = false;
  const t = setInterval(async () => {
    if (!sala || ocupado) return; ocupado = true;
    let ev = []; try { ev = await (await fetch('/__eventos?desde=' + desde)).json(); } catch { ocupado = false; return; } desde += ev.length; ocupado = false;
    ev.filter((e) => e.sala === sala).forEach((e) => (ouvintes[e.evento] || []).forEach((f) => f(e.dados)));
  }, 150);
  return { emit(n, d) { if (n === 'sala:entrar') sala = d.sessaoId; }, on(n, f) { (ouvintes[n] ||= []).push(f); }, disconnect() { clearInterval(t); } };
};`);
writeFileSync(join(saida, 'stub-video2.js'), `
export async function criarSalaVideo({ sessaoId, tokenAuth }) {
  const ler = async () => { const r = await fetch('/api/sessoes/' + sessaoId + '/agora-token', { headers: { Authorization: 'Bearer ' + tokenAuth } }); if (!r.ok) throw new Error('sem acesso'); return r.json(); };
  let d = await ler();
  window.__tokens = (window.__tokens || []); window.__tokens.push(d);
  return { modo: 'demo', papel: d.papel, get pode() { return d.pode; }, async sincronizar() { d = await ler(); window.__tokens.push(d); return d.pode; }, retomarSom() {}, cameraLigada: () => false, microfoneLigado: () => false, async sair() {} };
}`);
await esbuild.build({
  entryPoints: [join(web, 'src/main.jsx')], bundle: true, outdir: pub, format: 'esm', target: 'es2022', logLevel: 'error',
  nodePaths: [NPM], alias: { 'socket.io-client': join(saida, 'stub-io2.js') },
  plugins: [{ name: 'video', setup: (b) => b.onResolve({ filter: /\/video\.js$/ }, () => ({ path: join(saida, 'stub-video2.js') })) }],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'css' },
});
writeFileSync(join(pub, 'index.html'), '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revalida Prático</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');

const nav = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const falhas = [];
const passo = async (nome, fn) => { try { await fn(); console.log('✔', nome); } catch (e) { falhas.push(nome); console.log('✘', nome, '\n   ', e.message.split('\n')[0]); } };
const nova = async (w = 420, h = 900, init) => {
  const c = await nav.newContext({ viewport: { width: w, height: h } });
  await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (init) await c.addInitScript((a) => localStorage.setItem('rp-auth', JSON.stringify(a)), init);
  const p = await c.newPage(); p.on('pageerror', (e) => falhas.push(`erro de página: ${e.message}`)); return p;
};
const foto = async (p, nome) => { await p.waitForTimeout(900); return p.screenshot({ path: join(saida, `${nome}.png`) }); };

/* ============================ A) INSTALADOR ============================ */
{
  const srv = await iniciar({ pastaWeb: pub, instalado: false, extras: false });
  try {
    const p = await nova();
    await p.goto(srv.url);
    await passo('servidor novo mostra o instalador no lugar do login', async () => {
      await p.waitForSelector('[data-passo="etapa-0"]');
      assert.equal(await p.locator('#e-email').count(), 0);
      await foto(p, '10-instalador-codigo');
    });
    await passo('código errado é recusado; nada é revelado', async () => {
      await p.fill('input[placeholder="XXXX-XXXX-XXXX"]', 'ERRO-ERRO-ERRO'); await p.click('button:has-text("Começar")');
      await p.waitForSelector('.msg.e');
      assert.match(await p.textContent('.msg.e'), /incorreto/);
    });
    await passo('código certo abre a verificação do servidor (banco, estrutura, segredo, e-mail, vídeo, HTTPS, tempo real)', async () => {
      await p.fill('input[placeholder="XXXX-XXXX-XXXX"]', CODIGO_INSTALACAO); await p.click('button:has-text("Começar")');
      await p.waitForSelector('[data-passo="etapa-1"] .verif li');
      const txt = await p.textContent('.verif');
      for (const t of ['Banco de dados', 'Estrutura do banco', 'Segredo das sessões', 'E-mail (SMTP)', 'Vídeo (Agora)', 'Conexão segura', 'Tempo real']) assert.match(txt, new RegExp(t.replace(/[()]/g, '\\$&')));
      assert.equal(await p.locator('.verif li.erro').count(), 0, 'sem erros num servidor saudável');
      assert.ok(await p.locator('.verif li.aviso').count() >= 2, 'e-mail e vídeo opcionais viram aviso');
      await foto(p, '11-instalador-verificacao');
    });
    await passo('parâmetros: salva endereço e credenciais Agora; o segredo some da tela e a verificação de vídeo passa', async () => {
      await p.click('button:has-text("Continuar")');
      await p.waitForSelector('[data-passo="etapa-2"]');
      await p.fill('label:has-text("Endereço público") input', 'https://revalida.exemplo.com');
      await p.fill('label:has-text("App ID") input', 'a'.repeat(32));
      await p.fill('label:has-text("Certificado") input', 'b'.repeat(32));
      await p.click('button:has-text("Salvar parâmetros")');
      await p.waitForSelector('.msg:has-text("Parâmetros salvos")');
      await p.waitForSelector('.verif li:has-text("Vídeo (Agora)") >> text=Credenciais aceitas');
      assert.equal(await p.inputValue('label:has-text("Certificado") input'), '');
      assert.ok(!(await p.content()).includes('b'.repeat(32)), 'segredo não fica no DOM');
      assert.equal(srv.cfg.obter('APP_URL'), 'https://revalida.exemplo.com');
      await foto(p, '12-instalador-parametros');
    });
    await passo('valor inválido é barrado com mensagem', async () => {
      await p.fill('label:has-text("App ID") input', 'curto');
      await p.click('button:has-text("Salvar parâmetros")');
      await p.waitForSelector('.msg.e:has-text("inválido")');
      await p.fill('label:has-text("App ID") input', 'a'.repeat(32));
    });
    await passo('administradores: senha fraca barrada; define a senha raiz e cria um administrador', async () => {
      await p.click('button:has-text("Continuar")');
      await p.waitForSelector('[data-passo="etapa-3"]');
      await p.fill('label:has-text("Nova senha da conta raiz") input', 'semnumeroaqui');
      await p.click('button:has-text("Definir senha raiz")');
      await p.waitForSelector('.msg.e:has-text("senha precisa")');
      await p.fill('label:has-text("Nova senha da conta raiz") input', 'RaizForte2026');
      await p.click('button:has-text("Definir senha raiz")');
      await p.waitForSelector('.msg:has-text("raiz definida")');
      await p.fill('label:has-text("Nome") input', 'Dra. Helena');
      await p.locator('.cartao label:has-text("E-mail") input').last().fill('helena@clinica.com');
      await p.locator('.cartao label:has-text("Senha") input').last().fill('HelenaForte99');
      await p.click('button:has-text("Criar usuário")');
      await p.waitForSelector('.msg:has-text("Usuário criado")');
      assert.match(await p.textContent('.verif'), /helena@clinica\.com/);
      await foto(p, '13-instalador-admins');
    });
    await passo('conclui; instalador fica trancado; login com a senha nova funciona e a de exemplo não', async () => {
      await p.click('button:has-text("Continuar")');
      await p.waitForSelector('[data-passo="etapa-4"]');
      await p.click('button:has-text("Concluir instalação")');
      await p.waitForSelector('[data-passo="instalado"]');
      await foto(p, '14-instalador-pronto');
      await p.click('button:has-text("Ir para o login")');
      await p.waitForSelector('#e-email');
      const estado = await (await fetch(`${srv.url}/api/instalacao/estado`)).json();
      assert.equal(estado.instalado, true);
      const r = await fetch(`${srv.url}/api/instalacao/verificar`, { method: 'POST', headers: { 'x-codigo-instalacao': CODIGO_INSTALACAO, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403);
      await p.fill('#e-email', 'root@m3d.pro'); await p.fill('#e-senha', 'arcano123'); await p.click('button.btn:has-text("Entrar")');
      await p.waitForSelector('.msg.e');
      await p.fill('#e-senha', 'RaizForte2026'); await p.click('button.btn:has-text("Entrar")');
      await p.waitForSelector('nav >> text=Admin');
      assert.equal(await p.locator('.faixa').count(), 0, 'sem aviso de senha provisória');
    });
    await passo('recarregar a página não reabre o instalador', async () => {
      await p.reload(); await p.waitForSelector('nav, #e-email');
      assert.equal(await p.locator('[data-passo^="etapa"]').count(), 0);
    });
  } finally { srv.fechar(); }
}

/* ============================ B) SALA: vídeo e áudio ============================ */
{
  const srv = await iniciar({ pastaWeb: pub, instalado: true, extras: false, agoraAtivo: true });
  try {
    const ids = {};
    for (const [k, nome] of [['chefe', 'Chefe Silva'], ['cand', 'Cris Cand'], ['obs', 'Olga Obs']]) {
      await srv.mkUser(nome, `${k}@x.com`, 'senhaforte123');
      ids[k] = (await srv.q(`select id from usuarios where email='${k}@x.com'`)).rows[0].id;
    }
    const est = (await srv.q(`insert into estacoes (titulo, area, status, duracao_min) values ('Dor torácica','clinica_medica','aprovada',10) returning id`)).rows[0].id;
    const sid = (await srv.q(`insert into sessoes (estacao_id, dono_id) values ('${est}','${ids.chefe}') returning id`)).rows[0].id;
    const auth = (k, nome) => ({ token: srv.assinar({ id: ids[k], papel_app: 'usuario', sessao_versao: 0 }), usuario: { id: ids[k], nome, papel_app: 'usuario' } });
    const entrar = async (p, papelRotulo) => {
      await p.goto(srv.url); await p.waitForSelector('input[placeholder="código ou link da sala"]');
      await p.fill('input[placeholder="código ou link da sala"]', sid);
      await p.click(`.seg button:has-text("${papelRotulo}")`); await p.click('button:has-text("Entrar"):not(.menta)');
      await p.waitForSelector('.videos');
    };
    const chefe = await nova(1100, 1000, auth('chefe', 'Chefe Silva'));
    const cand = await nova(420, 900, auth('cand', 'Cris Cand'));
    const obs = await nova(420, 1000, auth('obs', 'Olga Obs'));
    await entrar(chefe, 'Avaliar'); await entrar(cand, 'Ser candidato'); await entrar(obs, 'Observar');

    await passo('o vídeo já está aberto na sala antes de iniciar a estação (sem clique extra), para todos', async () => {
      for (const p of [chefe, cand, obs]) {
        assert.equal(await p.locator('.videos .tile').count() > 0, true);
        assert.match(await p.textContent('[role=timer]'), /Pronto para começar/);
        assert.equal(await p.locator('.midia button:has-text("câmera")').count(), 1, 'botão de câmera disponível para todos');
      }
      await foto(chefe, '20-sala-chefe');
    });
    await passo('token do servidor: observador sem áudio; candidato e chefe com áudio; todos com vídeo', async () => {
      const t = async (p) => (await p.evaluate(() => window.__tokens.at(-1)));
      const [c, ca, o] = [await t(chefe), await t(cand), await t(obs)];
      assert.deepEqual([c.pode.audio, ca.pode.audio, o.pode.audio], [true, true, false]);
      assert.deepEqual([c.pode.video, ca.pode.video, o.pode.video], [true, true, true]);
      assert.equal(o.token.startsWith('007M'), true, 'token do observador emitido sem privilégio de áudio');
      assert.equal(c.token.startsWith('007A'), true);
    });
    await passo('por padrão o observador NÃO tem microfone: botão bloqueado e aviso explicando', async () => {
      const b = obs.locator('.midia button:has-text("Áudio liberado só pelo chefe")');
      assert.equal(await b.count(), 1); assert.equal(await b.isDisabled(), true);
      assert.equal(await obs.locator('.midia button:has-text("microfone"), .midia button:has-text("Microfone")').count(), 0);
      assert.equal(await cand.locator('.midia button:has-text("Microfone")').count(), 1, 'candidato tem microfone');
      assert.equal(await chefe.locator('.chave-audio input').isChecked(), false, 'chave do chefe começa desligada');
      assert.equal(await cand.locator('.chave-audio').count(), 0, 'só o chefe vê a chave');
      assert.equal(await obs.locator('.chave-audio').count(), 0);
      await foto(obs, '21-sala-observador-sem-audio');
    });
    await passo('observador pode abrir a própria câmera mesmo sem áudio', async () => {
      await obs.click('.midia button:has-text("Abrir câmera")');
      await obs.waitForSelector('.midia button:has-text("Fechar câmera")');
    });
    await passo('chefe libera o áudio: servidor grava, observador recebe o evento e ganha microfone', async () => {
      await chefe.check('.chave-audio input');
      await obs.waitForSelector('.midia button:has-text("Microfone")', { timeout: 5000 });
      assert.equal((await srv.q(`select audio_observadores a from sessoes where id='${sid}'`)).rows[0].a, true);
      const o = await obs.evaluate(() => window.__tokens.at(-1));
      assert.equal(o.pode.audio, true); assert.equal(o.token.startsWith('007A'), true);
      await foto(obs, '22-sala-observador-com-audio');
    });
    await passo('chefe revoga: o microfone do observador some e o novo token vem sem áudio', async () => {
      await chefe.uncheck('.chave-audio input');
      await obs.waitForSelector('.midia button:has-text("Áudio liberado só pelo chefe")', { timeout: 5000 });
      assert.equal((await srv.q(`select audio_observadores a from sessoes where id='${sid}'`)).rows[0].a, false);
      assert.equal((await obs.evaluate(() => window.__tokens.at(-1))).token.startsWith('007M'), true);
    });
    await passo('observador não consegue liberar o próprio áudio pela API', async () => {
      const r = await obs.evaluate(async (a) => (await fetch(`/api/sessoes/${a.sid}/audio-observadores`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.t}` }, body: '{"liberado":true}' })).status, { sid, t: auth('obs', 'x').token });
      assert.equal(r, 403);
      assert.equal((await srv.q(`select audio_observadores a from sessoes where id='${sid}'`)).rows[0].a, false);
    });
  } finally { srv.fechar(); }
}

await nav.close();
if (falhas.length) { console.log(`\n${falhas.length} falha(s):`, falhas); process.exit(1); }
console.log('\nTodos os passos passaram.');
