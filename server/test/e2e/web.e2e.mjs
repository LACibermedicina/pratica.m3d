// Teste ponta a ponta: navegador real (Chromium) → front React → HTTP → rotas reais → Postgres real.
// Precisa de esbuild, playwright e react/react-dom (veja NPM_TOOLS). Saída: capturas de tela em ./capturas.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { iniciar } from './servidor-http.mjs';

const NPM = process.env.NPM_TOOLS || '/opt/npm-tools/node_modules';
const req = createRequire(`${NPM}/x.js`);
const esbuild = req('esbuild');
const { chromium } = req('playwright');
const aqui = fileURLToPath(new URL('.', import.meta.url));
const web = join(aqui, '../../../web');
const saida = process.env.SAIDA || join(aqui, 'capturas');
const pub = join(saida, 'pub');
mkdirSync(pub, { recursive: true });

// 1) compila o front (socket.io e Agora trocados por stubs: aqui não há sala ao vivo)
writeFileSync(join(saida, 'stub-io.js'), 'export const io = () => ({ emit() {}, on() {}, disconnect() {} });');
writeFileSync(join(saida, 'stub-video.js'), "export async function criarSalaVideo() { return { modo: 'demo' }; }");
await esbuild.build({
  entryPoints: [join(web, 'src/main.jsx')], bundle: true, outdir: pub, format: 'esm', target: 'es2022', logLevel: 'error',
  nodePaths: [NPM], alias: { 'socket.io-client': join(saida, 'stub-io.js') },
  plugins: [{ name: 'video', setup: (b) => b.onResolve({ filter: /\/video\.js$/ }, () => ({ path: join(saida, 'stub-video.js') })) }],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'css' },
});
writeFileSync(join(pub, 'index.html'), '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revalida Prático</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');

const srv = await iniciar({ pastaWeb: pub });
const nav = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const falhas = [];
const passo = async (nome, fn) => { try { await fn(); console.log('✔', nome); } catch (e) { falhas.push(nome); console.log('✘', nome, '\n   ', e.message.split('\n')[0]); } };
const nova = async (w = 420, h = 900) => { const c = await nav.newContext({ viewport: { width: w, height: h }, colorScheme: 'light' }); const p = await c.newPage(); p.on('pageerror', (e) => falhas.push(`erro de página: ${e.message}`)); return p; };
const foto = async (p, nome) => { await p.waitForTimeout(1000); return p.screenshot({ path: join(saida, `${nome}.png`) }); };

