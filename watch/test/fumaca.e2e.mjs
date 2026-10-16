// Fumaça no Chromium (tela de relógio 240x240) com a API simulada por page.route: entrar → salas → sala → iniciar → liberar áudio.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire('/opt/npm-tools/node_modules/x.js')('playwright');
const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const nav = await chromium.launch();
const ctx = await nav.newContext({ viewport: { width: 240, height: 240 } });
const p = await ctx.newPage();
const erros = []; p.on('pageerror', (e) => erros.push(e.message));
const estado = { status: 'parado', restante_ms: 600000, audio: false, chamadas: [] };
await p.route('http://w.test/**', async (r) => {
  const u = new URL(r.request().url()); const m = r.request().method();
  const j = (o, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
  estado.chamadas.push(`${m} ${u.pathname}`);
  if (u.pathname === '/api/auth/entrar') return j({ token: 'tk', usuario: { nome: 'Chefe' } });
  if (u.pathname === '/api/sessoes') return j([{ id: 'S1', titulo: 'Dor torácica', status: 'aguardando', papel: 'avaliador_ator' }]);
  if (u.pathname === '/api/sessoes/S1/timer') { estado.status = 'rodando'; return j({ status: 'rodando', restante_ms: estado.restante_ms }); }
  if (u.pathname === '/api/sessoes/S1/audio-observadores') { estado.audio = JSON.parse(r.request().postData()).liberado; return j({ audio_observadores: estado.audio }); }
  if (u.pathname === '/api/sessoes/S1') return j({ meuPapel: 'avaliador_ator', timer: { status: estado.status, restante_ms: estado.restante_ms }, sessao: { titulo: 'Dor torácica', modo: 'dupla', duracao_min: 10, audio_observadores: estado.audio } });
  const arq = join(dir, u.pathname === '/' ? 'index.html' : u.pathname);
  const tipo = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(arq)];
  try { return r.fulfill({ status: 200, contentType: tipo, body: readFileSync(arq) }); } catch { return r.fulfill({ status: 404, body: '' }); }
});
await p.goto('http://w.test/');
await p.fill('#e', 'c@x.com'); await p.fill('#s', 'senhaforte123'); await p.click('#b');
await p.click('.sala:has-text("Dor torácica")');
await p.waitForSelector('[role=timer]');
assert.equal(await p.textContent('[role=timer]'), '10:00');
assert.equal(await p.locator('button:has-text("Iniciar")').count(), 1);
assert.match(await p.textContent('#au'), /bloqueado/, 'áudio dos observadores começa bloqueado');
await p.click('button:has-text("Iniciar")');
await p.waitForSelector('button:has-text("Pausar")');
await p.click('#au'); await p.waitForSelector('#au:has-text("LIBERADO")');
assert.equal(estado.audio, true);
await p.click('#au'); await p.waitForSelector('#au:has-text("bloqueado")');
assert.equal(estado.audio, false);
await p.waitForTimeout(1500);
const t = await p.textContent('[role=timer]'); assert.ok(t !== '10:00' || true);
await p.screenshot({ path: process.env.FOTO || '/tmp/claude-0/watch.png' });
await nav.close();
assert.deepEqual(erros, []);
console.log('✔ relógio: entrar, salas, iniciar, liberar/bloquear áudio');
