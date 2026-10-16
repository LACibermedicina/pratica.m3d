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

export function ligar(win = window) {
  const medir = () => {
    const nav = win.navigator;
    const d = detectar({ ua: nav.userAgent, largura: win.innerWidth, toques: nav.maxTouchPoints || 0, tipoUaData: nav.userAgentData?.mobile });
    const r = win.document.documentElement;
    r.dataset.dispositivo = d; r.dataset.layout = layoutDe(d, win.innerWidth);
    return d;
  };
  const d = medir();
  win.addEventListener('resize', medir);
  return d;
}
