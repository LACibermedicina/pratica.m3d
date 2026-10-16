import test from 'node:test';
import assert from 'node:assert/strict';
import { acaoDoTimer, alertaVibracao, controlaTimer, corDoTimer, ehChefe, estadoTexto, fmt } from '../logica.js';
const T = 600000;
test('fmt', () => { assert.equal(fmt(600000), '10:00'); assert.equal(fmt(59001), '01:00'); assert.equal(fmt(-5), '00:00'); assert.equal(fmt(0), '00:00'); });
test('quem controla o timer e quem é chefe', () => {
  assert.equal(controlaTimer('avaliador_ator', 'dupla'), true); assert.equal(controlaTimer('candidato', 'dupla'), false);
  assert.equal(controlaTimer('observador', 'dupla'), false); assert.equal(controlaTimer('candidato', 'solo'), true);
  assert.equal(ehChefe('avaliador_ator', 'dupla'), true); assert.equal(ehChefe('avaliador_ator', 'solo'), false);
  for (const p of ['candidato', 'observador']) assert.equal(ehChefe(p, 'dupla'), false);
});
test('ação e texto do timer', () => {
  assert.equal(acaoDoTimer({ status: 'parado', restante_ms: T }, T).acao, 'iniciar');
  assert.equal(acaoDoTimer({ status: 'rodando', restante_ms: 300000 }, T).acao, 'pausar');
  assert.equal(acaoDoTimer({ status: 'pausado', restante_ms: 300000 }, T).acao, 'retomar');
  assert.equal(estadoTexto({ status: 'parado', restante_ms: 0 }, T), 'Tempo esgotado'); assert.equal(estadoTexto({ status: 'parado', restante_ms: T }, T), 'Pronto');
});
test('vibração só ao cruzar 60 s e 0 s, uma vez', () => {
  assert.ok(alertaVibracao(61000, 60000)); assert.equal(alertaVibracao(60000, 59000), null);
  assert.ok(alertaVibracao(1000, 0)); assert.equal(alertaVibracao(0, 0), null); assert.equal(alertaVibracao(300000, 299000), null);
});
test('cores', () => { assert.deepEqual([corDoTimer(30000), corDoTimer(120000), corDoTimer(400000)], ['coral', 'sol', 'mar']); });
