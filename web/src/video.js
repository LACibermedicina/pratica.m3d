// Videoconferência Agora com failsafe em camadas:
// 1) token da API Node → 2) endpoint PHP reserva (só se a API estiver fora do ar) → 3) modo demo (telas simuladas).
//
// Regras de mídia (o SERVIDOR decide e assina no token; aqui só se obedece):
//  • vídeo abre já na entrada; candidato e avaliador/ator ligam câmera e microfone sozinhos;
//  • qualquer participante (inclusive observador) pode ABRIR a própria câmera;
//  • observador só publica áudio se o chefe da sala liberou (padrão: bloqueado).
import AgoraRTC from 'agora-rtc-sdk-ng';

async function pedirToken(sessaoId, tokenAuth) {
  let r;
  try {
    r = await fetch(`/api/sessoes/${sessaoId}/agora-token`, { headers: { Authorization: `Bearer ${tokenAuth}` } });
  } catch {
    r = null; // rede/API fora do ar → pode tentar o reserva
  }
  if (r && r.status >= 400 && r.status < 500) {
    // recusa de verdade (não é participante, sessão expirada…): o reserva NÃO pode contornar isso
    const d = await r.json().catch(() => ({}));
    throw new Error(d.erro || 'Sem acesso ao vídeo desta sala.');
  }
  if (r && r.ok) return r.json();
  try {
    const rr = await fetch(`/php/token.php?canal=sala-${sessaoId}`);
    return await rr.json();
  } catch { return { modo: 'demo' }; }
}

export async function criarSalaVideo({ sessaoId, tokenAuth, aoMudar, aoErro, aoSomBloqueado, aoPermissao }) {
  const dados = await pedirToken(sessaoId, tokenAuth);
  let pode = dados.pode || { video: true, audio: dados.publica !== false, chefe: false };
  if (dados.modo !== 'agora') return { modo: 'demo', pode, papel: dados.papel };

  AgoraRTC.onAutoplayFailed = () => aoSomBloqueado?.(true);
  const cliente = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  let mic = null; let cam = null;
  const remotos = new Map(); // uid -> trilha de áudio remota (para retomar depois de bloqueio de autoplay)

  cliente.on('user-published', async (user, tipo) => {
    await cliente.subscribe(user, tipo);
    if (tipo === 'video') aoMudar({ tipo: 'video', uid: user.uid, track: user.videoTrack });
    if (tipo === 'audio') { remotos.set(user.uid, user.audioTrack); user.audioTrack.play(); }
  });
  cliente.on('user-unpublished', (user, tipo) => { if (tipo === 'video') aoMudar({ tipo: 'saiu-video', uid: user.uid }); });
  cliente.on('user-left', (user) => aoMudar({ tipo: 'saiu', uid: user.uid }));

  cliente.on('connection-state-change', async (atual, anterior) => {
    if (atual === 'DISCONNECTED' && anterior !== 'DISCONNECTING') {
      try {
        const novo = await pedirToken(sessaoId, tokenAuth);
        await cliente.join(novo.appId, novo.canal, novo.token, novo.uid);
        await aplicarPermissao(novo.pode);
        if (mic) await cliente.publish(mic);
        if (cam) await cliente.publish(cam);
      } catch { aoErro?.('Conexão de vídeo caiu. Tentando reconectar…'); }
    }
  });

  // Renova o token e relê a permissão de áudio (o privilégio do observador é curto de propósito).
  async function renovar() {
    const novo = await pedirToken(sessaoId, tokenAuth);
    if (novo.token) await cliente.renewToken(novo.token);
    await aplicarPermissao(novo.pode);
    return novo;
  }
  cliente.on('token-privilege-will-expire', () => { renovar().catch(() => {}); });

  async function aplicarPermissao(nova) {
    if (!nova) return;
    const eraAudio = pode.audio;
    pode = nova;
    if (!pode.audio && mic) { // áudio revogado: some do ar na hora
      try { await cliente.unpublish(mic); } catch { /* já fora */ }
      mic.stop(); mic.close(); mic = null;
    }
    if (eraAudio !== pode.audio) aoPermissao?.(Boolean(pode.audio));
  }

  await cliente.join(dados.appId, dados.canal, dados.token, dados.uid);

  async function abrirCamera() {
    if (!cam) {
      cam = await AgoraRTC.createCameraVideoTrack();
      await cliente.publish(cam);
      aoMudar({ tipo: 'video', uid: dados.uid, track: cam, local: true });
    } else await cam.setEnabled(true);
  }
  async function abrirMic() {
    if (!pode.audio) return false;
    if (!mic) { mic = await AgoraRTC.createMicrophoneAudioTrack(); await cliente.publish(mic); }
    else await mic.setEnabled(true);
    return true;
  }

  // Entrada: candidato e avaliador já abrem câmera e microfone; observador entra assistindo e abre a câmera se quiser.
  const principal = dados.papel === 'candidato' || dados.papel === 'avaliador_ator';
  if (principal) {
    try { await abrirCamera(); } catch { aoErro?.('Câmera não autorizada. Você segue na sala sem imagem.'); }
    try { await abrirMic(); } catch { aoErro?.('Microfone não autorizado. Você segue na sala sem áudio.'); }
  }

  return {
    modo: 'agora', papel: dados.papel,
    get pode() { return pode; },
    cameraLigada: () => Boolean(cam && cam.enabled),
    microfoneLigado: () => Boolean(mic && mic.enabled),
    /** Devolve true se a câmera ficou ligada. */
    async alternarCam(ligado) {
      try { if (ligado) await abrirCamera(); else if (cam) await cam.setEnabled(false); } catch { aoErro?.('Não foi possível abrir a câmera (permissão negada?).'); }
      return Boolean(cam && cam.enabled);
    },
    /** Devolve true se o microfone ficou ligado; false se o servidor não permite (observador sem liberação). */
    async alternarMic(ligado) {
      try {
        if (ligado) { await abrirMic(); } else if (mic) await mic.setEnabled(false);
      } catch { aoErro?.('Não foi possível abrir o microfone (permissão negada?).'); }
      return Boolean(mic && mic.enabled);
    },
    /** Relê o token no servidor: aplica liberação/revogação do áudio. Devolve a permissão atual. */
    async sincronizar() { await renovar(); return pode; },
    retomarSom() { remotos.forEach((t) => t.play()); aoSomBloqueado?.(false); },
    async sair() {
      [mic, cam].forEach((t) => { if (t) { t.stop(); t.close(); } });
      await cliente.leave();
    },
  };
}
