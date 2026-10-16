// Parâmetros do servidor: variável de ambiente tem prioridade; senão vale o que o instalador gravou em `config_servidor`.
// Valores secretos são cifrados com AES-256-GCM (chave derivada de JWT_SEGREDO) antes de ir para o banco.
import crypto from 'node:crypto';

/** Chaves aceitas. `segredo` = nunca é devolvido ao navegador, nem ao administrador. */
export const CHAVES = {
  APP_URL: { segredo: false },
  NOME_INSTITUICAO: { segredo: false },
  EMAIL_DE: { segredo: false },
  SMTP_URL: { segredo: true },
  AGORA_APP_ID: { segredo: false },
  AGORA_APP_CERTIFICATE: { segredo: true },
  PHP_TOKEN_URL: { segredo: false },
};

const chaveCifra = (segredo) => crypto.createHash('sha256').update(`config-servidor:${segredo}`).digest();

export function cifrar(texto, segredo) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chaveCifra(segredo), iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decifrar(valor, segredo) {
  try {
    const [iv, tag, ct] = String(valor).split('.').map((p) => Buffer.from(p, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', chaveCifra(segredo), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return undefined; // JWT_SEGREDO mudou ou dado corrompido: trata como não definido
  }
}

/** Nomes alternativos de variáveis de ambiente aceitos (ex.: SMTP_HOST/PORT/USER/PASS em vez de SMTP_URL). */
export function valorDoAmbiente(env, chave) {
  const v = env[chave];
  if (v !== undefined && v !== '') return v;
  if (chave === 'EMAIL_DE' && env.MAIL_FROM) return env.MAIL_FROM;
  if (chave === 'SMTP_URL' && env.SMTP_HOST) {
    const porta = env.SMTP_PORT || '465';
    const seguro = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : porta === '465';
    const cred = env.SMTP_USER ? `${encodeURIComponent(env.SMTP_USER)}:${encodeURIComponent(env.SMTP_PASS ?? '')}@` : '';
    return `${seguro ? 'smtps' : 'smtp'}://${cred}${env.SMTP_HOST}:${porta}`;
  }
  return undefined;
}

export function criarConfig({ q, env = process.env, segredo }) {
  const cache = new Map();
  return {
    async carregar() {
      const r = await q('select chave, valor, segredo from config_servidor');
      cache.clear();
      for (const l of r.rows) {
        if (!(l.chave in CHAVES)) continue;
        const v = l.segredo ? decifrar(l.valor, segredo) : l.valor;
        if (v !== undefined) cache.set(l.chave, v);
      }
    },
    /** Valor efetivo (ambiente > banco) ou undefined. */
    obter(chave) {
      return valorDoAmbiente(env, chave) ?? cache.get(chave);
    },
    origem(chave) {
      if (valorDoAmbiente(env, chave) !== undefined) return 'ambiente';
      return cache.has(chave) ? 'instalador' : 'nenhuma';
    },
    async definir(chave, valor) {
      const def = CHAVES[chave];
      if (!def) throw new Error('chave desconhecida');
      if (valor === null || valor === '') {
        await q('delete from config_servidor where chave=$1', [chave]);
        cache.delete(chave);
        return;
      }
      const guardado = def.segredo ? cifrar(valor, segredo) : String(valor);
      await q(
        `insert into config_servidor (chave, valor, segredo) values ($1,$2,$3)
         on conflict (chave) do update set valor=excluded.valor, segredo=excluded.segredo, atualizado_em=now()`,
        [chave, guardado, def.segredo],
      );
      cache.set(chave, String(valor));
    },
    /** Visão segura para o navegador: segredos viram só "definido". */
    visao() {
      return Object.fromEntries(Object.entries(CHAVES).map(([k, d]) => [k, {
        origem: this.origem(k),
        definido: this.obter(k) !== undefined,
        ...(d.segredo ? {} : { valor: this.obter(k) ?? '' }),
      }]));
    },
  };
}
