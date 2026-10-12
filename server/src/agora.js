// Emissão de token Agora no servidor — a chave nunca sai daqui.
// Papel vem do banco: candidato/avaliador publicam áudio+vídeo; observador só assiste.
import { RtcTokenBuilder, RtcRole } from 'agora-token';

export function agoraConfigurado() {
  return Boolean(process.env.AGORA_APP_ID && process.env.AGORA_APP_CERTIFICATE);
}

export function gerarToken(canal, uid, publica) {
  const expiraEm = Math.floor(Date.now() / 1000) + 3600; // 1 h
  const papel = publica ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  return {
    token: RtcTokenBuilder.buildTokenWithUid(
      process.env.AGORA_APP_ID,
      process.env.AGORA_APP_CERTIFICATE,
      canal,
      uid,
      papel,
      expiraEm,
      expiraEm
    ),
    expiraEm,
  };
}
