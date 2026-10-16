// Validação do endereço do servidor (sem dependências; testável em Node puro).
// Regra: https em qualquer lugar; http só para localhost/127.0.0.1/rede local de testes. Câmera e microfone exigem contexto seguro.
export function validarServidor(entrada) {
  let u;
  try { u = new URL(String(entrada ?? '').trim()); } catch { return { ok: false, erro: 'Endereço inválido. Exemplo: https://revalida.seudominio.com' }; }
  if (u.username || u.password) return { ok: false, erro: 'Não coloque usuário/senha no endereço.' };
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol === 'http:' && !local) return { ok: false, erro: 'Use https:// (câmera e microfone só funcionam em conexão segura).' };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, erro: 'Use um endereço http(s).' };
  return { ok: true, origem: u.origin, url: u.origin + '/' };
}
export const mesmaOrigem = (url, origem) => { try { return new URL(url).origin === origem; } catch { return false; } };
