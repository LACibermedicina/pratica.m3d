/* =====================================================================
   pratica.M3D — camada de servidor (PHP+SQLite) + recursos novos
   • Credenciais no servidor: o registro/login continuam válidos depois
     de fechar o navegador (sessão Bearer de 30 dias).
   • Sala SÓ abre com ≥1 estação selecionada (multi-seleção com troca
     da estação ativa pelo criador dentro da sala).
   • Sala pode ser aberta SEM convidados; link de convite para WhatsApp
     entra direto na sala (inclusive fechadas).
   • Seleção de participantes a partir dos usuários ONLINE (🟢) e
     agregação posterior de membros pelo botão "➕ Convidar".
   • Toggle "🤖 Correção IA" ao lado do botão ▶ Iniciar: transcreve o
     áudio (médico e ator) e pontua o PEP item a item em contexto válido.
   • Card de revisão didático pós-estação (fortes/fracos/sugestões de
     conduta) + reabertura/geração a partir do Histórico do dashboard.
   Se o api.php não estiver acessível, tudo funciona no modo local original.
===================================================================== */
(function(){
'use strict';
const API=location.pathname.replace(/[^/]*$/,'')+'api.php';
let apiToken=localStorage.getItem('pm3d_token')||null;
let SERVER=false, serverOnline=new Set();
const recogs={}, transcripts={};
state.aiCorrect={sm:false,room:false};

async function api(action,data){
  const r=await fetch(API+'?action='+action,{method:'POST',
    headers:{'Content-Type':'application/json',...(apiToken?{'Authorization':'Bearer '+apiToken}:{})},
    body:JSON.stringify(data||{})});
  const j=await r.json().catch(()=>({error:'HTTP '+r.status}));
  if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
  return j;
}
const mkCode=()=>Array.from({length:6},()=>'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*31)]).join('');
const onlineSet=()=>{ const s=new Set(onlineUsers().map(u=>u.email)); serverOnline.forEach(e=>s.add(e)); return s; };

/* ---------- injeção de estilos e modais (share / convite / revisão) ---------- */
document.body.insertAdjacentHTML('beforeend',`
<style>
.rev-box{border:2px solid var(--line);border-radius:14px;padding:12px;margin-top:10px;background:#fff}
.rev-box h4{margin:0 0 6px;font-size:14px}
.rev-box.ok{border-color:#a3e635;background:#f7fee7}
.rev-box.bad{border-color:#fda4af;background:#fff1f2}
.rev-box.tip{border-color:#fcd34d;background:#fffbeb}
.rev-box ul{margin:0;padding-left:18px;font-size:13px}
.rev-table{width:100%;border-collapse:collapse}
.rev-table td{border:1px solid var(--line);padding:6px;font-size:12px;vertical-align:top}
.ai-toggle.on{animation:pulse 1.6s infinite}
</style>
<div id="shareModal" class="modal-bg hidden" onclick="if(event.target===this)closeModal('shareModal')">
  <div class="modal" style="max-width:540px;text-align:center">
    <h2>📤 Convite da sala</h2>
    <p class="small">Compartilhe o link — quem receber faz login (ou se cadastra) e entra direto na sala, mesmo nas fechadas.</p>
    <div class="field"><input id="shareLink" readonly onclick="this.select()"/></div>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button class="sky" onclick="copyShareLink()">📋 Copiar link</button>
      <button id="shareWa" style="background:linear-gradient(135deg,#16a34a,#4ade80)">🟢 WhatsApp</button>
      <button class="ghost" onclick="closeModal('shareModal')">Fechar</button>
    </div>
  </div>
</div>
<div id="inviteModal" class="modal-bg hidden" onclick="if(event.target===this)closeModal('inviteModal')">
  <div class="modal">
    <h2>➕ Convidar participantes</h2>
    <p class="small">🟢 online agora · ⚪ offline — toque para selecionar e agregar à sala.</p>
    <div class="member-grid" id="inviteMembers"></div>
    <button style="width:100%;margin-top:12px" onclick="confirmInvite()">Adicionar à sala ✅</button>
  </div>
</div>
<div id="reviewModal" class="modal-bg hidden" onclick="if(event.target===this)closeModal('reviewModal')">
  <div class="modal"><h2 style="margin-top:0">🗂 Card de revisão didático</h2><div id="reviewBody"></div></div>
</div>`);

/* ---------- AUTH via servidor (fallback: funções originais locais) ---------- */
const _doRegister=window.doRegister, _doLogin=window.doLogin, _doForgot=window.doForgot,
      _doReset=window.doReset, _logout=window.logout, _enterApp=window.enterApp;

window.doRegister=async function(){
  if(!SERVER) return _doRegister();
  const name=$('regName').value.trim(), email=$('regEmail').value.trim().toLowerCase(), pass=$('regPass').value;
  if(!name||!email||!pass) return toast('Preencha todos os campos','err');
  try{ await api('register',{name,email,pass});
    toast('Cadastro realizado no servidor! Faça login 🎉','ok');
    document.querySelector('[data-tab=login]').click();
  }catch(e){ toast(e.message,'err'); }
};
window.doLogin=async function(){
  const email=$('loginEmail').value.trim().toLowerCase(), pass=$('loginPass').value;
  if(!SERVER) return _doLogin();
  try{
    const j=await api('login',{email,pass});
    apiToken=j.token; localStorage.setItem('pm3d_token',apiToken);
    let u=DB.data.users.find(x=>x.email===email);
    if(!u){ u={name:j.user.name,email,pass:btoa(pass),role:j.user.role,created:Date.now()}; DB.data.users.push(u); }
    else { u.name=j.user.name; u.role=j.user.role; }
    DB.save(); state.user=u; state.token='Bearer '+apiToken;
    sessionStorage.setItem('praticaM3D_session',JSON.stringify({email,token:state.token}));
    enterApp();
  }catch(e){ toast(e.message==='credenciais'?'Credenciais inválidas (HTTP 401)':e.message,'err'); }
};
window.doForgot=async function(){
  if(!SERVER) return _doForgot();
  try{ const j=await api('forgot',{email:$('forgEmail').value.trim().toLowerCase()});
    $('forgotMsg').innerHTML='Token gerado: <code class="key">'+j.token+'</code> (em produção seria enviado por e-mail)';
  }catch(e){ toast(e.message,'err'); }
};
window.doReset=async function(){
  if(!SERVER) return _doReset();
  try{ await api('reset',{token:$('resetToken').value.trim(),pass:$('resetPass').value});
    toast('Senha redefinida ✅','ok'); document.querySelector('[data-tab=login]').click();
  }catch(e){ toast(e.message,'err'); }
};
window.logout=function(){
  if(SERVER&&apiToken) api('logout',{}).catch(()=>{});
  localStorage.removeItem('pm3d_token'); apiToken=null; _logout();
};

/* sessão persistente: após fechar o navegador, o token ainda vale */
window.enterApp=async function(){
  await _enterApp();
  injectAIToggles();
  if(SERVER){ pullServerData(); serverHeartbeat(); }
  const pend=sessionStorage.getItem('pm3d_join');
  if(pend){ sessionStorage.removeItem('pm3d_join'); joinRoomByCode(pend); }
};

/* ---------- sincronização com o servidor ---------- */
function upsertLocalRoom(r){
  r._srv=1;
  const i=DB.data.rooms.findIndex(x=>x.id===r.id);
  if(i>=0) DB.data.rooms[i]=r; else DB.data.rooms.push(r);
}
async function pullServerData(){
  if(!SERVER||!apiToken||!state.user) return;
  try{
    const [us,rs,hs]=await Promise.all([api('users',{}),api('rooms',{}),api('history_list',{})]);
    serverOnline=new Set((us.online||[]).map(p=>p.email));
    (us.users||[]).forEach(su=>{
      let l=DB.data.users.find(x=>x.email===su.email);
      if(!l){ DB.data.users.push({name:su.name,email:su.email,pass:'',role:su.role,created:su.created||Date.now(),_srv:1}); }
      else { l.name=su.name; l.role=su.role; }
    });
    const srvIds=new Set((rs.rooms||[]).map(r=>r.id));
    DB.data.rooms=DB.data.rooms.filter(r=>!r._srv||srvIds.has(r.id));
    (rs.rooms||[]).forEach(upsertLocalRoom);
    let changed=false;
    (hs.history||[]).forEach(h=>{
      if(!state.history.find(x=>x.date===h.date&&x.tema===h.tema)){ state.history.push(h); changed=true; }
    });
    if(changed){ state.history.sort((a,b)=>a.date-b.date); saveUserLS(); }
    DB.save();
    /* não re-renderiza no meio de uma estação para não perder marcações */
    const midStation=!$('stationModal').classList.contains('hidden')||state.currentRoom;
    if(!midStation) renderAll();
  }catch(e){}
}
function serverHeartbeat(){
  if(SERVER&&apiToken&&state.user) api('heartbeat',{room:state.currentRoom,roomRole:state.myRoomRole}).catch(()=>{});
}

/* ---------- SALAS: exige estação, multi-estações, convite WhatsApp ---------- */
window.openCreateRoom=function(){
  const el=$('roomStationBP'); el.classList.add('boxpick'); el.dataset.value='';
  el.innerHTML='<p class="small" style="width:100%;margin:0 0 4px">Selecione <b>uma ou mais estações</b> (obrigatório para abrir a sala):</p>'+
    allStations().slice(0,80).map(s=>`<div class="bx" data-v="${s.id}">${esc(s.tema)}</div>`).join('');
  el.querySelectorAll('.bx').forEach(b=>b.onclick=()=>b.classList.toggle('sel'));
  $('roomName').value=''; renderRoomMembers(); openModal('roomModal');
};
window.createRoom=async function(){
  const stationIds=[...document.querySelectorAll('#roomStationBP .bx.sel')].map(x=>x.dataset.v);
  if(!stationIds.length) return toast('Selecione ao menos 1 estação para abrir a sala 🛑','err');
  const name=$('roomName').value.trim()||('Sala de '+state.user.name);
  const mode=bpVal('roomModeBP'), vis=bpVal('roomVisBP');
  const members=[...document.querySelectorAll('#roomMembers .member-card.sel')].map(x=>x.dataset.e);
  /* pode abrir SEM convidados: compartilha o link depois */
  const room={id:uid('room'),code:mkCode(),name,stationId:stationIds[0],stationIds,mode,vis,members,
              creator:state.user.email,creatorName:state.user.name,created:Date.now()};
  if(SERVER){
    try{ const j=await api('room_create',{name,stationIds,mode,vis,members});
      room.id=j.id; room.code=j.code; room._srv=1;
    }catch(e){ return toast(e.message,'err'); }
  }
  if(!isAdmin()){ /* regra da sala única (admins são exceção) */
    DB.data.rooms.filter(r=>r.creator===state.user.email).forEach(r=>delete DB.data.messages[r.id]);
    DB.data.rooms=DB.data.rooms.filter(r=>r.creator!==state.user.email);
  }
  DB.data.rooms.push(room); DB.data.messages[room.id]=[]; DB.save();
  closeModal('roomModal');
  toast('Sala criada! Compartilhe o convite 🎉','ok');
  showShareModal(room);
  enterRoom(room.id);
};
const _closeRoom=window.closeRoom;
window.closeRoom=function(id){ if(SERVER) api('room_close',{id}).catch(()=>{}); _closeRoom(id); };

/* link de convite + WhatsApp */
function roomLink(r){ return location.origin+location.pathname+'?sala='+(r.code||''); }
function showShareModal(r){
  $('shareLink').value=roomLink(r);
  $('shareWa').onclick=()=>window.open('https://wa.me/?text='+encodeURIComponent(
    `Venha treinar comigo no pratica.M3D! 🩺 Sala "${r.name}" — entre pelo link: ${roomLink(r)}`),'_blank');
  openModal('shareModal');
}
window.copyShareLink=function(){
  $('shareLink').select();
  try{ navigator.clipboard.writeText($('shareLink').value); }catch(e){ document.execCommand('copy'); }
  toast('Link copiado! 📋','ok');
};
function checkJoinLink(){
  const code=new URLSearchParams(location.search).get('sala');
  if(!code) return;
  if(state.user) joinRoomByCode(code);
  else { sessionStorage.setItem('pm3d_join',code);
    toast('Você foi convidado(a) para uma sala! Faça login ou cadastre-se para entrar 🚪','ok'); }
}
async function joinRoomByCode(code){
  if(SERVER){
    try{ const j=await api('room_join',{code}); upsertLocalRoom(j.room); DB.save();
      enterRoom(j.room.id); toast('Você entrou na sala! 🎉','ok'); return;
    }catch(e){ return toast(e.message,'err'); }
  }
  const r=DB.data.rooms.find(x=>x.code===code.toUpperCase());
  if(!r) return toast('Sala não encontrada neste dispositivo (modo local)','err');
  if(r.vis==='closed'&&!r.members.includes(state.user.email)&&r.creator!==state.user.email&&!isAdmin()){
    r.members.push(state.user.email); DB.save();
  }
  enterRoom(r.id); toast('Você entrou na sala! 🎉','ok');
}

/* membros: online primeiro, com indicador 🟢 */
window.renderRoomMembers=function(){
  const closed=bpVal('roomVisBP')==='closed';
  $('roomMembersWrap').classList.toggle('hidden',!closed);
  if(!closed) return;
  const on=onlineSet();
  const us=DB.data.users.filter(u=>u.email!==state.user.email&&u.email!==ROOT_EMAIL)
    .sort((a,b)=>(on.has(b.email)?1:0)-(on.has(a.email)?1:0));
  $('roomMembers').innerHTML=us.map(u=>
    `<div class="member-card" data-e="${esc(u.email)}" onclick="this.classList.toggle('sel')">${on.has(u.email)?'🟢':'⚪'} ${esc(u.name)}<div class="small">${esc(u.email)}</div></div>`
  ).join('')||'<span class="small">Cadastre mais usuários para convidar — ou abra sem convidados e compartilhe o link.</span>';
};

/* agregar participantes depois (dentro da sala) */
window.openInviteModal=function(){
  const on=onlineSet();
  $('inviteMembers').innerHTML=DB.data.users
    .filter(u=>u.email!==state.user.email&&u.email!==ROOT_EMAIL)
    .sort((a,b)=>(on.has(b.email)?1:0)-(on.has(a.email)?1:0))
    .map(u=>`<div class="member-card" data-e="${esc(u.email)}" onclick="this.classList.toggle('sel')">${on.has(u.email)?'🟢':'⚪'} ${esc(u.name)}<div class="small">${esc(u.email)}</div></div>`).join('')
    ||'<span class="small">Nenhum outro usuário cadastrado ainda.</span>';
  openModal('inviteModal');
};
window.confirmInvite=async function(){
  const r=DB.data.rooms.find(x=>x.id===state.currentRoom); if(!r) return;
  const sel=[...document.querySelectorAll('#inviteMembers .member-card.sel')].map(x=>x.dataset.e);
  closeModal('inviteModal');
  if(!sel.length) return;
  sel.forEach(e=>{ if(!r.members.includes(e)) r.members.push(e); });
  if(SERVER) await api('room_members_add',{id:r.id,members:sel}).catch(()=>{});
  DB.save(); toast('Participantes agregados à sala 👥','ok');
};

/* ---------- wraps de renderização ---------- */
const _renderRoomList=window.renderRoomList;
window.renderRoomList=function(){
  _renderRoomList();
  document.querySelectorAll('#roomsList .room-card').forEach((card,i)=>{
    const r=DB.data.rooms[i]; if(!r) return;
    const foot=card.querySelector('.foot'); if(!foot||foot.querySelector('.shareBtn')) return;
    const b=document.createElement('button');
    b.className='ghost shareBtn'; b.style.padding='6px 10px'; b.textContent='📤 Convite';
    b.onclick=()=>showShareModal(r);
    foot.insertBefore(b,foot.firstChild);
  });
};
const _renderRoomView=window.renderRoomView;
window.renderRoomView=function(){
  _renderRoomView();
  const r=DB.data.rooms.find(x=>x.id===state.currentRoom); if(!r) return;
  /* botões compartilhar / convidar no cabeçalho da sala */
  const hdr=document.querySelector('#view-sala > div:first-child > div');
  if(hdr&&!$('roomShareBtn')){
    const s=document.createElement('button'); s.id='roomShareBtn'; s.className='sky';
    s.style.padding='6px 12px'; s.textContent='📤 Compartilhar'; s.onclick=()=>showShareModal(r);
    const iv=document.createElement('button'); iv.id='roomInviteBtn'; iv.className='violet';
    iv.style.padding='6px 12px'; iv.textContent='➕ Convidar'; iv.onclick=openInviteModal;
    hdr.insertBefore(iv,hdr.firstChild); hdr.insertBefore(s,iv);
  }
  if($('roomInviteBtn')) $('roomInviteBtn').style.display=(r.creator===state.user.email||isAdmin())?'':'none';
  /* troca da estação ativa (multi-estações, criador/admin) */
  if((r.stationIds||[]).length>1 && (r.creator===state.user.email||isAdmin())){
    let sw=$('roomStationSwitch');
    if(!sw){ sw=document.createElement('div'); sw.id='roomStationSwitch';
      $('roomScenario').parentElement.insertBefore(sw,$('roomScenario')); }
    sw.className='boxpick'; sw.style.marginBottom='10px';
    sw.innerHTML='<span class="small" style="width:100%">Estações da sala — o criador alterna a ativa:</span>'+
      r.stationIds.map(id=>{ const s=allStations().find(x=>x.id===id);
        return s?`<div class="bx ${id===r.stationId?'sel':''}" data-v="${id}">${esc(s.tema)}</div>`:''; }).join('');
    sw.querySelectorAll('.bx').forEach(b=>b.onclick=()=>{
      r.stationId=b.dataset.v; DB.save();
      if(SERVER) api('room_update',{id:r.id,stationId:r.stationId}).catch(()=>{});
      renderRoomView();
    });
  } else if($('roomStationSwitch')) $('roomStationSwitch').remove();
};

/* ---------- CORREÇÃO COM IA (toggle ao lado de ▶ Iniciar) ---------- */
function injectAIToggles(){
  ['sm','room'].forEach(ctx=>{
    if($('aiTog-'+ctx)) return;
    const startBtn=[...document.querySelectorAll('button')]
      .find(b=>(b.getAttribute('onclick')||'').includes("timerStart('"+ctx+"')"));
    if(!startBtn) return;
    const t=document.createElement('button');
    t.id='aiTog-'+ctx; t.className='ghost ai-toggle'; t.style.cssText='padding:8px 12px;font-size:12px';
    t.textContent='🤖 Correção IA: OFF';
    t.onclick=()=>{
      state.aiCorrect[ctx]=!state.aiCorrect[ctx];
      t.textContent='🤖 Correção IA: '+(state.aiCorrect[ctx]?'ON 🎙':'OFF');
      t.classList.toggle('on',state.aiCorrect[ctx]);
      t.className=state.aiCorrect[ctx]?'violet ai-toggle on':'ghost ai-toggle';
      toast(state.aiCorrect[ctx]
        ?'Correção IA ativada — ao iniciar, o áudio da estação (médico e ator) será transcrito e pontuado no PEP'
        :'Correção IA desativada — pontuação manual','ok');
    };
    startBtn.parentElement.insertBefore(t,startBtn.nextSibling);
  });
}
function startRec(ctx){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ toast('Reconhecimento de voz não suportado neste navegador — use Chrome/Edge','err'); state.aiCorrect[ctx]=false; return; }
  stopRec(ctx);
  const rec=new SR(); rec.lang='pt-BR'; rec.continuous=true; rec.interimResults=false;
  transcripts[ctx]=transcripts[ctx]||'';
  rec.onresult=e=>{ for(let i=e.resultIndex;i<e.results.length;i++)
    if(e.results[i].isFinal) transcripts[ctx]+=e.results[i][0].transcript.trim()+'\n'; };
  rec.onend=()=>{ if(recogs[ctx]&&recogs[ctx]._on){ try{rec.start();}catch(e){} } };
  rec._on=true;
  try{ rec.start(); recogs[ctx]=rec; toast('🎙 Gravando áudio da estação para a correção IA…','ok'); }catch(e){}
}
function stopRec(ctx){ const r=recogs[ctx]; if(r){ r._on=false; try{r.stop();}catch(e){} delete recogs[ctx]; } }

const _timerStart=window.timerStart;
window.timerStart=function(ctx){ _timerStart(ctx); if(state.aiCorrect&&state.aiCorrect[ctx]) startRec(ctx); };
const _timerPause=window.timerPause;
window.timerPause=function(ctx){ _timerPause(ctx); stopRec(ctx); };

/* finalização: se a correção IA estiver ligada e houver transcrição, a IA pontua o PEP */
const _finishStation=window.finishStation;
window.finishStation=function(ctx){
  const s=state.currentStation;
  const tr=(transcripts[ctx]||'').trim();
  const useAI=state.aiCorrect&&state.aiCorrect[ctx]&&tr.length>10&&s;
  stopRec(ctx);
  if(!useAI){
    _finishStation(ctx);
    if(SERVER&&state.history.length) api('history_add',state.history[state.history.length-1]).catch(()=>{});
    return;
  }
  (async()=>{
    const tot=s.checklist.reduce((a,c)=>a+c.pts,0);
    toast('🤖 IA analisando a transcrição contra o PEP…');
    try{
      const chk=s.checklist.map((c,i)=>`${i+1}. (${c.pts} pts) ${c.text}`).join('\n');
      const txt=await callAI(
`Você é avaliador OSCE/Revalida (padrão INEP). Abaixo estão o PEP (Padrão Esperado de Procedimento) e a transcrição do áudio da estação (falas do médico e do ator/paciente).
Para CADA item do PEP, determine se o elemento foi citado ou realizado pelo médico EM CONTEXTO VÁLIDO (menção fora de contexto NÃO pontua).
Responda SOMENTE JSON válido, sem markdown:
{"items":[{"i":1,"ok":true,"just":"trecho/motivo"}],"fortes":["..."],"fracos":["..."],"sugestoes":["..."],"resumo":"..."}

PEP:
${chk}

TRANSCRIÇÃO:
${tr}`);
      const j=extractJSON(txt);
      if(!j||!Array.isArray(j.items)||!j.items.length) throw new Error('resposta inválida da IA');
      s._score={};
      j.items.forEach(it=>{ if(it.i>=1&&it.i<=s.checklist.length) s._score[it.i-1]=it.ok?1:0; });
      const got=s.checklist.reduce((a,c,i)=>a+(s._score[i]?c.pts:0),0);
      const pct=tot?Math.round(got/tot*100):0;
      const timeUsed=(s.duracao*60)-(timers[ctx]?.left||0);
      const review={items:j.items,fortes:j.fortes||[],fracos:j.fracos||[],sugestoes:j.sugestoes||[],resumo:j.resumo||''};
      state.history.push({area:s.area,tema:s.tema,pct,got,tot,timeUsed,date:Date.now(),ai:1,
        room:DB.data.rooms.find(r=>r.id===state.currentRoom)?.name||null,transcript:tr.slice(0,8000),review});
      saveUserLS();
      if(SERVER) api('history_add',state.history[state.history.length-1]).catch(()=>{});
      if($(ctx+'Checklist')){ /* reflete a correção no checklist da tela */
        j.items.forEach(it=>{ const el=$('ck-'+ctx+'-'+(it.i-1));
          if(el){ el.classList.remove('done','miss'); el.classList.add(it.ok?'done':'miss'); } });
        updateScore(ctx);
      }
      renderDashboard();
      openReviewCard(state.history[state.history.length-1],s);
      toast(`Correção IA concluída: ${pct}% 🎯`,'ok');
      transcripts[ctx]='';
    }catch(e){
      toast('IA falhou ('+e.message+') — usando correção manual','err');
      _finishStation(ctx);
    }
  })();
};

/* ---------- CARD DE REVISÃO DIDÁTICO ---------- */
window.openReviewCard=function(h,s){
  s=s||allStations().find(x=>x.tema===h.tema)||{tema:h.tema,area:h.area,checklist:[]};
  const rv=h.review||{};
  const rows=(s.checklist||[]).map((c,i)=>{
    const it=(rv.items||[]).find(x=>x.i===i+1);
    return `<tr><td style="text-align:center">${it?(it.ok?'✅':'❌'):'—'}</td>
      <td>${esc(c.text)}</td><td class="small">${esc(it?.just||'')}</td></tr>`;
  }).join('');
  $('reviewBody').innerHTML=`
   <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
     <div><span class="badge ${h.area}">${h.area}</span> <b style="font-size:17px">${esc(h.tema)}</b>
       <div class="small">${new Date(h.date).toLocaleString('pt-BR')}${h.ai?' · 🤖 correção por IA':''}${h.room?' · 🚪 '+esc(h.room):''}</div></div>
     <div style="text-align:center"><div style="font-size:34px;font-weight:900;color:${h.pct>=70?'#65a30d':h.pct>=50?'#d97706':'#dc2626'}">${h.pct}%</div>
       <div class="small">desempenho no PEP</div></div>
   </div>
   ${rv.resumo?`<p style="background:#f0fdfa;border:2px dashed var(--teal3);border-radius:12px;padding:10px;font-size:13px">${esc(rv.resumo)}</p>`:''}
   <div class="row">
     <div class="rev-box ok"><h4>💪 Pontos fortes</h4><ul>${(rv.fortes||[]).map(f=>`<li>${esc(f)}</li>`).join('')||'<li class="small">—</li>'}</ul></div>
     <div class="rev-box bad"><h4>⚠️ Pontos a desenvolver</h4><ul>${(rv.fracos||[]).map(f=>`<li>${esc(f)}</li>`).join('')||'<li class="small">—</li>'}</ul></div>
   </div>
   <div class="rev-box tip"><h4>💡 Sugestões de conduta para a próxima performance</h4>
     <ul>${(rv.sugestoes||[]).map(f=>`<li>${esc(f)}</li>`).join('')||'<li class="small">—</li>'}</ul></div>
   ${rows?`<h4 style="margin:14px 0 6px">📋 PEP — item a item</h4><table class="rev-table"><tbody>${rows}</tbody></table>`:''}
   <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
     <button class="amber" onclick="printReview()">🖨 Imprimir / PDF</button>
     <button class="ghost" onclick="closeModal('reviewModal')">Fechar</button>
   </div>`;
  openModal('reviewModal');
};
window.printReview=function(){
  const w=window.open('','_blank');
  w.document.write('<html><head><meta charset="utf-8"><title>Revisão — pratica.M3D</title>'+
    '<style>body{font-family:system-ui,sans-serif;color:#134e4a;padding:24px}ul{margin:6px 0}'+
    'table{border-collapse:collapse;width:100%}td{border:1px solid #99f6e4;padding:6px;font-size:12px;vertical-align:top}</style></head><body>'+
    $('reviewBody').innerHTML.replace(/<button[\s\S]*?<\/button>/g,'')+'</body></html>');
  w.document.close(); w.print();
};
/* a partir do histórico: abre o card salvo ou gera um novo com IA */
window.openReviewOrGenerate=async function(idx){
  const h=state.history[idx]; if(!h) return;
  if(h.review) return openReviewCard(h);
  toast('🤖 Gerando card de revisão didático…');
  try{
    const txt=await callAI(
`Você é preceptor do Exame Revalida. O candidato realizou a estação "${h.tema}" (${h.area}) e obteve ${h.pct}% no PEP.
Gere um card de revisão didático em JSON válido, sem markdown:
{"fortes":["..."],"fracos":["..."],"sugestoes":["..."],"resumo":"..."}
Liste pontos fortes prováveis, pontos fracos prováveis e sugestões práticas de conduta durante a performance que ajudariam a superar as dificuldades desta estação.`);
    const j=extractJSON(txt)||{};
    h.review={fortes:j.fortes||[],fracos:j.fracos||[],sugestoes:j.sugestoes||[],resumo:j.resumo||'',items:[]};
    saveUserLS();
    if(SERVER) api('history_add',h).catch(()=>{});
    openReviewCard(h);
  }catch(e){ toast('IA falhou: '+e.message,'err'); }
};
const _renderDashboard=window.renderDashboard;
window.renderDashboard=function(){
  _renderDashboard();
  const n=state.history.length;
  document.querySelectorAll('#histList > div').forEach((row,j)=>{
    const idx=n-1-j; const h=state.history[idx];
    if(!h||row.querySelector('.revBtn')) return;
    const b=document.createElement('button');
    b.className='sky revBtn'; b.style.cssText='padding:4px 10px;font-size:11px';
    b.textContent=h.review?'🗂 Revisão':'🗂 Gerar revisão';
    b.onclick=()=>openReviewOrGenerate(idx);
    row.appendChild(b);
  });
};

/* gestão de admins também no servidor */
const _makeAdmin=window.makeAdmin, _revokeAdmin=window.revokeAdmin, _delUser=window.delUser;
window.makeAdmin=function(e){ _makeAdmin(e); if(SERVER) api('set_role',{email:e,role:'admin'}).catch(()=>{}); };
window.revokeAdmin=function(e){ _revokeAdmin(e); if(SERVER) api('set_role',{email:e,role:'user'}).catch(()=>{}); };
window.delUser=function(e){ _delUser(e); if(SERVER) api('del_user',{email:e}).catch(()=>{}); };

/* ---------- boot da camada de servidor ---------- */
(async function initServer(){
  try{ const j=await api('ping'); SERVER=!!j.ok; }catch(e){ SERVER=false; }
  if(SERVER&&apiToken&&!state.user){
    try{
      const j=await api('me',{});
      let u=DB.data.users.find(x=>x.email===j.user.email);
      if(!u){ u={name:j.user.name,email:j.user.email,pass:'',role:j.user.role,created:Date.now(),_srv:1}; DB.data.users.push(u); DB.save(); }
      state.user=u; state.token='Bearer '+apiToken;
      sessionStorage.setItem('praticaM3D_session',JSON.stringify({email:u.email,token:state.token}));
      await enterApp();
    }catch(e){ localStorage.removeItem('pm3d_token'); apiToken=null; }
  }
  if(SERVER){
    setInterval(pullServerData,8000);
    setInterval(serverHeartbeat,8000);
    setTimeout(()=>toast(SERVER?'☁️ Conectado ao servidor PHP/SQLite — seus dados ficam salvos no servidor':'','ok'),1200);
  }
  injectAIToggles();
  checkJoinLink();
})();

/* ============================================================
   MÓDULO v2 — 📹 Videochamada WebRTC P2P · 🃏 cards compartilháveis
   😀 reações com emoji · 👥 modo colaborativo (chefe/espectador)
   📋 resumo final da sessão · roteamento por papel
   Sinalização: servidor (api.php) → localStorage (abas locais) →
   manual copiar/colar SDP. STUN: stun.l.google.com
============================================================ */
(function(){
'use strict';
const RTC_CFG={iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]};
const EMOJIS=['😀','😂','🤣','😊','😍','🤔','😅','😭','🤯','😴','👍','👎','👏','🙏','💪','🔥','❤️','💚','🎉','✨','✅','❌','⚠️','🩺','💊','🧪','🫀','🧠','📋','🃏','⭐'];
const REACTS=['👍','❤️','😂','👏','🔥','😮'];
const CARD_CATS=[{v:'anamnese',l:'🗣 Anamnese'},{v:'exame',l:'🩺 Exame físico'},{v:'exames',l:'🧪 Exames compl.'},{v:'conduta',l:'💊 Conduta'},{v:'comunicacao',l:'💬 Comunicação'},{v:'geral',l:'🎯 Geral'}];
const peers={}; let localStream=null, screenOn=false, micOn=true, camOn=true, inCall=false;
let sigSince=0, evSince=0, pollIv=null, pollRoom=null, manualN=0;
const seenEv=new Set(); let roomCards=[];

/* ---------- estilos + modais (sinal manual / card / resumo / emoji) ---------- */
document.body.insertAdjacentHTML('beforeend',`
<style>
.rtc-panel{background:var(--panel);border:2px solid var(--line);border-radius:14px;padding:10px;margin-bottom:12px}
.rtc-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:800;color:var(--deep);margin-bottom:8px;flex-wrap:wrap}
.rtc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.rtc-tile{position:relative;background:#0f172a;border-radius:12px;overflow:hidden;aspect-ratio:4/3;border:2px solid var(--line)}
.rtc-tile video{width:100%;height:100%;object-fit:cover;display:block}
.rtc-tile .lb{position:absolute;left:6px;bottom:6px;background:rgba(15,118,110,.85);color:#fff;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px}
.rtc-tile.local{order:-1;border-color:var(--teal2)}
.rtc-bar{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.rtc-bar button{padding:7px 11px;font-size:12px}
.card-chip{border:2px solid var(--line);border-left:6px solid var(--violet);border-radius:12px;padding:8px 10px;margin:6px 0;background:#faf5ff;font-size:13px;animation:msgin .25s}
.big-emo{font-size:30px;line-height:1}
.msg.react{background:transparent;border:none;padding:2px 8px}
#emojiPick{position:fixed;right:18px;bottom:78px;background:#fff;border:2px solid var(--teal2);border-radius:18px;padding:12px;width:min(330px,92vw);z-index:400;box-shadow:0 20px 60px rgba(13,148,136,.35);animation:pop .25s}
#emojiPick .eg{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;max-height:180px;overflow:auto}
#emojiPick .eg span{font-size:22px;cursor:pointer;text-align:center;padding:3px;border-radius:8px;transition:transform .15s}
#emojiPick .eg span:hover{transform:scale(1.3);background:#f0fdfa}
#emojiPick .rr{display:flex;gap:6px;border-top:2px dashed var(--line);margin-top:8px;padding-top:8px}
#emojiPick .rr span{font-size:22px;cursor:pointer;transition:transform .15s}
#emojiPick .rr span:hover{transform:scale(1.35)}
.sum-sec{border:2px solid var(--line);border-radius:14px;padding:12px;margin-top:10px;background:#fff}
.sum-sec h4{margin:0 0 6px;font-size:14px;color:var(--deep)}
</style>
<div id="sigModal" class="modal-bg hidden" onclick="if(event.target===this)closeModal('sigModal')">
  <div class="modal"><h2>📋 Sinalização manual (copiar/colar SDP)</h2>
    <p class="small">Fallback P2P quando servidor e abas não conectam: um lado gera a <b>oferta</b>, o outro cola o bloco e devolve a <b>resposta</b> (troque por WhatsApp/e-mail). Aguarde ~4s após gerar para reunir os candidatos ICE.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="manualOffer()">1️⃣ Gerar oferta</button>
      <button class="violet" onclick="manualHandle()">2️⃣ Processar bloco colado</button>
      <button class="ghost" onclick="closeModal('sigModal')">Fechar</button>
    </div>
    <div class="field" style="margin-top:10px"><label>Cole aqui o bloco recebido (oferta ou resposta)</label><textarea id="sigIn" placeholder="Cole o bloco do colega..."></textarea></div>
    <div class="field"><label>Seu bloco para enviar ao colega</label><textarea id="sigOut" readonly onclick="this.select()"></textarea></div>
  </div>
</div>
<div id="cardModal" class="modal-bg hidden" onclick="if(event.target===this)closeModal('cardModal')">
  <div class="modal" style="max-width:560px"><h2>🃏 Enviar card de auxílio ao candidato</h2>
    <p class="small">O card aparece em tempo real para todos na sala (avaliação formativa) e entra no resumo final da sessão.</p>
    <div class="field"><label>Categoria (modalidade)</label><div id="cardCatBP"></div></div>
    <div class="field"><label>Texto do card</label><textarea id="cardText" placeholder="Ex.: Pergunte sobre irradiação da dor e fatores de melhora/piora..."></textarea></div>
    <div style="display:flex;gap:8px"><button class="violet" onclick="sendCard()">Compartilhar na sala 🃏</button>
    <button class="ghost" onclick="closeModal('cardModal')">Cancelar</button></div>
  </div>
</div>
<div id="summaryModal" class="modal-bg hidden" onclick="if(event.target===this)closeModal('summaryModal')">
  <div class="modal"><h2 style="margin-top:0">📋 Resumo final da sessão</h2><div id="summaryBody"></div></div>
</div>
<div id="emojiPick" class="hidden"></div>`);

/* ---------- painéis de vídeo + cards na sala ---------- */
const _sp=document.querySelector('#view-sala .sidepanel');
if(_sp) _sp.insertAdjacentHTML('afterbegin',`
<div id="rtcPanel" class="rtc-panel hidden">
  <div class="rtc-head">📹 Videochamada da sala <span id="rtcStatus" class="small"></span></div>
  <div id="rtcGrid" class="rtc-grid"></div>
  <div class="rtc-bar">
    <button id="rtcJoinBtn" onclick="rtcJoin()">📹 Entrar</button>
    <button class="ghost" onclick="rtcMic()" title="Microfone">🎤</button>
    <button class="ghost" onclick="rtcCam()" title="Câmera">📷</button>
    <button class="ghost" onclick="rtcScreen()" title="Compartilhar tela">🖥</button>
    <button class="sky" onclick="openModal('sigModal')" title="Sinalização manual copiar/colar SDP">📋 Sinal manual</button>
    <button class="danger" onclick="rtcLeave()">🔴 Sair</button>
  </div>
</div>
<div id="cardsPanel" class="rtc-panel hidden">
  <div class="rtc-head">🃏 Cards de auxílio compartilhados
    <button id="cardSendBtn" class="violet" style="padding:6px 12px;font-size:12px" onclick="openCardModal()">＋ Enviar card</button></div>
  <div id="cardsList"></div>
</div>`);

/* ---------- botões 😀 nos chats ---------- */
document.querySelectorAll('.chat .inp').forEach(inp=>{
  const isRoom=!!inp.querySelector('#roomChatInput');
  const b=document.createElement('button'); b.className='ghost'; b.type='button'; b.textContent='😀';
  b.onclick=()=>toggleEmoji(isRoom?'roomChatInput':'lobbyInput');
  inp.insertBefore(b,inp.lastElementChild);
});
function toggleEmoji(inpId){
  const p=$('emojiPick');
  if(!p.classList.contains('hidden')&&p._inp===inpId){ p.classList.add('hidden'); return; }
  p._inp=inpId;
  p.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center"><b>😀 Emojis</b><button class="ghost" style="padding:3px 9px" onclick="$(\'emojiPick\').classList.add(\'hidden\')">✕</button></div>'+
    '<div class="eg">'+EMOJIS.map(e=>`<span onclick="emojiInto('${inpId}','${e}')">${e}</span>`).join('')+'</div>'+
    (inpId==='roomChatInput'?'<div class="rr"><span class="small" style="align-self:center">Reação rápida:</span>'+REACTS.map(e=>`<span onclick="sendReact('${e}')">${e}</span>`).join('')+'</div>':'');
  p.classList.remove('hidden');
}
window.emojiInto=function(inpId,e){ const i=$(inpId); if(i){ i.value+=e; i.focus(); } };
window.toggleEmoji=toggleEmoji;
window.sendReact=function(e){ $('emojiPick').classList.add('hidden'); evPush('react',{emoji:e}); };

/* ---------- transporte de sinalização ---------- */
function sigSend(kind,payload,dst){
  if(!state.currentRoom) return;
  if(SERVER){ api('signal_send',{room:state.currentRoom,kind,payload,dst:dst||null}).catch(()=>{}); }
  else{ const k='pm3d_sig_'+state.currentRoom;
    const arr=JSON.parse(localStorage.getItem(k)||'[]');
    arr.push({id:Date.now()+Math.random(),src:state.user.email,name:state.user.name,kind,payload,dst:dst||null,ts:Date.now()});
    localStorage.setItem(k,JSON.stringify(arr.slice(-400))); }
}
async function sigPoll(){
  if(!state.currentRoom) return;
  if(SERVER){ try{ const j=await api('signal_poll',{room:state.currentRoom,since:sigSince});
    (j.signals||[]).forEach(s=>{ if(s.id>sigSince){ sigSince=s.id; handleSig(s); } }); }catch(e){} }
  else{ const arr=JSON.parse(localStorage.getItem('pm3d_sig_'+state.currentRoom)||'[]');
    arr.forEach(s=>{ if(s.id>sigSince){ sigSince=s.id; if(s.src!==state.user.email&&(!s.dst||s.dst===state.user.email)) handleSig(s); } }); }
}
async function handleSig(s){
  try{
    if(s.kind==='hello'){ if(inCall){ makePeer(s.src,s.name); makeOffer(s.src); } }
    else if(s.kind==='offer'){ const P=makePeer(s.src,s.name);
      await P.pc.setRemoteDescription(s.payload.sdp);
      const a=await P.pc.createAnswer(); await P.pc.setLocalDescription(a);
      sigSend('answer',{sdp:P.pc.localDescription},s.src); }
    else if(s.kind==='answer'){ const P=peers[s.src]; if(P) await P.pc.setRemoteDescription(s.payload.sdp); }
    else if(s.kind==='ice'){ const P=peers[s.src]; if(P&&s.payload.cand) await P.pc.addIceCandidate(s.payload.cand).catch(()=>{}); }
    else if(s.kind==='bye'){ dropPeer(s.src); }
  }catch(e){}
}

/* ---------- engine WebRTC (mesh P2P) ---------- */
function makePeer(remote,label){
  if(peers[remote]) return peers[remote];
  const pc=new RTCPeerConnection(RTC_CFG);
  const P={pc,label:label||remote}; peers[remote]=P;
  if(localStream) localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  else{ try{ pc.addTransceiver('video',{direction:'recvonly'}); pc.addTransceiver('audio',{direction:'recvonly'}); }catch(e){} }
  pc.onicecandidate=e=>{ if(e.candidate) sigSend('ice',{cand:e.candidate},remote); };
  pc.ontrack=e=>attachTile(remote,P.label,e.streams[0],false);
  pc.onconnectionstatechange=()=>{ if(['failed','disconnected','closed'].includes(pc.connectionState)) dropPeer(remote); };
  return P;
}
async function makeOffer(dst){
  const P=makePeer(dst); try{ const o=await P.pc.createOffer(); await P.pc.setLocalDescription(o);
    sigSend('offer',{sdp:P.pc.localDescription},dst); }catch(e){}
}
function attachTile(id,label,stream,local){
  let t=$('tile-'+CSS.escape(id));
  if(!t){ const g=$('rtcGrid'); if(!g) return;
    g.insertAdjacentHTML('beforeend',`<div class="rtc-tile ${local?'local':''}" id="tile-${esc(id)}"><video autoplay playsinline ${local?'muted':''}></video><span class="lb">${local?'🙋 Você':'🎥 '+esc(label)}</span></div>`);
    t=$('tile-'+CSS.escape(id)); }
  const v=t.querySelector('video'); if(v.srcObject!==stream) v.srcObject=stream;
}
function dropPeer(id){ const P=peers[id]; if(P){ try{P.pc.close()}catch(e){} delete peers[id]; }
  const t=$('tile-'+CSS.escape(id)); if(t) t.remove(); }
function rtcStatus(t){ const el=$('rtcStatus'); if(el) el.textContent=t; }

window.rtcJoin=async function(){
  if(inCall) return toast('Você já está na chamada 📹','ok');
  try{ localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true}); }
  catch(e){ try{ localStream=await navigator.mediaDevices.getUserMedia({audio:true});
      toast('Sem câmera — entrando só com áudio 🎤','err'); }
    catch(e2){ localStream=null; toast('Sem mídia — você assiste a chamada (recv-only) 👀','err'); } }
  inCall=true; micOn=camOn=true;
  if(localStream) attachTile(state.user.email,'',localStream,true);
  rtcStatus('conectando…');
  sigSend('hello',{name:state.user.name,role:state.myRoomRole});
  rtcStatus(Object.keys(peers).length?'na chamada ✅':'aguardando participantes…');
  setTimeout(()=>rtcStatus(Object.keys(peers).length?'na chamada ✅':'aguardando participantes…'),3000);
};
window.rtcLeave=function(){
  if(!inCall&&!Object.keys(peers).length) return;
  sigSend('bye',{}); inCall=false;
  Object.keys(peers).forEach(dropPeer);
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  const t=$('tile-'+CSS.escape(state.user.email)); if(t) t.remove();
  screenOn=false; rtcStatus('chamada encerrada');
};
window.rtcMic=function(){ if(!localStream) return; micOn=!micOn;
  localStream.getAudioTracks().forEach(t=>t.enabled=micOn); toast(micOn?'🎤 Microfone ligado':'🎤 Microfone mudo'); };
window.rtcCam=function(){ if(!localStream) return; camOn=!camOn;
  localStream.getVideoTracks().forEach(t=>t.enabled=camOn); toast(camOn?'📷 Câmera ligada':'📷 Câmera desligada'); };
window.rtcScreen=async function(){
  if(!inCall) return toast('Entre na chamada primeiro 📹','err');
  try{
    if(!screenOn){ const scr=await navigator.mediaDevices.getDisplayMedia({video:true});
      const tr=scr.getVideoTracks()[0];
      Object.values(peers).forEach(P=>{ const s=P.pc.getSenders().find(x=>x.track&&x.track.kind==='video'); if(s) s.replaceTrack(tr); });
      const lt=$('tile-'+CSS.escape(state.user.email))?.querySelector('video'); if(lt) lt.srcObject=scr;
      tr.onended=()=>rtcScreen(); screenOn=true; toast('🖥 Compartilhando tela');
    } else { const cam=localStream?.getVideoTracks()[0]; if(cam){
        Object.values(peers).forEach(P=>{ const s=P.pc.getSenders().find(x=>x.track&&x.track.kind==='video'); if(s) s.replaceTrack(cam); });
        const lt=$('tile-'+CSS.escape(state.user.email))?.querySelector('video'); if(lt) lt.srcObject=localStream; }
      screenOn=false; toast('🖥 Compartilhamento encerrado'); }
  }catch(e){ toast('Não foi possível compartilhar a tela','err'); }
};

/* ---------- sinalização manual (copiar/colar SDP) ---------- */
const b64e=o=>btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const b64d=s=>{ s=(s||'').trim(); try{ return JSON.parse(decodeURIComponent(escape(atob(s)))); }catch(e){ return JSON.parse(s); } };
const waitIce=pc=>pc.iceGatheringState==='complete'?Promise.resolve():
  new Promise(res=>{ const t=setTimeout(res,4000);
    pc.addEventListener('icegatheringstatechange',()=>{ if(pc.iceGatheringState==='complete'){ clearTimeout(t); res(); } }); });
window.manualOffer=async function(){
  const key='manual-'+(++manualN); const P=makePeer(key,'colega (manual)');
  const o=await P.pc.createOffer(); await P.pc.setLocalDescription(o); await waitIce(P.pc);
  $('sigOut').value=b64e({key,sdp:P.pc.localDescription});
  toast('Oferta gerada! Envie o bloco ao colega e cole a resposta dele aqui 📋','ok');
};
window.manualHandle=async function(){
  try{ const bl=b64d($('sigIn').value);
    if(bl.sdp?.type==='offer'){ const key=bl.key||('manual-'+(++manualN)); const P=makePeer(key,'colega (manual)');
      await P.pc.setRemoteDescription(bl.sdp);
      const a=await P.pc.createAnswer(); await P.pc.setLocalDescription(a); await waitIce(P.pc);
      $('sigOut').value=b64e({key,sdp:P.pc.localDescription});
      toast('Resposta gerada! Devolva o bloco a quem enviou a oferta 📋','ok');
    } else if(bl.sdp?.type==='answer'){ const P=peers[bl.key]||peers['manual-'+manualN];
      if(!P) throw new Error('nenhuma oferta aguardando resposta');
      await P.pc.setRemoteDescription(bl.sdp); inCall=true;
      toast('Conectado por sinalização manual ✅','ok'); closeModal('sigModal');
    } else throw new Error('bloco não reconhecido');
  }catch(e){ toast('Bloco inválido: '+e.message,'err'); }
};

/* ---------- eventos da sala (cards + reações) ---------- */
function evPush(kind,payload){
  if(!state.currentRoom) return;
  payload.cid=uid('ev'); seenEv.add(payload.cid);
  const ev={cid:payload.cid,email:state.user.email,name:state.user.name,kind,payload,ts:Date.now()};
  DB.data.roomEvents=DB.data.roomEvents||{};
  (DB.data.roomEvents[state.currentRoom]=DB.data.roomEvents[state.currentRoom]||[]).push(ev);
  if(DB.data.roomEvents[state.currentRoom].length>500) DB.data.roomEvents[state.currentRoom]=DB.data.roomEvents[state.currentRoom].slice(-300);
  DB.save();
  if(SERVER) api('room_event',{room:state.currentRoom,kind,payload}).catch(()=>{});
  ingestEv(ev);
}
async function evPoll(){
  if(!SERVER||!state.currentRoom) return;
  try{ const j=await api('room_events',{room:state.currentRoom,since:evSince});
    (j.events||[]).forEach(e=>{ if(e.id>evSince) evSince=e.id;
      const cid=e.payload?.cid; if(cid&&seenEv.has(cid)) return; if(cid) seenEv.add(cid);
      ingestEv({email:e.email,name:e.name,kind:e.kind,payload:e.payload||{}}); });
  }catch(e){}
}
function ingestEv(e){
  if(e.kind==='card'){ if(!roomCards.find(c=>c.cid===e.payload.cid)) roomCards.push(e.payload); renderCards(); }
  if(e.kind==='react'){ const box=$('roomChatMsgs');
    if(box){ box.insertAdjacentHTML('beforeend',`<div class="msg them react"><span class="who">${esc(e.name||'')}</span><span class="big-emo">${esc(e.payload.emoji||'')}</span></div>`);
      box.scrollTop=box.scrollHeight; } }
}
function currentCards(){
  const local=(DB.data.roomEvents?.[state.currentRoom]||[]).filter(e=>e.kind==='card').map(e=>e.payload);
  const all=roomCards.slice();
  local.forEach(p=>{ if(p.cid&&!all.find(x=>x.cid===p.cid)) all.push(p); });
  return all;
}
function renderCards(){
  const el=$('cardsList'); if(!el) return;
  const cs=currentCards().filter(c=>!c.stationId||c.stationId===state.currentStation?.id);
  el.innerHTML=cs.length? cs.map(c=>`<div class="card-chip"><b>${esc((CARD_CATS.find(x=>x.v===c.cat)||{}).l||'🎯 Geral')}</b> ${esc(c.text)}<div class="small">por ${esc(c.by||'')} · ${new Date(c.ts||Date.now()).toLocaleTimeString('pt-BR')}</div></div>`).join('')
    : '<span class="small">Nenhum card ainda — avaliador/chefe podem enviar dicas ao candidato em tempo real.</span>';
}
function replayReacts(){
  const box=$('roomChatMsgs'); if(!box) return;
  const evs=(DB.data.roomEvents?.[state.currentRoom]||[]).filter(e=>e.kind==='react').slice(-30);
  evs.forEach(e=>box.insertAdjacentHTML('beforeend',`<div class="msg them react"><span class="who">${esc(e.name||'')}</span><span class="big-emo">${esc(e.payload.emoji||'')}</span></div>`));
  box.scrollTop=box.scrollHeight;
}

/* ---------- UI: enviar card ---------- */
window.openCardModal=function(){
  boxPick('cardCatBP',CARD_CATS.map(c=>({v:c.v,l:c.l})),'geral');
  $('cardText').value=''; openModal('cardModal');
};
window.sendCard=function(){
  const text=$('cardText').value.trim(); if(!text) return toast('Escreva o texto do card','err');
  evPush('card',{cat:bpVal('cardCatBP'),text,by:state.user.name,role:state.myRoomRole,
    stationId:state.currentStation?.id||null,stationTema:state.currentStation?.tema||'',ts:Date.now()});
  closeModal('cardModal'); toast('Card compartilhado com a sala 🃏','ok');
};

/* ---------- roteamento por papel + painéis ---------- */
const _scen=window.scenarioHTML;
window.scenarioHTML=function(s,canSee){ return _scen(s,canSee||state.myRoomRole==='chefe'); };

const _rrv2=window.renderRoomView;
window.renderRoomView=function(){
  _rrv2();
  const r=DB.data.rooms.find(x=>x.id===state.currentRoom); if(!r) return;
  const role=state.myRoomRole, tag=$('roomRoleTag');
  if(role==='chefe'){ tag.className='role-pill chefe'; tag.textContent='👑 Chefe · colaborativo'; }
  if(role==='espectador'){ tag.className='role-pill esp'; tag.textContent='👀 Espectador'; }
  $('rtcPanel')?.classList.remove('hidden');
  $('cardsPanel')?.classList.remove('hidden');
  if($('rtcJoinBtn')) $('rtcJoinBtn').textContent=role==='espectador'?'📹 Assistir chamada':'📹 Entrar';
  const canSend=role==='ator'||role==='chefe'||r.creator===state.user.email||isAdmin();
  if($('cardSendBtn')) $('cardSendBtn').style.display=canSend?'':'none';
  if(role==='espectador'){
    document.querySelectorAll('#roomChecklist .ck-acts').forEach(x=>x.style.display='none');
    [...document.querySelectorAll('#view-sala .sidepanel > button')].filter(b=>b.textContent.includes('Finalizar')).forEach(b=>b.classList.add('hidden'));
  }
  renderCards(); replayReacts();
  if(pollRoom!==state.currentRoom){ sigSince=0; evSince=0; pollRoom=state.currentRoom; }
  if(!pollIv) pollIv=setInterval(()=>{ sigPoll(); evPoll(); },2500);
};

/* criador/papéis ativos entram direto na videochamada com as ferramentas */
const _arp=window.afterRolePick;
window.afterRolePick=function(){
  _arp();
  const role=state.myRoomRole;
  if(role==='medico'||role==='ator'||role==='chefe') setTimeout(()=>rtcJoin(),500);
  else if(role==='espectador') toast('Você entrou como espectador 👀 — toque em "Assistir chamada" para ver ao vivo','ok');
};

const _lr=window.leaveRoom;
window.leaveRoom=function(){ rtcLeave(); if(pollIv){ clearInterval(pollIv); pollIv=null; } pollRoom=null; _lr(); };
const _cr=window.closeRoom;
window.closeRoom=function(id){ if(id===state.currentRoom){ rtcLeave(); if(pollIv){ clearInterval(pollIv); pollIv=null; } pollRoom=null; } _cr(id); };

/* ---------- resumo final completo ---------- */
window.openSummary=function(h){
  h=h||state.history[state.history.length-1]; if(!h) return;
  const sd=h.summaryData||h.review?.summaryData||{};
  const rv=h.review||{};
  const s=state.currentStation||allStations().find(x=>x.tema===h.tema)||{};
  const cards=(sd.cards||currentCards());
  $('summaryBody').innerHTML=`
   <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
     <div><span class="badge ${h.area}">${h.area}</span> <b style="font-size:17px">${esc(h.tema)}</b>
       <div class="small">${new Date(h.date).toLocaleString('pt-BR')}${h.room?' · 🚪 '+esc(h.room):''}${sd.role?' · papel: '+esc(sd.role):''}</div></div>
     <div style="text-align:center"><div style="font-size:34px;font-weight:900;color:${h.pct>=70?'#65a30d':h.pct>=50?'#d97706':'#dc2626'}">${h.pct}%</div><div class="small">PEP</div></div>
   </div>
   <div class="row">
     <div class="sum-sec"><h4>🧑‍⚕️ Cenário do candidato (instruções)</h4><div class="small">${esc(sd.instrucoes||s.instrucoes||'—').replace(/\n/g,'<br>')}</div></div>
     <div class="sum-sec"><h4>🎭 Cenário do ator / avaliador</h4><div class="small">${esc(sd.avaliador||s.avaliador||'—').replace(/\n/g,'<br>')}</div></div>
   </div>
   <div class="sum-sec"><h4>🃏 Cards de auxílio compartilhados (${cards.length})</h4>
     ${cards.length?cards.map(c=>`<div class="card-chip"><b>${esc((CARD_CATS.find(x=>x.v===c.cat)||{}).l||'🎯')}</b> ${esc(c.text)}<div class="small">por ${esc(c.by||'')}</div></div>`).join(''):'<span class="small">Nenhum card foi compartilhado nesta sessão.</span>'}</div>
   ${rv.resumo||rv.fortes?`<div class="sum-sec"><h4>🤖 Feedback de IA</h4>
     ${rv.resumo?`<p class="small">${esc(rv.resumo)}</p>`:''}
     <div class="row"><div><b class="small">💪 Fortes</b><ul class="small">${(rv.fortes||[]).map(f=>`<li>${esc(f)}</li>`).join('')||'<li>—</li>'}</ul></div>
     <div><b class="small">⚠️ A desenvolver</b><ul class="small">${(rv.fracos||[]).map(f=>`<li>${esc(f)}</li>`).join('')||'<li>—</li>'}</ul></div></div>
     ${(rv.sugestoes||[]).length?`<b class="small">💡 Sugestões</b><ul class="small">${rv.sugestoes.map(f=>`<li>${esc(f)}</li>`).join('')}</ul>`:''}</div>`:''}
   <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
     <button class="amber" onclick="printSummary()">🖨 Imprimir / PDF</button>
     <button class="ghost" onclick="closeModal('summaryModal')">Fechar</button></div>`;
  openModal('summaryModal');
};
window.printSummary=function(){
  const w=window.open('','_blank');
  w.document.write('<html><head><meta charset="utf-8"><title>Resumo da sessão — pratica.M3D</title>'+
    '<style>body{font-family:system-ui,sans-serif;color:#134e4a;padding:24px}.card-chip{border-left:4px solid #8b5cf6;padding:6px 10px;margin:5px 0;background:#faf5ff;font-size:13px}.sum-sec{border:1px solid #99f6e4;border-radius:10px;padding:10px;margin-top:10px}</style></head><body>'+
    $('summaryBody').innerHTML.replace(/<button[\s\S]*?<\/button>/g,'')+'</body></html>');
  w.document.close(); w.print();
};

/* finalização na sala → resumo agrega cards + dois cenários + feedback IA */
const _fs2=window.finishStation;
window.finishStation=function(ctx){
  _fs2(ctx);
  if(ctx!=='room') return;
  const h=state.history[state.history.length-1], s=state.currentStation;
  if(h&&s){
    const sd={cards:currentCards(),instrucoes:s.instrucoes,avaliador:s.avaliador,exames:s.exames,role:state.myRoomRole};
    h.summaryData=sd; h.review=Object.assign({},h.review||{},{summaryData:sd});
    saveUserLS(); if(SERVER) api('history_add',h).catch(()=>{});
  }
  setTimeout(()=>openSummary(),350);
};

/* histórico do dashboard: botão 📋 Resumo */
const _rd=window.renderDashboard;
window.renderDashboard=function(){
  _rd();
  const n=state.history.length;
  document.querySelectorAll('#histList > div').forEach((row,j)=>{
    const h=state.history[n-1-j]; if(!h||row.querySelector('.sumBtn')) return;
    if(!(h.summaryData||h.review?.summaryData)) return;
    const b=document.createElement('button');
    b.className='violet sumBtn'; b.style.cssText='padding:4px 10px;font-size:11px';
    b.textContent='📋 Resumo'; b.onclick=()=>openSummary(h);
    row.appendChild(b);
  });
};
})();
})();
