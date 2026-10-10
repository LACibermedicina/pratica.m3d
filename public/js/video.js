'use strict';
/**
 * Cliente de videoconferência pratica.M3D v6
 * Estratégia: WebRTC P2P mesh (free) com watchdog de ~8s;
 * se nenhum peer trocar mídia, migra automaticamente para Agora.io
 * (token gerado no servidor). Nenhuma credencial vive no frontend.
 */
export class VideoRoom extends EventTarget {
  constructor({ socket, api, roomCode, selfId, selfName }) {
    super();
    this.socket = socket; this.api = api; this.roomCode = roomCode;
    this.selfId = selfId; this.selfName = selfName;
    this.mode = 'idle';            // idle | p2p | agora | failed
    this.local = null;             // MediaStream
    this.peers = new Map();        // peerUserId -> RTCPeerConnection
    this.streams = new Map();      // peerUserId -> MediaStream
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.watchdog = null;
    this.p2pTimeoutMs = 8000;
    this.agora = null;             // { client, uid }
  }

  async start({ video = true, audio = true } = {}) {
    try {
      const cfg = await (await this.api('/api/video/config')).json();
      this.iceServers = cfg.iceServers || this.iceServers;
      this.p2pTimeoutMs = cfg.p2p_watchdog_ms || this.p2pTimeoutMs;
      this.agoraCfg = cfg.agora || { available: false };
    } catch { /* mantém defaults */ }

    this.local = await navigator.mediaDevices.getUserMedia({ video, audio });
    this._emit('local', { stream: this.local });

    this.socket.on('rtc:signal', (m) => this._onSignal(m));
    this.socket.on('room:user_left', ({ id }) => this._dropPeer(id));
    this.socket.on('rtc:mode', ({ mode }) => {
      if (mode === 'agora' && this.mode === 'p2p') this.switchToAgora('peer');
    });

    this.mode = 'p2p';
    this._emit('mode', { mode: 'p2p', reason: 'initial' });

    // offer para quem já estava na sala (polite = quem tem maior id)
    const list = await (await this.api(`/api/rooms/${this.roomCode}`)).json();
    const others = (list.participants || []).filter((p) => p.id !== this.selfId);
    for (const p of others) await this._dial(p.id);

    this._armWatchdog();
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      const anyLive = [...this.peers.values()].some((pc) =>
        ['connected', 'completed'].includes(pc.iceConnectionState));
      if (!anyLive && this.peers.size > 0) {
        this.switchToAgora('p2p-timeout');
      } else if (this.peers.size === 0) {
        // ninguém mais na sala — permanece em P2P aguardando
      }
    }, this.p2pTimeoutMs);
  }

  async _dial(peerId) {
    const pc = this._mkPC(peerId);
    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit('rtc:signal', { to: peerId, data: { sdp: offer } });
  }

  _mkPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peers.set(peerId, pc);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('rtc:signal', { to: peerId, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      const s = e.streams[0] || new MediaStream([e.track]);
      this.streams.set(peerId, s);
      this._emit('remote', { peerId, stream: s });
      this._armWatchdog();
    };
    pc.oniceconnectionstatechange = () => {
      this._emit('state', { peerId, state: pc.iceConnectionState });
      if (['failed', 'disconnected'].includes(pc.iceConnectionState)) this._armWatchdog();
    };
    return pc;
  }

  async _onSignal({ from, data }) {
    if (this.mode !== 'p2p') return;
    let pc = this.peers.get(from);
    if (!pc) {
      pc = this._mkPC(from);
      this.local.getTracks().forEach((t) => pc.addTrack(t, this.local));
    }
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        this.socket.emit('rtc:signal', { to: from, data: { sdp: ans } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch { /* ignora */ }
    }
  }

  _dropPeer(id) {
    const pc = this.peers.get(id); if (pc) try { pc.close(); } catch {}
    this.peers.delete(id); this.streams.delete(id);
    this._emit('drop', { peerId: id });
  }

  async switchToAgora(reason) {
    if (this.mode === 'agora') return;
    if (!this.agoraCfg || !this.agoraCfg.available) {
      this.mode = 'failed';
      this._emit('mode', { mode: 'failed', reason: 'agora-unavailable;' + reason });
      return;
    }
    this.mode = 'agora';
    this._emit('mode', { mode: 'agora', reason });
    this.socket.emit('rtc:mode', { mode: 'agora' });

    // Carrega o SDK Agora sob demanda
    if (!window.AgoraRTC) await loadScript('https://download.agora.io/sdk/release/AgoraRTC_N-4.21.0.js');
    const tokRes = await (await this.api('/api/agora/token', { method: 'POST', body: { room: this.roomCode } })).json();
    if (!tokRes.ok) { this.mode = 'failed'; this._emit('mode', { mode: 'failed', reason: tokRes.error }); return; }

    // Fecha PCs do P2P (mantém o stream local)
    this.peers.forEach((pc) => { try { pc.close(); } catch {} });
    this.peers.clear(); this.streams.clear();

    const AgoraRTC = window.AgoraRTC;
    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    this.agora = { client };

    client.on('user-published', async (user, mediaType) => {
      await client.subscribe(user, mediaType);
      if (mediaType === 'video') {
        const stream = new MediaStream([user.videoTrack.getMediaStreamTrack()]);
        if (user.audioTrack) stream.addTrack(user.audioTrack.getMediaStreamTrack());
        this._emit('remote', { peerId: 'agora-' + user.uid, stream });
      }
      if (mediaType === 'audio') user.audioTrack.play();
    });
    client.on('user-unpublished', (user) => this._emit('drop', { peerId: 'agora-' + user.uid }));

    await client.join(tokRes.appId, tokRes.channel, tokRes.token, tokRes.uid);
    const [micTrack, camTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
    await client.publish([micTrack, camTrack]);
    this.agora.tracks = [micTrack, camTrack];
  }

  async stop() {
    clearTimeout(this.watchdog);
    this.peers.forEach((pc) => { try { pc.close(); } catch {} });
    this.peers.clear(); this.streams.clear();
    if (this.local) this.local.getTracks().forEach((t) => t.stop());
    if (this.agora) {
      try { this.agora.tracks?.forEach((t) => t.close()); } catch {}
      try { await this.agora.client.leave(); } catch {}
    }
    this.mode = 'idle';
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src));
    document.head.appendChild(s);
  });
}
