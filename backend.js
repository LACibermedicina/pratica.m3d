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
})();
