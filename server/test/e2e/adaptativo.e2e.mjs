// E2E: tela de carregamento com % real e layout adaptativo (nada some/estoura) em vários aparelhos. Usa o index.html REAL.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { iniciar } from './servidor-http.mjs';

const NPM = process.env.NPM_TOOLS || '/opt/npm-tools/node_modules';
const req = createRequire(`${NPM}/x.js`);
const esbuild = req('esbuild'); const { chromium } = req('playwright');
const aqui = fileURLToPath(new URL('.', import.meta.url));
const web = join(aqui, '../../../web');
const saida = process.env.SAIDA || join(aqui, 'capturas'); const pub = join(saida, 'pub5');
mkdirSync(pub, { recursive: true });
writeFileSync(join(saida, 'stub-io5.js'), 'export const io = () => ({ emit() {}, on() {}, disconnect() {} });');
writeFileSync(join(saida, 'stub-video5.js'), "export async function criarSalaVideo() { return { modo: 'demo', pode: {} }; }");
await esbuild.build({ entryPoints: [join(web, 'src/main.jsx')], bundle: true, outdir: pub, format: 'esm', target: 'es2022', logLevel: 'error', nodePaths: [NPM],
  alias: { 'socket.io-client': join(saida, 'stub-io5.js') }, plugins: [{ name: 'v', setup: (b) => b.onResolve({ filter: /\/video\.js$/ }, () => ({ path: join(saida, 'stub-video5.js') })) }],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'css' } });
// index.html REAL do projeto, apontando para o bundle compilado (como o Vite faz no build)
writeFileSync(join(pub, 'index.html'), readFileSync(join(web, 'index.html'), 'utf8')
  .replace('<script type="module" src="/src/main.jsx"', '<script type="module" src="/main.js"').replace('</head>', '<link rel="stylesheet" href="/main.css">\n</head>'));

const srv = await iniciar({ pastaWeb: pub });
const nav = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const falhas = [];
const passo = async (n, fn) => { try { await fn(); console.log('✔', n); } catch (e) { falhas.push(n); console.log('✘', n, '\n   ', e.message.split('\n')[0]); } };
const nova = async ({ w, h, ua, esquema = 'light', prefs = {}, atraso = 0, atrasoApi = 0, bloquearJs = false }) => {
  const c = await nav.newContext({ viewport: { width: w, height: h }, colorScheme: esquema, ...(ua ? { userAgent: ua, hasTouch: /Mobile|iPad/.test(ua), isMobile: /Mobile/.test(ua) } : {}) });
  await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (atraso) await c.route('**/main.js', async (r) => { await new Promise((ok) => setTimeout(ok, atraso)); r.continue(); });
  if (bloquearJs) await c.route('**/main.js', (r) => r.abort());
  if (atrasoApi) await c.route('**/api/instalacao/estado', async (r) => { await new Promise((ok) => setTimeout(ok, atrasoApi)); r.continue(); });
  await c.addInitScript((p) => { for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v); }, prefs);
  const p = await c.newPage(); p.on('pageerror', (e) => falhas.push(`erro de página: ${e.message}`)); return p;
};

await passo('carregamento: % real sobe sem voltar, o app fica escondido até o fim, some em 100%', async () => {
  const p = await nova({ w: 1280, h: 800, atraso: 1500, atrasoApi: 900 });
  const amostras = []; let escondido = true; let vistoNaTela = false;
  const ir = p.goto(srv.url, { waitUntil: 'commit' });
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const s = await p.evaluate(() => { const b = document.getElementById('boot'); return b ? { v: window.__boot?.progresso?.() ?? 0, n: Number(document.getElementById('boot-n')?.textContent), rootVis: getComputedStyle(document.getElementById('root')).visibility, txt: document.getElementById('boot-s').textContent } : null; }).catch(() => undefined);
    if (s === null) break;
    if (s) { amostras.push(s); if (s.rootVis !== 'hidden' && s.n < 100) escondido = false; if (s.n > 0 && s.n < 100) vistoNaTela = true; }
    await p.waitForTimeout(100);
  }
  await ir;
  assert.ok(amostras.length > 8, 'amostrou o carregamento');
  for (let i = 1; i < amostras.length; i++) assert.ok(amostras[i].n >= amostras[i - 1].n, `nunca volta (${amostras[i - 1].n} → ${amostras[i].n})`);
  assert.ok(vistoNaTela, 'mostrou valores intermediários');
  assert.equal(escondido, true, `o app ficou invisível enquanto carregava: ${JSON.stringify(amostras.find((a) => a.rootVis !== 'hidden'))}`);
  assert.ok(new Set(amostras.map((a) => a.txt)).size >= 2, 'mensagens de etapa mudam');
  assert.ok(amostras.at(-1).n >= 90, 'chegou perto de 100 antes de sair');
  await p.waitForSelector('#e-email'); await p.waitForTimeout(500);
  assert.equal(await p.locator('#boot').count(), 0, 'splash removida');
  assert.equal(await p.evaluate(() => document.documentElement.classList.contains('carregando')), false);
  assert.equal(await p.locator('.tela').isVisible(), true);
});
await passo('carregamento em modo escuro usa o tema escuro', async () => {
  const p = await nova({ w: 390, h: 800, esquema: 'dark', atraso: 1200 });
  await p.goto(srv.url, { waitUntil: 'commit' }); await p.waitForSelector('#boot');
  const bg = await p.evaluate(() => getComputedStyle(document.getElementById('boot')).backgroundColor);
  assert.equal(bg, 'rgb(15, 23, 38)');
  await p.screenshot({ path: join(saida, '50-carregando-escuro.png') });
});
await passo('carregamento: foto no celular em andamento', async () => {
  const p = await nova({ w: 390, h: 800, atraso: 1800 });
  await p.goto(srv.url, { waitUntil: 'commit' }); await p.waitForSelector('#boot'); await p.waitForTimeout(900);
  const n = Number(await p.textContent('#boot-n')); assert.ok(n > 5 && n < 100, `em andamento (${n}%)`);
  await p.screenshot({ path: join(saida, '51-carregando-celular.png') });
});
await passo('falha ao baixar o app: aviso com botão (nunca tela em branco)', async () => {
  const p = await nova({ w: 390, h: 800, bloquearJs: true });
  await p.goto(srv.url); await p.waitForSelector('#boot.erro button', { timeout: 8000 });
  const t = await p.textContent('#boot-s'); assert.match(t, /baixar|falhou/, `texto: ${t}`);
});

