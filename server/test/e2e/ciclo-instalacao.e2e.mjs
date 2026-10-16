// E2E: ciclo de vida da instalação. Instalado = nunca mais mostra o instalador; só o root reabre (reinstalar ou limpar banco).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { iniciar } from './servidor-http.mjs';

const NPM = process.env.NPM_TOOLS || '/opt/npm-tools/node_modules';
const req = createRequire(`${NPM}/x.js`);
const esbuild = req('esbuild'); const { chromium } = req('playwright');
const aqui = fileURLToPath(new URL('.', import.meta.url));
const web = join(aqui, '../../../web');
const saida = process.env.SAIDA || join(aqui, 'capturas'); const pub = join(saida, 'pub4');
mkdirSync(pub, { recursive: true });
writeFileSync(join(saida, 'stub-io4.js'), 'export const io = () => ({ emit() {}, on() {}, disconnect() {} });');
writeFileSync(join(saida, 'stub-video4.js'), "export async function criarSalaVideo() { return { modo: 'demo', pode: {} }; }");
await esbuild.build({ entryPoints: [join(web, 'src/main.jsx')], bundle: true, outdir: pub, format: 'esm', target: 'es2022', logLevel: 'error', nodePaths: [NPM],
  alias: { 'socket.io-client': join(saida, 'stub-io4.js') }, plugins: [{ name: 'v', setup: (b) => b.onResolve({ filter: /\/video\.js$/ }, () => ({ path: join(saida, 'stub-video4.js') })) }],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'css' } });
writeFileSync(join(pub, 'index.html'), '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revalida</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');

const srv = await iniciar({ pastaWeb: pub, instalado: true });
const nav = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const falhas = [];
const passo = async (n, fn) => { try { await fn(); console.log('✔', n); } catch (e) { falhas.push(n); console.log('✘', n, '\n   ', e.message.split('\n')[0]); } };
const ctx = await nav.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const p = await ctx.newPage(); p.on('pageerror', (e) => falhas.push(`erro de página: ${e.message}`));
const entrar = async (email, senha) => { await p.fill('#e-email', email); await p.fill('#e-senha', senha); await p.click('button.btn:has-text("Entrar")'); await p.waitForSelector('nav >> text=Admin'); };
const abaSistema = async () => { await p.click('nav >> text=Admin'); await p.click('[role=tab]:has-text("Sistema")'); await p.waitForSelector('[data-testid=sistema]'); };
const passarInstalador = async (novaSenhaRoot) => {
  await p.waitForSelector('[data-passo="etapa-0"]');
  await p.fill('input[placeholder="XXXX-XXXX-XXXX"]', srv.codigo()); await p.click('button:has-text("Começar")');
  await p.waitForSelector('[data-passo="etapa-1"]'); await p.click('button:has-text("Continuar")'); await p.click('button:has-text("Continuar")');
  await p.waitForSelector('[data-passo="etapa-3"]');
  await p.fill('label:has-text("Nova senha da conta raiz") input', novaSenhaRoot); await p.click('button:has-text("Definir senha raiz")');
  await p.waitForSelector('.msg:has-text("raiz definida")');
  await p.click('button:has-text("Continuar")'); await p.click('button:has-text("Concluir instalação")');
  await p.waitForSelector('[data-passo="instalado"]'); await p.click('button:has-text("Ir para o login")'); await p.waitForSelector('#e-email');
};

