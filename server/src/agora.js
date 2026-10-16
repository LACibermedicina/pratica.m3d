// Emissão de token Agora no servidor — a chave nunca sai daqui.
//
// Regras de mídia (decididas AQUI, a partir do banco; o navegador não influencia):
//  • vídeo/câmera: todo participante da sala pode publicar;
//  • áudio: candidato e avaliador/ator sempre; observador SOMENTE se o chefe da sala liberou
//    (`sessoes.audio_observadores`, padrão false).
// O privilégio de áudio do observador vence em poucos minutos: se o chefe revogar, o próximo token
// (renovado pelo cliente) já vem sem o privilégio, mesmo que um cliente adulterado ignore o aviso.

export const VALIDADE_TOKEN_S = 3600;        // entrar na sala e publicar vídeo
export const VALIDADE_AUDIO_OBS_S = 120;     // privilégio de áudio de observador (renovado enquanto liberado)

/** O que cada papel pode publicar. Função pura, usada pelo servidor e testada. */
export function permissoesDeMidia(papel, audioObservadores) {
  const principal = papel === 'candidato' || papel === 'avaliador_ator';
  return {
    video: true,
    audio: principal || (papel === 'observador' && audioObservadores === true),
    // quem pode mudar a permissão de áudio dos observadores
    chefe: papel === 'avaliador_ator',
  };
}

/** agora-token é CommonJS: conforme o Node/empacotador, o export vem em `mod.RtcTokenBuilder` ou só em `mod.default.RtcTokenBuilder`. */
export function resolverBuilder(mod) {
  const B = mod?.RtcTokenBuilder ?? mod?.default?.RtcTokenBuilder;
  if (!B) throw new Error('pacote agora-token não encontrado ou incompatível (rode npm install no servidor)');
  return B;
}

export function criarAgora({ cfg, carregarBuilder = async () => resolverBuilder(await import('agora-token')) }) {
  const appId = () => cfg.obter('AGORA_APP_ID');
  const certificado = () => cfg.obter('AGORA_APP_CERTIFICATE');
  return {
    configurado: () => Boolean(appId() && certificado()),
    appId,
    /** Token com privilégios separados de entrada, áudio e vídeo (durações relativas, em segundos). */
    async gerarToken({ canal, uid, audio }) {
      const Builder = await carregarBuilder();
      if (typeof Builder.buildTokenWithUidAndPrivilege !== 'function') {
        throw new Error('A versão instalada de agora-token não separa privilégios de áudio e vídeo (atualize o pacote).');
      }
      const agora = Math.floor(Date.now() / 1000);
      const audioS = audio === 'sempre' ? VALIDADE_TOKEN_S : audio === 'curto' ? VALIDADE_AUDIO_OBS_S : 0;
      const token = Builder.buildTokenWithUidAndPrivilege(
        appId(), certificado(), canal, uid,
        VALIDADE_TOKEN_S,   // validade do token
        VALIDADE_TOKEN_S,   // entrar no canal
        audioS,             // publicar áudio (0 = sem privilégio)
        VALIDADE_TOKEN_S,   // publicar vídeo (todos)
        0,                  // dados: ninguém precisa
      );
      return { token, expiraEm: agora + VALIDADE_TOKEN_S, audioExpiraEm: audioS ? agora + audioS : null };
    },
  };
}
