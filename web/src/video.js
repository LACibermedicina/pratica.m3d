// Videoconferência Agora com failsafe em camadas:
// 1) token da API Node → 2) endpoint PHP reserva → 3) modo demo (telas simuladas).
// Renova token antes de expirar e reentra sozinho em queda de rede.
import AgoraRTC from 'agora-rtc-sdk-ng';

export async function criarSalaVideo({ sessaoId, tokenAuth, aoMudar, aoErro }) {
  let dados;
  try {
    const r = await fetch(`/api/sessoes/${sessaoId}/agora-token`, {
      headers: { Authorization: `Bearer ${tokenAuth}` },
    });
    if (!r.ok) throw new Error('api');
    dados = await r.json();
  } catch {
    // failsafe 2: endpoint PHP reserva
    try {
      const r = await fetch(`/php/token.php?canal=sala-${sessaoId}`);
      dados = await r.json();
    } catch {
      dados = { modo: 'demo' };
    }
  }
  if (dados.modo !== 'agora') return { modo: 'demo' };

  const cliente = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  const faixasLocais = [];
  const publica = dados.publica !== false;

  cliente.on('user-published', async (user, tipo) => {
    await cliente.subscribe(user, tipo);
    if (tipo === 'video') aoMudar({ tipo: 'video', uid: user.uid, track: user.videoTrack });
    if (tipo === 'audio') user.audioTrack.play();
  });
  cliente.on('user-unpublished', (user, tipo) => {
    if (tipo === 'video') aoMudar({ tipo: 'saiu-video', uid: user.uid });
  });
  cliente.on('user-left', (user) => aoMudar({ tipo: 'saiu', uid: user.uid }));

  // failsafe: reentrada automática em queda
  cliente.on('connection-state-change', async (atual, anterior) => {
    if (atual === 'DISCONNECTED' && anterior !== 'DISCONNECTING') {
      try { await cliente.join(dados.appId, dados.canal, dados.token, dados.uid); }
      catch (e) { aoErro?.('Conexão de vídeo caiu. Tentando reconectar…'); }
    }
  });

  // failsafe: renova o token antes de expirar
  cliente.on('token-privilege-will-expire', async () => {
    try {
      const r = await fetch(`/api/sessoes/${sessaoId}/agora-token`, {
        headers: { Authorization: `Bearer ${tokenAuth}` },
      });
      const novo = await r.json();
      if (novo.token) await cliente.renewToken(novo.token);
    } catch { /* se falhar, o evento did-expire derruba e a reconexão tenta de novo */ }
  });

  await cliente.join(dados.appId, dados.canal, dados.token, dados.uid);

  if (publica) {
    try {
      const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks();
      faixasLocais.push(mic, cam);
      await cliente.publish([mic, cam]);
      aoMudar({ tipo: 'video', uid: dados.uid, track: cam, local: true });
    } catch {
      aoErro?.('Câmera/microfone não autorizados. Você entra só assistindo.');
    }
  }

  return {
    modo: 'agora',
    async alternarMic(ligado) { faixasLocais[0] && (await faixasLocais[0].setEnabled(ligado)); },
    async alternarCam(ligado) { faixasLocais[1] && (await faixasLocais[1].setEnabled(ligado)); },
    async sair() {
      faixasLocais.forEach((t) => { t.stop(); t.close(); });
      await cliente.leave();
    },
  };
}
