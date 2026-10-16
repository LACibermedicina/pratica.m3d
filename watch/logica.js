// Lógica pura do relógio (testável em Node): formatação, regras de quem controla o quê e alertas de vibração.
export const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** Quem pode iniciar/pausar: o avaliador/ator, ou o dono em sala solo. O servidor confere de novo. */
export const controlaTimer = (papel, modo) => papel === 'avaliador_ator' || modo === 'solo';
/** Só o chefe da sala (avaliador/ator) libera o áudio dos observadores, e só em sala em dupla. */
export const ehChefe = (papel, modo) => papel === 'avaliador_ator' && modo === 'dupla';

export function acaoDoTimer(timer, totalMs) {
  if (timer.status === 'rodando') return { acao: 'pausar', rotulo: 'Pausar' };
  return timer.restante_ms >= totalMs ? { acao: 'iniciar', rotulo: 'Iniciar' } : { acao: 'retomar', rotulo: 'Retomar' };
}
export const estadoTexto = (timer, totalMs) => timer.restante_ms <= 0 ? 'Tempo esgotado' : timer.status === 'rodando' ? 'Em andamento' : timer.restante_ms >= totalMs ? 'Pronto' : 'Pausado';

/** Padrão de vibração ao cruzar 60 s e 0 s (devolve null se nada a avisar). */
export function alertaVibracao(restanteAntesMs, restanteAgoraMs) {
  if (restanteAntesMs > 0 && restanteAgoraMs <= 0) return [400, 150, 400, 150, 400];
  if (restanteAntesMs > 60000 && restanteAgoraMs <= 60000) return [200, 100, 200];
  return null;
}
export const corDoTimer = (ms) => (ms <= 60000 ? 'coral' : ms <= 180000 ? 'sol' : 'mar');
