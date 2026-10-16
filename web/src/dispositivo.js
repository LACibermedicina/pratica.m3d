// Identifica o tipo de aparelho: 'relogio' | 'celular' | 'desktop'. Função pura (testável) + ligação com a página.
// Ordem: relógio (UA de relógio ou tela minúscula) → celular/tablet (UA móvel, ou toque + tela estreita) → desktop.
const UA_RELOGIO = /Wear ?OS|\bWatch\b|Galaxy Watch|SM-R\d{3}|Tizen.*Watch|watchOS/i;
const UA_MOVEL = /Android|iPhone|iPod|iPad|Mobile|Windows Phone|Opera Mini|CriOS|FxiOS/i;
export const LARGURA_RELOGIO = 300;   // px de CSS: nenhum celular tem viewport tão estreito
export const LARGURA_DESKTOP = 900;

export function detectar({ ua = '', largura = 1280, toques = 0, tipoUaData } = {}) {
  if (UA_RELOGIO.test(ua) || largura <= LARGURA_RELOGIO) return 'relogio';
  if (tipoUaData === true || UA_MOVEL.test(ua)) return 'celular';
  // iPadOS se apresenta como Mac: toque + Mac + tela de tablet
  if (/Macintosh/.test(ua) && toques > 1 && largura < 1100) return 'celular';
  if (toques > 0 && largura < LARGURA_DESKTOP) return 'celular';
  return largura < LARGURA_DESKTOP ? 'celular' : 'desktop';
}

/** Celular nunca usa o layout largo (ex.: celular deitado); desktop usa quando a janela for larga. */
export const layoutDe = (dispositivo, largura) => (dispositivo === 'desktop' && largura >= LARGURA_DESKTOP ? 'largo' : 'estreito');

/** Preferência guardada: 'auto' (padrão) | 'relogio' (escolhido pela pessoa) | 'completo' (recusou o relógio automático). */
export const lerModo = (storage) => { try { const v = storage.getItem('rv-modo'); return v === 'relogio' || v === 'completo' ? v : 'auto'; } catch { return 'auto'; } };
export const gravarModo = (storage, v) => { try { storage.setItem('rv-modo', v); } catch { /* sem storage */ } };

/**
 * Para onde ir ao abrir: '/watch/' ou null (ficar no app completo).
 * Relógio de verdade vai para a versão relógio (salvo quem pediu o app completo). A ESCOLHA manual de versão só existe
 * no desktop: um 'relogio' guardado num celular/tablet é ignorado (não existe o ícone para desfazer).
 */
export const destinoInicial = (dispositivo, modo) => ((modo === 'relogio' && dispositivo === 'desktop') || (modo !== 'completo' && dispositivo === 'relogio') ? '/watch/' : null);
/** O ícone de trocar de versão só aparece no desktop. */
export const podeTrocarVersao = (dispositivo) => dispositivo === 'desktop';

/* ==========================================================================
   Quadro adaptativo (conceito do modelo de redimensionamento proporcional)
   --------------------------------------------------------------------------
   Em vez de confiar em 100%/100vh/min-height (que "somem" ou estouram quando a barra do navegador
   do celular aparece, o teclado abre, o aparelho gira ou a janela é pequena), medimos a ÁREA VISÍVEL REAL
   (visualViewport) e calculamos o tamanho do quadro do app com limites por perfil.
   Todos os parâmetros ficam neste bloco.
   ========================================================================== */
export const PERFIS = {
  //            folga: respiro em px   preenchimento: fração da largura útil   larguraMax/alturaMax: tetos em px   moldura: cantos/borda
  celular: { folga: 0,  preenchimento: 1.0,  larguraMax: 560,  alturaMax: Infinity, alturaMin: 0,   moldura: false },
  tablet:  { folga: 20, preenchimento: 0.8,  larguraMax: 640,  alturaMax: 1100,     alturaMin: 420, moldura: true },
  janela:  { folga: 16, preenchimento: 0.95, larguraMax: 520,  alturaMax: 920,      alturaMin: 420, moldura: true },   // desktop com janela estreita
  desktop: { folga: 24, preenchimento: 1.0,  larguraMax: 1240, alturaMax: Infinity, alturaMin: 480, moldura: true },
};

/** Perfil de medida: celular de tela pequena, tablet (celular/iPad de tela grande), janela estreita de desktop, ou desktop largo. */
export function perfilDe(dispositivo, largura, altura) {
  if (dispositivo === 'desktop') return largura >= LARGURA_DESKTOP ? 'desktop' : 'janela';
  return Math.min(largura, altura) >= 600 ? 'tablet' : 'celular';
}

/** Largura/altura do quadro do app dentro da área visível. Função pura. */
export function calcularQuadro(perfilChave, area) {
  const p = PERFIS[perfilChave] ?? PERFIS.celular;
  const util = (v) => Math.max(0, v - p.folga * 2);
  const largura = Math.round(Math.min(util(area.largura) * p.preenchimento, p.larguraMax));
  // nunca maior que a área visível (janela baixa/teclado aberto): o conteúdo rola DENTRO do quadro
  const altura = Math.round(Math.min(util(area.altura), p.alturaMax));
  return { largura: Math.max(0, largura), altura: Math.max(0, altura), folga: p.folga, moldura: p.moldura };
}

/** Área realmente visível: visualViewport acompanha barras de endereço e teclado do celular. */
export function medirArea(win = window) {
  const vv = win.visualViewport;
  return { largura: Math.round(vv?.width ?? win.innerWidth), altura: Math.round(vv?.height ?? win.innerHeight) };
}

export function aplicarQuadro(win, dispositivo) {
  const area = medirArea(win);
  const chave = perfilDe(dispositivo, area.largura, area.altura);
  const q = calcularQuadro(chave, area);
  const r = win.document.documentElement;
  r.style.setProperty('--app-w', q.largura + 'px');
  r.style.setProperty('--app-h', q.altura + 'px');
  r.style.setProperty('--folga', q.folga + 'px');
  r.style.setProperty('--vv-h', area.altura + 'px');
  r.dataset.moldura = q.moldura ? 'sim' : 'nao';
  r.dataset.perfil = chave;
  r.dataset.orientacao = area.largura > area.altura ? 'paisagem' : 'retrato';
  return q;
}

export function ligar(win = window) {
  const medir = () => {
    const nav = win.navigator;
    const d = detectar({ ua: nav.userAgent, largura: win.innerWidth, toques: nav.maxTouchPoints || 0, tipoUaData: nav.userAgentData?.mobile });
    const r = win.document.documentElement;
    r.dataset.dispositivo = d; r.dataset.layout = layoutDe(d, win.innerWidth);
    aplicarQuadro(win, d);
    return d;
  };
  const d = medir();
  // debounce: o resize dispara dezenas de vezes por segundo no celular (barra de endereço, teclado, rotação)
  let t = 0; const agendar = () => { clearTimeout(t); t = setTimeout(medir, 80); };
  win.addEventListener('resize', agendar, { passive: true });
  win.addEventListener('orientationchange', () => { agendar(); setTimeout(medir, 350); }, { passive: true });  // iOS reporta o tamanho novo com atraso
  win.visualViewport?.addEventListener('resize', agendar, { passive: true });
  win.visualViewport?.addEventListener('scroll', agendar, { passive: true });
  return d;
}
