// E2E: detecção automática celular/desktop/relógio e o relógio de bolso discreto (versão mini).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { iniciar } from './servidor-http.mjs';

const NPM = process.env.NPM_TOOLS || '/opt/npm-tools/node_modules';
const req = createRequire(`${NPM}/x.js`);
const esbuild = req('esbuild'); const { chromium } = req('playwright');
const aqui = fileURLToPath(new URL('.', import.meta.url));
const web = join(aqui, '../../../web'); const watch = join(aqui, '../../../watch');
const saida = process.env.SAIDA || join(aqui, 'capturas'); const pub = join(saida, 'pub3');
mkdirSync(pub, { recursive: true });
writeFileSync(join(saida, 'stub-io3.js'), 'export const io = () => ({ emit() {}, on() {}, disconnect() {} });');
writeFileSync(join(saida, 'stub-video3.js'), "export async function criarSalaVideo() { return { modo: 'demo', pode: {} }; }");
await esbuild.build({ entryPoints: [join(web, 'src/main.jsx')], bundle: true, outdir: pub, format: 'esm', target: 'es2022', logLevel: 'error', nodePaths: [NPM],
  alias: { 'socket.io-client': join(saida, 'stub-io3.js') }, plugins: [{ name: 'v', setup: (b) => b.onResolve({ filter: /\/video\.js$/ }, () => ({ path: join(saida, 'stub-video3.js') })) }],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'css' } });
writeFileSync(join(pub, 'index.html'), '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revalida</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
cpSync(watch, join(pub, 'watch'), { recursive: true, filter: (s) => !/test|package\.json/.test(s) });

const srv = await iniciar({ pastaWeb: pub });
const nav = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const falhas = [];
const passo = async (n, fn) => { try { await fn(); console.log('✔', n); } catch (e) { falhas.push(n); console.log('✘', n, '\n   ', e.message.split('\n')[0]); } };
const abrir = async ({ w, h, ua, prefs = {} }) => {
  const c = await nav.newContext({ viewport: { width: w, height: h }, ...(ua ? { userAgent: ua } : {}) });
  await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await c.addInitScript((p) => { for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v); }, prefs);
  const p = await c.newPage(); p.on('pageerror', (e) => falhas.push(`erro de página: ${e.message}`));
  await p.goto(srv.url); return p;
};
try {
  await passo('computador: identifica desktop com layout largo; relógio de bolso discreto no canto superior direito', async () => {
    const p = await abrir({ w: 1280, h: 800 });
    await p.waitForSelector('.rel-bolso');
    assert.deepEqual(await p.evaluate(() => [document.documentElement.dataset.dispositivo, document.documentElement.dataset.layout]), ['desktop', 'largo']);
    const c = await p.locator('.rel-bolso').boundingBox();
    assert.ok(c.width <= 40 && c.x > 1280 - 60 && c.y < 30, 'pequeno e no canto');
    await p.screenshot({ path: join(saida, '30-desktop-icone.png') });
  });
  await passo('celular: identifica celular, layout estreito, SEM ícone de trocar de versão', async () => {
    const p = await abrir({ w: 390, h: 844, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    await p.waitForSelector('.tela');
    assert.deepEqual(await p.evaluate(() => [document.documentElement.dataset.dispositivo, document.documentElement.dataset.layout]), ['celular', 'estreito']);
    assert.equal(await p.locator('.rel-bolso').count(), 0, 'trocar de versão só existe no desktop');
    await p.screenshot({ path: join(saida, '32-celular-icone.png') });
  });
  await passo('celular deitado (915 px) continua celular: não ganha o layout de computador', async () => {
    const p = await abrir({ w: 915, h: 412, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36' });
    await p.waitForSelector('.tela');
    assert.deepEqual(await p.evaluate(() => [document.documentElement.dataset.dispositivo, document.documentElement.dataset.layout]), ['celular', 'estreito']);
    assert.equal(await p.locator('.rel-bolso').count(), 0);
    assert.notEqual(await p.evaluate(() => getComputedStyle(document.querySelector('.app')).display), 'grid');
  });
  await passo('tocar no relógio de bolso abre a versão mini (/watch/) já com a sessão', async () => {
    const tk = srv.assinar({ id: (await srv.q(`select id from usuarios where email='ana@x.com'`)).rows[0].id, papel_app: 'usuario', sessao_versao: 0 });
    const p = await abrir({ w: 1280, h: 800, prefs: { 'rp-auth': JSON.stringify({ token: tk, usuario: { nome: 'Ana Souza', papel_app: 'usuario' } }) } });
    await p.waitForSelector('.rel-bolso'); await p.click('.rel-bolso');
    await p.waitForURL('**/watch/');
    assert.equal(await p.evaluate(() => localStorage.getItem('rv-modo')), 'relogio');
    assert.equal(await p.evaluate(() => localStorage.getItem('rv-watch')), tk);
    await p.waitForSelector('h1, .erro, button');
    assert.equal(await p.locator('#e').count(), 0, 'não pede login de novo');
    await p.screenshot({ path: join(saida, '31-mini-aberta.png') });
  });
  await passo('celular com "relogio" guardado de outro contexto NÃO é redirecionado (a escolha é só do desktop)', async () => {
    const p = await abrir({ w: 390, h: 844, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', prefs: { 'rv-modo': 'relogio' } });
    await p.waitForSelector('.tela'); assert.equal(new URL(p.url()).pathname, '/');
  });
  await passo('relógio (tela pequena): vai sozinho para a versão relógio', async () => {
    const p = await abrir({ w: 240, h: 240 });
    await p.waitForURL('**/watch/'); await p.waitForSelector('#e');
    await p.screenshot({ path: join(saida, '33-relogio-automatico.png') });
  });
  await passo('relógio por user-agent (Wear OS) também é reconhecido', async () => {
    const p = await abrir({ w: 396, h: 396, ua: 'Mozilla/5.0 (Linux; Android 13; Wear OS 4; Pixel Watch 2) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' });
    await p.waitForURL('**/watch/');
  });
  await passo('quem escolheu o app completo no relógio não é redirecionado', async () => {
    const p = await abrir({ w: 240, h: 240, prefs: { 'rv-modo': 'completo' } });
    await p.waitForSelector('.tela'); assert.equal(new URL(p.url()).pathname, '/');
  });
} finally { await nav.close(); srv.fechar(); }
if (falhas.length) { console.log(falhas); process.exit(1); }
console.log('\nTodos os passos passaram.');