try {
  await passo('servidor já instalado: abre direto no login, sem instalador, e recarregar não muda isso', async () => {
    await p.goto(srv.url); await p.waitForSelector('#e-email');
    assert.equal(await p.locator('[data-passo^="etapa"]').count(), 0);
    await p.reload(); await p.waitForSelector('#e-email'); assert.equal(await p.locator('[data-passo^="etapa"]').count(), 0);
  });
  await passo('admin comum não vê a aba Sistema; root vê', async () => {
    await srv.mkUser('Adm Comum', 'adm@x.com', 'senhaforte123', 'admin');
    await entrar('adm@x.com', 'senhaforte123'); await p.click('nav >> text=Admin');
    assert.equal(await p.locator('[role=tab]:has-text("Sistema")').count(), 0);
    await p.click('nav >> text=Sair'); await p.waitForSelector('#e-email');
    await entrar('root@m3d.pro', 'arcano123'); await p.click('nav >> text=Admin');
    assert.equal(await p.locator('[role=tab]:has-text("Sistema")').count(), 1);
  });
  await passo('reinstalar: exige frase e senha certas; depois reabre o instalador (dados mantidos)', async () => {
    await abaSistema();
    await p.click('button:has-text("Reinstalar o sistema")');
    assert.equal(await p.locator('button:has-text("Confirmar")').isDisabled(), true, 'sem a frase, o botão fica travado');
    await p.fill('label:has-text("Sua senha") input', 'errada123456'); await p.fill('label:has-text("Digite") input', 'REINSTALAR');
    await p.click('button:has-text("Confirmar")'); await p.waitForSelector('.msg.e');
    assert.equal((await srv.q(`select count(*)::int c from config_servidor where chave='instalado_em'`)).rows[0].c, 1, 'continua instalado');
    await p.fill('label:has-text("Sua senha") input', 'arcano123'); await p.click('button:has-text("Confirmar")');
    await p.waitForSelector('[data-passo="etapa-0"]');
    assert.equal((await srv.q(`select count(*)::int c from usuarios`)).rows[0].c >= 3, true, 'usuários mantidos');
    await p.screenshot({ path: join(saida, '40-reinstalacao.png') });
  });
  await passo('reinstalar de novo exige o NOVO código e conclui com a senha raiz definitiva; depois não volta mais', async () => {
    await passarInstalador('RaizNova2026');
    await entrar('root@m3d.pro', 'RaizNova2026');
    await p.reload(); await p.waitForSelector('nav >> text=Admin'); assert.equal(await p.locator('[data-passo^="etapa"]').count(), 0);
  });
  await passo('limpar banco: apaga usuários e reabre o instalador; estações ficam', async () => {
    const est = (await srv.q(`select count(*)::int c from estacoes`)).rows[0].c;
    await abaSistema();
    await p.click('button:has-text("Limpar o banco")');
    await p.fill('label:has-text("Sua senha") input', 'RaizNova2026'); await p.fill('label:has-text("Digite") input', 'APAGAR TUDO');
    await p.click('button:has-text("Confirmar")');
    await p.waitForSelector('[data-passo="etapa-0"]');
    assert.equal((await srv.q(`select count(*)::int c from usuarios`)).rows[0].c, 0);
    assert.equal((await srv.q(`select count(*)::int c from estacoes`)).rows[0].c, est);
    await p.screenshot({ path: join(saida, '41-banco-limpo.png') });
  });
  await passo('servidor vazio: o instalador cria o root e conclui; volta ao normal', async () => {
    await p.fill('input[placeholder="XXXX-XXXX-XXXX"]', srv.codigo()); await p.click('button:has-text("Começar")');
    await p.waitForSelector('[data-passo="etapa-1"]'); await p.click('button:has-text("Continuar")'); await p.click('button:has-text("Continuar")');
    await p.waitForSelector('[data-passo="etapa-3"]');
    await p.fill('label:has-text("E-mail da conta raiz") input', 'dono@clinica.com');
    await p.fill('label:has-text("Nova senha da conta raiz") input', 'DonoForte2026'); await p.click('button:has-text("Definir senha raiz")');
    await p.waitForSelector('.msg:has-text("raiz definida")');
    await p.click('button:has-text("Continuar")'); await p.click('button:has-text("Concluir instalação")');
    await p.waitForSelector('[data-passo="instalado"]'); await p.click('button:has-text("Ir para o login")');
    await entrar('dono@clinica.com', 'DonoForte2026');
  });
} finally { await nav.close(); srv.fechar(); }
if (falhas.length) { console.log(falhas); process.exit(1); }
console.log('\nTodos os passos passaram.');
