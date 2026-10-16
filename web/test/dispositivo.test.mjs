import test from 'node:test';
import assert from 'node:assert/strict';
import { destinoInicial, detectar, layoutDe, lerModo, podeTrocarVersao } from '../src/dispositivo.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
  wear: 'Mozilla/5.0 (Linux; Android 13; Wear OS 4; Pixel Watch 2) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  galaxyWatch: 'Mozilla/5.0 (Linux; Android 13; SM-R930) AppleWebKit/537.36 Chrome/118 Mobile',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
};
test('relógio: UA de relógio ou tela minúscula', () => {
  assert.equal(detectar({ ua: UA.wear, largura: 396 }), 'relogio');
  assert.equal(detectar({ ua: UA.galaxyWatch, largura: 360 }), 'relogio');
  assert.equal(detectar({ ua: UA.android, largura: 240 }), 'relogio');
  assert.equal(detectar({ ua: UA.win, largura: 300 }), 'relogio');
});
test('celular: UA móvel, inclusive deitado; iPad que se diz Mac', () => {
  assert.equal(detectar({ ua: UA.iphone, largura: 390, toques: 5 }), 'celular');
  assert.equal(detectar({ ua: UA.android, largura: 915, toques: 5 }), 'celular', 'celular deitado continua celular');
  assert.equal(detectar({ ua: UA.mac, largura: 820, toques: 5 }), 'celular');
  assert.equal(detectar({ ua: UA.win, largura: 400, tipoUaData: true }), 'celular');
});
test('desktop: janela larga sem sinais de celular; janela estreita de desktop vira layout estreito', () => {
  assert.equal(detectar({ ua: UA.win, largura: 1440 }), 'desktop');
  assert.equal(detectar({ ua: UA.mac, largura: 1440, toques: 0 }), 'desktop');
  assert.equal(detectar({ ua: UA.win, largura: 1440, toques: 1 }), 'desktop', 'notebook com tela de toque');
  assert.equal(layoutDe('desktop', 1440), 'largo'); assert.equal(layoutDe('desktop', 600), 'estreito');
  assert.equal(layoutDe('celular', 1000), 'estreito', 'celular deitado não usa o layout largo');
});
test('relógio automático vai para /watch/, salvo quem escolheu o app completo; escolha manual sempre vale', () => {
  assert.equal(destinoInicial('relogio', 'auto'), '/watch/');
  assert.equal(destinoInicial('relogio', 'completo'), null);
  assert.equal(destinoInicial('desktop', 'auto'), null); assert.equal(destinoInicial('celular', 'auto'), null);
  assert.equal(destinoInicial('desktop', 'relogio'), '/watch/');
  assert.equal(destinoInicial('celular', 'relogio'), null, 'escolha manual guardada não vale em celular');
  assert.equal(destinoInicial('relogio', 'relogio'), '/watch/');
  assert.equal(destinoInicial('relogio', 'completo'), null);
});
test('modo guardado inválido ou storage quebrado = auto', () => {
  assert.equal(lerModo({ getItem: () => 'lixo' }), 'auto'); assert.equal(lerModo({ getItem: () => { throw 1; } }), 'auto');
  assert.equal(lerModo({ getItem: () => 'relogio' }), 'relogio');
});
test('só o desktop pode trocar de versão', () => {
  assert.equal(podeTrocarVersao('desktop'), true);
  assert.equal(podeTrocarVersao('celular'), false); assert.equal(podeTrocarVersao('relogio'), false);
});

import { calcularQuadro, perfilDe, PERFIS } from '../src/dispositivo.js';
test('perfilDe: celular, tablet (inclui celular deitado grande), janela estreita e desktop', () => {
  assert.equal(perfilDe('celular', 390, 844), 'celular');
  assert.equal(perfilDe('celular', 844, 390), 'celular', 'celular deitado: menor lado < 600');
  assert.equal(perfilDe('celular', 820, 1180), 'tablet');
  assert.equal(perfilDe('desktop', 1280, 800), 'desktop');
  assert.equal(perfilDe('desktop', 700, 800), 'janela');
});
test('calcularQuadro: celular preenche tudo; nunca passa da área; sem altura mínima que estoure', () => {
  assert.deepEqual(calcularQuadro('celular', { largura: 390, altura: 700 }), { largura: 390, altura: 700, folga: 0, moldura: false });
  const q = calcularQuadro('celular', { largura: 844, altura: 340 });   // celular deitado, teclado aberto
  assert.equal(q.altura, 340); assert.equal(q.largura, 560, 'limitado pela larguraMax');
  for (const [perfil, area] of [['celular', { largura: 320, altura: 200 }], ['tablet', { largura: 800, altura: 300 }], ['janela', { largura: 500, altura: 250 }], ['desktop', { largura: 1000, altura: 300 }]]) {
    const r = calcularQuadro(perfil, area);
    assert.ok(r.largura <= area.largura && r.altura <= area.altura, `${perfil} cabe na área`);
  }
});
test('calcularQuadro: tablet e desktop respeitam preenchimento, folga e tetos', () => {
  const t = calcularQuadro('tablet', { largura: 820, altura: 1180 });
  assert.equal(t.largura, Math.round((820 - 40) * 0.8)); assert.equal(t.altura, 1100, 'teto de altura do tablet');
  const d = calcularQuadro('desktop', { largura: 1920, altura: 1080 });
  assert.deepEqual([d.largura, d.altura, d.moldura], [1240, 1032, true]);
  assert.equal(calcularQuadro('desktop', { largura: 1000, altura: 800 }).largura, 952);
  assert.equal(calcularQuadro('desconhecido', { largura: 300, altura: 300 }).largura, 300, 'perfil desconhecido cai no celular');
  assert.ok(Object.values(PERFIS).every((p) => p.larguraMax > 0));
});