try {
  const p = await nova();
  await p.goto(srv.url);

  await passo('login do root com root@m3d.pro / arcano123 mostra aviso de senha provisória', async () => {
    await foto(p, '01-entrar');
    await p.fill('#e-email', 'root@m3d.pro'); await p.fill('#e-senha', 'arcano123'); await p.click('button.btn:has-text("Entrar")');
    await p.waitForSelector('.faixa');
    assert.match(await p.textContent('.faixa'), /provisória/);
    await foto(p, '02-painel-root');
  });

  await passo('root vê Admin; pedidos pendentes; aprovar mostra o token uma vez', async () => {
    await p.click('nav >> text=Admin');
    await p.waitForSelector('text=Rafael Lima');
    await foto(p, '03-admin-pedidos');
    await p.click('button:has-text("Aprovar")');
    await p.waitForSelector('code.segredo');
    const tok = await p.textContent('code.segredo');
    assert.match(tok, /^[0-9a-f]{32}$/);
    assert.equal(srv.emails.at(-1).para, 'rafael@ex.com');
    await foto(p, '04-admin-token');
    await p.click('button:has-text("Fechar")');
    assert.equal(await p.locator('code.segredo').count(), 0);
  });

  await passo('root cria token de vários usos; admin comum não veria o campo (aqui: root vê)', async () => {
    await p.click('[role=tab]:has-text("Tokens")');
    await p.waitForSelector('text=Novo token');
    assert.equal(await p.locator('input[aria-label="Usos"]').count(), 1);
    await p.fill('input[aria-label="Usos"]', '5');
    await p.click('button:has-text("Criar token")');
    await p.waitForSelector('code.segredo');
    await p.click('button:has-text("Fechar")');
    await p.waitForSelector('text=/5 usos|0\\/5/');
  });

  await passo('root gera link de senha para a Ana; promover/rebaixar disponível; root e si mesmo intocáveis', async () => {
    await p.click('[role=tab]:has-text("Usuários")');
    await p.waitForSelector('text=Ana Souza');
    await foto(p, '05-admin-usuarios');
    const cartaoRoot = p.locator('.item-adm', { hasText: 'root@m3d.pro' });
    assert.equal(await cartaoRoot.locator('button').count(), 0);
    const cartaoAna = p.locator('.item-adm', { hasText: 'ana@x.com' });
    assert.equal(await cartaoAna.locator('select[aria-label="Papel"]').count(), 1);
    await cartaoAna.locator('button:has-text("Link de senha")').click();
    await p.waitForSelector('code.segredo');
    assert.match(await p.textContent('code.segredo'), /^http:\/\/localhost\/#\/redefinir\/[0-9a-f]{64}$/);
    await p.click('button:has-text("Fechar")');
  });

  await passo('root troca a senha provisória: faixa some e a senha nova passa a valer', async () => {
    await p.click('nav >> text=Conta');
    await p.fill('#cs-atual', 'arcano123'); await p.fill('#cs-nova', 'RootForte-2026');
    await p.click('button:has-text("Trocar senha")');
    await p.waitForSelector('text=Senha trocada');
    assert.equal(await p.locator('.faixa').count(), 0);
    await foto(p, '06-conta');
  });

  const ana = await nova();
  await ana.goto(srv.url);

  await passo('Esqueci minha senha: mensagem igual para e-mail existente e inexistente', async () => {
    await ana.click('text=Esqueci minha senha');
    await ana.fill('#rc-email', 'fantasma@x.com'); await ana.click('button:has-text("Enviar link")');
    await ana.waitForSelector('.msg:has-text("Se houver uma conta")');
    const m1 = await ana.textContent('.msg');
    await ana.fill('#rc-email', 'ana@x.com'); await ana.click('button:has-text("Enviar link")');
    await ana.waitForFunction(() => document.querySelector('.msg')?.textContent.includes('Se houver'));
    assert.equal(await ana.textContent('.msg'), m1);
    await foto(ana, '07-recuperar');
    const ult = srv.emails.filter((m) => m.para === 'ana@x.com').at(-1);
    assert.ok(ult, 'e-mail para ana');
    assert.equal(srv.emails.filter((m) => m.para === 'fantasma@x.com').length, 0);
  });

  await passo('link do e-mail abre a tela de nova senha; senha fraca é barrada; senha boa conclui e o token some da URL', async () => {
    const texto = srv.emails.filter((m) => m.para === 'ana@x.com').at(-1).texto;
    const link = texto.match(/http:\/\/localhost(\/#\/redefinir\/[0-9a-f]{64})/)[1];
    await ana.goto(srv.url + link);
    await ana.waitForSelector('#rd-senha');
    assert.ok(!ana.url().includes('redefinir'), 'o token sai da barra de endereço');
    await foto(ana, '08-redefinir');
    await ana.fill('#rd-senha', 'curta1'); await ana.fill('#rd-conf', 'curta1'); await ana.click('button:has-text("Salvar nova senha")');
    await ana.waitForSelector('.msg.e:has-text("regras")');
    await ana.fill('#rd-senha', 'NovaDaAna-2026'); await ana.fill('#rd-conf', 'outra-coisa-9'); await ana.click('button:has-text("Salvar nova senha")');
    await ana.waitForSelector('.msg.e:has-text("não são iguais")');
    await ana.fill('#rd-conf', 'NovaDaAna-2026'); await ana.click('button:has-text("Salvar nova senha")');
    await ana.waitForSelector('#e-email');
    assert.match(await ana.textContent('.msg'), /Senha alterada/);
  });

  await passo('senha antiga não entra; a nova entra', async () => {
    await ana.fill('#e-email', 'ana@x.com'); await ana.fill('#e-senha', 'senhaforte123'); await ana.click('button.btn:has-text("Entrar")');
    await ana.waitForSelector('.msg.e:has-text("incorretos")');
    await ana.fill('#e-senha', 'NovaDaAna-2026'); await ana.click('button.btn:has-text("Entrar")');
    await ana.waitForSelector('nav');
    assert.equal(await ana.locator('nav >> text=Admin').count(), 0, 'usuária comum não vê Admin');
  });

  await passo('link já usado não vale de novo', async () => {
    const texto = srv.emails.filter((m) => m.para === 'ana@x.com').at(-1).texto;
    const link = texto.match(/http:\/\/localhost(\/#\/redefinir\/[0-9a-f]{64})/)[1];
    const outra = await nova();
    await outra.goto(srv.url + link);
    await outra.waitForSelector('#rd-senha');
    await outra.fill('#rd-senha', 'MaisUmaSenha-2026'); await outra.fill('#rd-conf', 'MaisUmaSenha-2026'); await outra.click('button:has-text("Salvar nova senha")');
    await outra.waitForSelector('.msg.e:has-text("Link inválido")');
  });

  await passo('root bloqueia a Ana: na próxima ação dela o app volta ao login com aviso', async () => {
    await p.click('nav >> text=Admin'); await p.click('[role=tab]:has-text("Usuários")');
    await p.locator('.item-adm', { hasText: 'ana@x.com' }).locator('button:has-text("Bloquear")').click();
    await p.waitForSelector('.item-adm:has-text("ana@x.com") .tag:has-text("bloqueado")');
    await ana.click('nav >> text=Conta');
    await ana.fill('#cs-atual', 'x'); await ana.fill('#cs-nova', 'QualquerSenha-2026'); await ana.click('button:has-text("Trocar senha")');
    await ana.waitForSelector('#e-email');
    assert.match(await ana.textContent('.msg'), /sessão terminou/);
  });

  await passo('moderadora vê só Estações e consegue aprovar; sem abas de pedidos/usuários', async () => {
    const m = await nova();
    await m.goto(srv.url);
    await m.fill('#e-email', 'moda@x.com'); await m.fill('#e-senha', 'senhaforte123'); await m.click('button.btn:has-text("Entrar")');
    await m.click('nav >> text=Admin');
    await m.waitForSelector('text=Dor torácica na UBS');
    assert.deepEqual(await m.locator('[role=tab]').allTextContents(), ['Estações']);
    await foto(m, '09-moderadora');
    await m.click('button:has-text("Aprovar")');
    await m.waitForSelector('text=Nenhuma estação aguardando revisão');
  });

  await passo('registro de auditoria lista as ações do root', async () => {
    await p.click('[role=tab]:has-text("Registro")');
    await p.waitForSelector('text=/pedido aprovado/');
    await foto(p, '10-registro');
  });
  await passo('versão web: em tela larga o menu vira barra lateral e o painel usa duas colunas', async () => {
    const w = await nova(1366, 800);
    await w.goto(srv.url);
    await w.fill('#e-email', 'moda@x.com'); await w.fill('#e-senha', 'senhaforte123'); await w.click('button.btn:has-text("Entrar")');
    await w.waitForSelector('nav');
    await w.waitForSelector('.tela.painel .col');
    const caixa = async (sel) => w.locator(sel).first().boundingBox();
    const nav = await caixa('nav'); const tela = await caixa('.tela');
    assert.ok(nav.width < 260 && nav.x < tela.x, 'menu à esquerda');
    const [c1, c2] = [await w.locator('.tela.painel .col').nth(0).boundingBox(), await w.locator('.tela.painel .col').nth(1).boundingBox()];
    assert.ok(c2.x > c1.x + c1.width - 5 && Math.abs(c1.y - c2.y) < 4, 'duas colunas lado a lado');
    assert.ok(await w.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sem rolagem horizontal');
    await foto(w, '11-web-painel');
    await w.click('nav >> text=Admin');
    await w.waitForSelector('[role=tab]:has-text("Estações")'); await w.waitForTimeout(300);
    await foto(w, '12-web-admin');
    const sair = await w.locator('nav button:has-text("Sair")').boundingBox();
    assert.ok(sair.y > 500, 'Sair no rodapé do menu');
    const l = await nova(1366, 800); await l.goto(srv.url); await l.waitForSelector('#e-email');
    await foto(l, '13-web-entrar');
    const cel = await nova(390, 800); await cel.goto(srv.url); await cel.waitForSelector('#e-email');
    assert.ok(await cel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'celular sem rolagem horizontal');
  });
} finally {
  await nav.close(); srv.fechar();
}
console.log(falhas.length ? `\nFALHAS: ${falhas.length}\n${falhas.join('\n')}` : '\nTudo certo.');
process.exit(falhas.length ? 1 : 0);
