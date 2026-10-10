'use strict';
export class VideoRoom extends EventTarget {
  constructor({socket,api,roomCode,selfId,selfName}) {
    super();Object.assign(this,{socket,api,roomCode,selfId,selfName});
    this.local=null;this.mode='idle';this.peers=new Map();this.streams=new Map();this.negotiations=new Map();this.bindings=[];
    this.iceServers=[{urls:'stun:stun.l.google.com:19302'}];this.p2pTimeoutMs=8000;this.stopped=false;this.audioEnabled=true;this.videoEnabled=true;
  }
  _emit(type,detail){this.dispatchEvent(new CustomEvent(type,{detail}));}
  _bind(name,fn){this.socket.on(name,fn);this.bindings.push([name,fn]);}
  async start({video=true,audio=true}={}) {
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Câmera exige HTTPS ou localhost.');
    this.audioEnabled=audio;this.videoEnabled=video;
    try{const cfg=await (await this.api('/api/video/config')).json();if(!cfg.ok)throw Error(cfg.error);this.iceServers=cfg.iceServers;this.p2pTimeoutMs=cfg.p2p_watchdog_ms;this.maxMesh=cfg.mesh_max_participants;this.agoraCfg=cfg.agora;}catch{this.agoraCfg={available:false};}
    this.local=await navigator.mediaDevices.getUserMedia({video,audio});this._emit('local',{stream:this.local});this._mode('p2p','initial');
    this._bind('rtc:signal',m=>this._onSignal(m).catch(e=>this._emit('error',{message:e.message})));
    this._bind('room:user_left',({id})=>this._dropPeer(id));
    this._bind('rtc:peers',({participants})=>{for(const p of participants)if(this.selfId<p.id)this._ensure(p.id);});
    this._bind('rtc:peer_ready',({id})=>{if(this.mode==='p2p' && this.selfId<id)this._ensure(id);});
    this._bind('room:participants',({participants})=>{
      if(participants.filter(p=>p.media_ready).length>this.maxMesh && this.mode==='p2p') {
        if(this.agoraCfg.available)this.switchToAgora('mesh-capacity');else this._emit('error',{message:`Sala acima do limite recomendado de ${this.maxMesh} conexões mesh. Configure Agora.`});
      }
    });
    this._bind('rtc:mode',({mode})=>{if(mode==='agora' && this.mode==='p2p')this.switchToAgora('room-mode');});
    this._bind('connect',()=>{if(!this.stopped)this.socket.emit('rtc:ready');});
    this.socket.emit('rtc:ready');
    try{const snap=await (await this.api(`/api/rooms/${this.roomCode}`)).json();if(snap.room?.rtc_mode==='agora')await this.switchToAgora('room-mode');}catch{this._emit('error',{message:'Servidor indisponível. Mídia local pronta para SDP manual.'});}
    this.watchdog=setInterval(()=>this._checkMedia(),2000);
  }
  _mode(mode,reason){this.mode=mode;this._emit('mode',{mode,reason});}
  _ensure(id,manual=false){
    id=+id;if(this.peers.has(id))return this.peers.get(id);
    const pc=new RTCPeerConnection({iceServers:manual?[]:this.iceServers});
    const n={makingOffer:false,ignoreOffer:false,pending:[],polite:this.selfId>id,lastMedia:Date.now(),lastBytes:0,created:Date.now(),manual};this.peers.set(id,pc);this.negotiations.set(id,n);
    this.local?.getTracks().forEach(t=>pc.addTrack(t,this.local));
    pc.onicecandidate=e=>{if(e.candidate && !manual)this.socket.emit('rtc:signal',{to:id,data:{candidate:e.candidate.toJSON()}});};
    pc.ontrack=e=>{
      let stream=this.streams.get(id);if(!stream){stream=new MediaStream();this.streams.set(id,stream);}
      if(!stream.getTracks().some(t=>t.id===e.track.id))stream.addTrack(e.track);
      n.lastMedia=Date.now();this._emit('remote',{peerId:id,stream});
    };
    pc.onconnectionstatechange=()=>this._emit('state',{peerId:id,state:pc.connectionState});
    pc.onnegotiationneeded=async()=>{
      if(manual || this.mode!=='p2p')return;
      try{n.makingOffer=true;await pc.setLocalDescription();this.socket.emit('rtc:signal',{to:id,data:{sdp:pc.localDescription.toJSON()}});}catch(e){this._emit('error',{message:e.message});}finally{n.makingOffer=false;}
    };
    return pc;
  }
  async _onSignal({from,data}) {
    if(this.stopped || this.mode!=='p2p' || !this.local || !data)return;
    const pc=this._ensure(from),n=this.negotiations.get(+from);
    if(data.sdp){
      const collision=data.sdp.type==='offer' && (n.makingOffer || pc.signalingState!=='stable');
      n.ignoreOffer=!n.polite && collision;if(n.ignoreOffer)return;
      if(collision && n.polite)await pc.setLocalDescription({type:'rollback'});
      await pc.setRemoteDescription(data.sdp);
      for(const c of n.pending.splice(0))await pc.addIceCandidate(c);
      if(data.sdp.type==='offer'){await pc.setLocalDescription();this.socket.emit('rtc:signal',{to:from,data:{sdp:pc.localDescription.toJSON()}});}
    }else if(data.candidate){if(n.ignoreOffer)return;if(!pc.remoteDescription)n.pending.push(data.candidate);else await pc.addIceCandidate(data.candidate);}
  }
  async _checkMedia(){
    if(this.mode!=='p2p' || this.checking)return;this.checking=true;
    try{
      for(const [id,pc] of this.peers){const n=this.negotiations.get(id);if(!n || n.manual)continue;
        const stats=await pc.getStats();let bytes=0;stats.forEach(r=>{if(r.type==='inbound-rtp' && !r.isRemote)bytes+=(r.bytesReceived || 0);});
        if(bytes>n.lastBytes){n.lastBytes=bytes;n.lastMedia=Date.now();}
        // Track each peer, not just whether any one peer connected. Muted peers may send no packets.
        if(Date.now()-n.created>this.p2pTimeoutMs && (pc.connectionState==='failed' || pc.connectionState==='disconnected' || (pc.connectionState!=='connected' && Date.now()-n.lastMedia>this.p2pTimeoutMs))) {
          if(this.agoraCfg?.available){await this.switchToAgora('peer-timeout');break;}
          this._emit('error',{message:`Peer ${id} não conectou. Configure TURN/Agora ou use SDP manual em rede compatível.`});n.created=Date.now();
        }
      }
    }catch{}finally{this.checking=false;}
  }
  _dropPeer(id){id=+id;this.peers.get(id)?.close();this.peers.delete(id);this.negotiations.delete(id);this.streams.delete(id);this._emit('drop',{peerId:id});}
  async switchToAgora(reason){
    if(this.stopped || this.mode==='agora' || this.switching)return;
    if(!this.agoraCfg?.available){this._emit('error',{message:'Agora não configurada. P2P permanece ativo.'});return;}
    this.switching=true;let client,tracks=[];
    try{
      if(!window.AgoraRTC)await loadScript('/vendor/AgoraRTC_N-4.21.0.js');
      const tok=await this._token();client=window.AgoraRTC.createClient({mode:'rtc',codec:'vp8'});
      const update=user=>{const stream=new MediaStream();if(user.videoTrack)stream.addTrack(user.videoTrack.getMediaStreamTrack());if(user.audioTrack)stream.addTrack(user.audioTrack.getMediaStreamTrack());this.streams.set(+user.uid,stream);this._emit('remote',{peerId:+user.uid,stream});};
      client.on('user-published',async(user,type)=>{try{await client.subscribe(user,type);update(user);}catch(e){this._emit('error',{message:e.message});}});
      client.on('user-unpublished',user=>update(user));client.on('user-left',user=>{this.streams.delete(+user.uid);this._emit('drop',{peerId:+user.uid});});
      client.on('token-privilege-will-expire',async()=>{try{await client.renewToken((await this._token()).token);}catch{this._emit('error',{message:'Não foi possível renovar token Agora.'});}});
      await client.join(tok.appId,tok.channel,tok.token,tok.uid);
      const at=this.local.getAudioTracks()[0],vt=this.local.getVideoTracks()[0];
      if(at)tracks.push(window.AgoraRTC.createCustomAudioTrack({mediaStreamTrack:at}));if(vt)tracks.push(window.AgoraRTC.createCustomVideoTrack({mediaStreamTrack:vt}));
      await client.publish(tracks);
      if(this.stopped){tracks.forEach(t=>t.close());await client.leave();return;}
      for(const id of [...this.peers.keys()])this._dropPeer(id);
      this.agora={client,tracks};this._mode('agora',reason);this.socket.emit('rtc:mode',{mode:'agora'});
    }catch(e){tracks.forEach(t=>t.close());try{await client?.leave();}catch{}this._emit('error',{message:'Failsafe Agora falhou: '+e.message});}
    finally{this.switching=false;}
  }
  async _token(){const t=await (await this.api('/api/agora/token',{method:'POST',body:{room:this.roomCode}})).json();if(!t.ok)throw Error(t.error);return t;}
  async toggle(kind){const key=kind==='audio'?'audioEnabled':'videoEnabled';this[key]=!this[key];this.local?.getTracks().filter(t=>t.kind===kind).forEach(t=>t.enabled=this[key]);for(const t of this.agora?.tracks || [])if(t.getMediaStreamTrack().kind===kind)await t.setEnabled(this[key]);return this[key];}
  async devices(){return (await navigator.mediaDevices.enumerateDevices()).filter(d=>['audioinput','videoinput'].includes(d.kind));}
  async selectDevice(kind,deviceId){const stream=await navigator.mediaDevices.getUserMedia({[kind]:{deviceId:{exact:deviceId}}});await this._replace(kind,stream.getTracks()[0]);}
  async _replace(kind,track){
    const old=this.local.getTracks().find(t=>t.kind===kind);track.enabled=kind==='audio'?this.audioEnabled:this.videoEnabled;
    for(const pc of this.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind===kind);if(sender)await sender.replaceTrack(track);else pc.addTrack(track,this.local);}
    if(this.agora){const wrapper=this.agora.tracks.find(t=>t.getMediaStreamTrack().kind===kind);if(wrapper){
      if(kind==='video' && typeof wrapper.replaceTrack==='function')await wrapper.replaceTrack(track);
      else {const replacement=kind==='audio'?window.AgoraRTC.createCustomAudioTrack({mediaStreamTrack:track}):window.AgoraRTC.createCustomVideoTrack({mediaStreamTrack:track});await this.agora.client.unpublish(wrapper);await this.agora.client.publish(replacement);this.agora.tracks[this.agora.tracks.indexOf(wrapper)]=replacement;wrapper.close();}
    }}
    if(old){this.local.removeTrack(old);if(old!==this.cameraTrack)old.stop();}this.local.addTrack(track);this._emit('local',{stream:this.local});
  }
  async shareScreen(){
    if(this.screen){await this.stopScreen();return;}
    this.cameraTrack=this.local.getVideoTracks()[0];const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});this.screen=stream;
    const track=stream.getVideoTracks()[0];track.onended=()=>this.stopScreen();await this._replace('video',track);
  }
  async stopScreen(){if(!this.screen)return;const screen=this.screen;this.screen=null;if(this.cameraTrack){const camera=this.cameraTrack;this.cameraTrack=null;await this._replace('video',camera);}screen.getTracks().forEach(t=>t.stop());}
  async manualOffer(peerId){this._dropPeer(peerId);const pc=this._ensure(peerId,true);await pc.setLocalDescription(await pc.createOffer());await iceComplete(pc);return JSON.stringify({peer:this.selfId,target:+peerId,sdp:pc.localDescription.toJSON()});}
  async manualAccept(text){const m=JSON.parse(text);if(!m.sdp || +m.target!==this.selfId)throw Error('SDP destinado a outro participante.');const pc=this._ensure(m.peer,true);await pc.setRemoteDescription(m.sdp);if(m.sdp.type==='offer'){await pc.setLocalDescription(await pc.createAnswer());await iceComplete(pc);return JSON.stringify({peer:this.selfId,target:+m.peer,sdp:pc.localDescription.toJSON()});}return 'Resposta aplicada.';}
  async stop(){
    this.stopped=true;clearInterval(this.watchdog);this.bindings.forEach(([n,f])=>this.socket.off(n,f));this.bindings=[];
    this.socket.emit('rtc:stop');for(const id of [...this.peers.keys()])this._dropPeer(id);
    if(this.agora){try{await this.agora.client.unpublish(this.agora.tracks);}catch{}this.agora.tracks.forEach(t=>t.close());try{await this.agora.client.leave();}catch{}this.agora=null;}
    this.screen?.getTracks().forEach(t=>t.stop());this.cameraTrack?.stop();this.local?.getTracks().forEach(t=>t.stop());this.local=null;this._mode('idle','stop');
  }
}
function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error('Falha no SDK'));document.head.appendChild(s);});}
function iceComplete(pc){return new Promise(resolve=>{if(pc.iceGatheringState==='complete')return resolve();const listener=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',listener);resolve();}};const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',listener);resolve();},10000);pc.addEventListener('icegatheringstatechange',listener);});}
