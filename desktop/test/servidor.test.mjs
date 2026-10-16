import test from 'node:test';
import assert from 'node:assert/strict';
import { validarServidor, mesmaOrigem } from '../src-servidor.js';

test('aceita https e localhost; recusa http remoto, credenciais e lixo', () => {
  assert.equal(validarServidor('https://revalida.exemplo.com/qualquer').origem, 'https://revalida.exemplo.com');
  assert.equal(validarServidor('http://localhost:5173').ok, true);
  assert.equal(validarServidor('http://127.0.0.1:3001').ok, true);
  for (const ruim of ['http://revalida.exemplo.com', 'https://u:p@x.com', 'ftp://x.com', 'javascript:alert(1)', 'abc', '', null]) assert.equal(validarServidor(ruim).ok, false, String(ruim));
});
test('mesmaOrigem só vale para a origem exata', () => {
  assert.equal(mesmaOrigem('https://a.com/x', 'https://a.com'), true);
  assert.equal(mesmaOrigem('https://a.com.evil.com/', 'https://a.com'), false);
  assert.equal(mesmaOrigem('http://a.com/', 'https://a.com'), false);
  assert.equal(mesmaOrigem('lixo', 'https://a.com'), false);
});