/* ------------ layout adaptativo: o quadro do app cabe SEMPRE na área visível ------------ */
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const CASOS = [
  ['celular pequeno 320x480', 320, 480, IPHONE], ['Android 360x640', 360, 640, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'],
  ['iPhone 390x844', 390, 844, IPHONE], ['celular deitado 844x390', 844, 390, IPHONE], ['celular deitado curto 568x320', 568, 320, IPHONE],
  ['iPad 768x1024', 768, 1024, IPAD], ['iPad deitado 1024x768', 1024, 768, IPAD],
  ['janela estreita 700x600', 700, 600], ['notebook 1280x720', 1280, 720], ['monitor 1920x1080', 1920, 1080], ['janela baixa 1100x450', 1100, 450],
];
for (const [nome, w, h, ua] of CASOS) {
  await passo(`layout ${nome}: quadro dentro da tela, sem rolagem lateral, botão Entrar alcançável`, async () => {
    const p = await nova({ w, h, ua });
    await p.goto(srv.url); await p.waitForSelector('#e-email'); await p.waitForTimeout(700);
    const r = await p.evaluate(() => { const a = document.querySelector('.app').getBoundingClientRect(); const d = document.scrollingElement; return { l: a.left, t: a.top, r: a.right, b: a.bottom, sw: d.scrollWidth, sh: d.scrollHeight, perfil: document.documentElement.dataset.perfil }; });
    assert.ok(r.l >= -0.5 && r.t >= -0.5 && r.r <= w + 0.5 && r.b <= h + 0.5, `app ${JSON.stringify(r)} fora de ${w}x${h}`);
    assert.ok(r.sw <= w, 'sem rolagem lateral'); assert.ok(r.sh <= h + 1, 'a página não rola: quem rola é a tela interna');
    await p.locator('button.btn:has-text("Entrar")').scrollIntoViewIfNeeded();
    const b = await p.locator('button.btn:has-text("Entrar")').boundingBox();
    assert.ok(b && b.y >= 0 && b.y + b.height <= h + 1 && b.x >= 0 && b.x + b.width <= w + 1, 'botão visível');
    await p.screenshot({ path: join(saida, `6-${nome.replace(/[^a-z0-9]+/gi, '-')}.png`) });
  });
}
await passo('painel logado em tela curta: menu inferior visível e dados falhando não travam a tela de carregamento', async () => {
  const tk = srv.assinar({ id: (await srv.q(`select id from usuarios where email='ana@x.com'`)).rows[0].id, papel_app: 'usuario', sessao_versao: 0 });
  const p = await nova({ w: 844, h: 390, ua: IPHONE, prefs: { 'rp-auth': JSON.stringify({ token: tk, usuario: { nome: 'Ana Souza', papel_app: 'usuario' } }) } });
  await p.goto(srv.url); await p.waitForSelector('nav'); await p.waitForTimeout(700);
  assert.equal(await p.locator('#boot').count(), 0);
  const n = await p.locator('nav').boundingBox(); assert.ok(n.y + n.height <= 391 && n.y >= 0, `nav visível ${JSON.stringify(n)}`);
});
await passo('redimensionar em tempo real (teclado abre / gira o aparelho) reajusta o quadro', async () => {
  const p = await nova({ w: 390, h: 844, ua: IPHONE });
  await p.goto(srv.url); await p.waitForSelector('#e-email');
  await p.setViewportSize({ width: 390, height: 380 }); await p.waitForTimeout(400);
  let a = await p.evaluate(() => document.querySelector('.app').getBoundingClientRect().bottom); assert.ok(a <= 381, `teclado aberto: ${a}`);
  await p.setViewportSize({ width: 844, height: 390 }); await p.waitForTimeout(400);
  const o = await p.evaluate(() => [document.documentElement.dataset.orientacao, document.querySelector('.app').getBoundingClientRect().right]);
  assert.equal(o[0], 'paisagem'); assert.ok(o[1] <= 845);
});
await nav.close(); srv.fechar();
if (falhas.length) { console.log(falhas); process.exit(1); }
console.log('\nTodos os passos passaram.');
