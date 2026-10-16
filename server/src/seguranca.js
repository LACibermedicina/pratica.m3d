// Peças de segurança sem dependências externas (testáveis em Node puro).
import crypto from 'node:crypto';

export const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const gerarToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const normalizarEmail = (e) => String(e ?? '').trim().toLowerCase();
export const emailValido = (e) => typeof e === 'string' && e.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
export const idValido = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id ?? ''));

/** Regra de senha do app: 10 a 128 caracteres, com letra e número (128 evita abuso do bcrypt). */
export function senhaValida(s) {
  return typeof s === 'string' && s.length >= 10 && s.length <= 128 && /[A-Za-z]/.test(s) && /\d/.test(s);
}

export const MSG_SENHA = 'A senha precisa ter de 10 a 128 caracteres, com pelo menos uma letra e um número.';

/**
 * Limite de tentativas em janela deslizante (em memória: vale por processo da API).
 * Atrás de vários servidores, troque por Redis/banco. É um freio, não substitui CAPTCHA.
 */
export class Limitador {
  constructor({ max, janelaMs, agora = () => Date.now() }) {
    this.max = max; this.janelaMs = janelaMs; this.agora = agora; this.mapa = new Map();
  }
  _recentes(chave) {
    const corte = this.agora() - this.janelaMs;
    const l = (this.mapa.get(chave) ?? []).filter((t) => t > corte);
    if (l.length) this.mapa.set(chave, l); else this.mapa.delete(chave);
    return l;
  }
  excedeu(chave) { return this._recentes(chave).length >= this.max; }
  registrar(chave) {
    const l = this._recentes(chave);
    l.push(this.agora());
    this.mapa.set(chave, l);
    if (this.mapa.size > 20000) for (const k of this.mapa.keys()) { this._recentes(k); if (this.mapa.size < 10000) break; }
  }
  limpar(chave) { this.mapa.delete(chave); }
}

/** Express 4 não captura erro de handler async: este envoltório devolve 500 genérico (sem detalhes). */
export const rota = (fn) => (req, res, prox) =>
  Promise.resolve(fn(req, res, prox)).catch((e) => {
    console.error('erro na rota', req.method, req.path, e?.message ?? e);
    if (!res.headersSent) res.status(500).json({ erro: 'Erro interno. Tente de novo.' });
  });
