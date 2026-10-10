'use strict';
const auth=require('./auth');
const {db,now}=require('./db');
const {roomByCode}=require('./rooms');
function createHub(io) {
  const contexts=new Map();
  const state=code=>{if(!contexts.has(code))contexts.set(code,new Map());return contexts.get(code);};
  const participants=code=>[...(contexts.get(code) || [])].map(([id,p])=>({id,name:p.name,role:p.role,sockets:p.socketIds.size,media_ready:p.mediaReady}));
  const emitRoom=(code,event,payload)=>io.to(`room:${code}`).emit(event,payload);
  const emitPresence=code=>emitRoom(code,'room:participants',{participants:participants(code)});
  function observerEmit(code,event,payload) {for(const p of state(code).values())if(p.role==='observer')for(const sid of p.socketIds)io.to(sid).emit(event,payload);}
  function updateRole(code,id,role) {const p=state(code).get(id);if(p)p.role=role;emitPresence(code);}
  function evict(code) {io.in(`room:${code}`).socketsLeave(`room:${code}`);const m=contexts.get(code);if(m)for(const p of m.values())for(const sid of p.socketIds){const s=io.sockets.sockets.get(sid);if(s)s.ctx=null;}contexts.delete(code);}
  io.use((s,next)=>{const u=auth.socketUser(s);if(!u)return next(Error('unauthorized'));s.user=u;next();});
  io.on('connection',s=>{
    const u=s.user;s.join('lobby');
    const hour=Math.floor(now()/3600000)*3600000;
    s.emit('lobby:history',{messages:db.prepare("SELECT * FROM messages WHERE scope='lobby' AND ts>=? ORDER BY id DESC LIMIT 100").all(hour).reverse()});
    // Revalidate on every event: bans, revoked sessions and expiry apply to existing sockets.
    s.use((packet,next)=>{const fresh=auth.socketUser(s);if(!fresh){s.disconnect(true);return next(Error('unauthorized'));}s.user=fresh;next();});
    let minute=0,count=0;
    const on=(event,fn)=>s.on(event,(payload={},ack)=>{try {const t=Math.floor(now()/60000);if(t!==minute){minute=t;count=0;}if(++count>600)return;fn(payload && typeof payload==='object'?payload:{},ack);}catch(e){s.emit('room:error',{error:'Operação inválida.'});if(typeof ack==='function')ack({ok:false});}});
    const err=msg=>s.emit('room:error',{error:msg});
    const C=()=>require('./consolidation');
    function leave(){const ctx=s.ctx;if(!ctx)return;s.leave(`room:${ctx.code}`);const m=contexts.get(ctx.code),p=m?.get(u.id);if(p){p.socketIds.delete(s.id);if(!p.socketIds.size){m.delete(u.id);s.to(`room:${ctx.code}`).emit('room:user_left',{id:u.id});}}s.ctx=null;if(m && !m.size)contexts.delete(ctx.code);else emitPresence(ctx.code);}
    on('room:join',({code},ack)=>{
      const room=roomByCode(code);if(!room || !room.open || !C().allowed(room,s.user))return err('Sala indisponível ou restrita.');
      leave();db.prepare("INSERT OR IGNORE INTO room_members(room,user_id,role) VALUES(?,?,'observer')").run(room.code,u.id);
      const role=C().member(room.code,u.id).role,m=state(room.code);
      if(!m.has(u.id))m.set(u.id,{socketIds:new Set(),name:s.user.name,role,mediaReady:false});const p=m.get(u.id);p.socketIds.add(s.id);p.role=role;s.ctx={code:room.code};s.join(`room:${room.code}`);
      const history=db.prepare("SELECT * FROM messages WHERE room=? AND (scope='room' OR (scope='private' AND (to_id=? OR from_id=?)) OR (scope='observer' AND (?='observer' OR ?=1))) ORDER BY id DESC LIMIT 100").all(room.code,u.id,u.id,role,room.station_ended).reverse();
      const payload={ok:true,code:room.code,self:u.id,role,participants:participants(room.code),history};s.emit('room:joined',payload);if(typeof ack==='function')ack(payload);emitPresence(room.code);
      emitRoom(room.code,'recording:consent',{ready:participants(room.code).every(p=>C().member(room.code,p.id)?.consent_at>0)});
    });
    on('room:leave',leave);
    on('room:role',()=>err('Papéis são atribuídos pelo criador no painel de participantes.'));
    on('recording:started',()=>{if(s.ctx)emitRoom(s.ctx.code,'recording:started',{from:u.id});});
    on('rtc:ready',()=>{if(!s.ctx)return;const p=state(s.ctx.code).get(u.id);if(p)p.mediaReady=true;emitPresence(s.ctx.code);s.emit('rtc:peers',{participants:participants(s.ctx.code).filter(p=>p.media_ready && p.id!==u.id)});s.to(`room:${s.ctx.code}`).emit('rtc:peer_ready',{id:u.id});});
    on('rtc:stop',()=>{if(!s.ctx)return;const p=state(s.ctx.code).get(u.id);if(p)p.mediaReady=false;s.to(`room:${s.ctx.code}`).emit('room:user_left',{id:u.id});emitPresence(s.ctx.code);});
    on('rtc:signal',({to,data})=>{if(!s.ctx || !data || JSON.stringify(data).length>100000)return;const target=state(s.ctx.code).get(+to);if(!target || !target.mediaReady)return;for(const sid of target.socketIds)io.to(sid).emit('rtc:signal',{from:u.id,data});});
    on('rtc:mode',({mode})=>{if(!s.ctx || !['p2p','agora'].includes(mode))return;if(mode==='agora' && !require('./agora').configured())return;db.prepare('UPDATE rooms SET rtc_mode=? WHERE code=?').run(mode,s.ctx.code);emitRoom(s.ctx.code,'rtc:mode',{from:u.id,mode});});
    on('chat:send',({text,to,scope})=>{
      const message=String(text || '').trim().slice(0,2000);if(!message)return;
      if(scope==='lobby'){
        const room=`lobby:${Math.floor(now()/3600000)}`,ts=now(),info=db.prepare('INSERT INTO messages(room,scope,from_id,from_name,to_id,text,ts) VALUES(?,?,?,?,0,?,?)').run(room,'lobby',u.id,s.user.name,message,ts);
        io.to('lobby').emit('lobby:message',{id:info.lastInsertRowid,room,scope:'lobby',from_id:u.id,from_name:s.user.name,text:message,ts});return;
      }
      if(!s.ctx)return;const room=roomByCode(s.ctx.code);if(!room?.open)return;
      const m=state(s.ctx.code);scope=scope==='observer'?'observer':to?'private':'room';
      if(scope==='observer' && C().member(room.code,u.id)?.role!=='observer')return err('Canal reservado aos observadores.');
      if(to && !m.has(+to))return err('Destinatário fora da sala.');
      const ts=now(),info=db.prepare('INSERT INTO messages(room,scope,from_id,from_name,to_id,text,ts) VALUES(?,?,?,?,?,?,?)').run(room.code,scope,u.id,s.user.name,+to || 0,message,ts);
      const payload={id:info.lastInsertRowid,room:room.code,scope,from_id:u.id,from_name:s.user.name,to_id:+to || 0,text:message,ts};
      if(scope==='observer' && !room.station_ended)observerEmit(room.code,'chat:message',payload);
      else if(scope==='private'){for(const p of [m.get(u.id),m.get(+to)])if(p)for(const sid of p.socketIds)io.to(sid).emit('chat:message',payload);}
      else emitRoom(room.code,'chat:message',payload);
    });
    on('observer:ask',async({question,consent})=>{
      const ctx=s.ctx;if(!ctx || C().member(ctx.code,u.id)?.role!=='observer' || !consent)return err('Canal IA reservado e requer consentimento.');
      try{const result=await require('./ai').aiChat('observer_question',[{role:'system',content:'Tutor de OSCE. Não invente referências. Responda em pt-BR.'},{role:'user',content:String(question || '').slice(0,2000)}]);
        const text=`Pergunta de ${s.user.name}: ${String(question).slice(0,2000)}\n🤖 ${result.text}`,ts=now();const info=db.prepare("INSERT INTO messages(room,scope,from_id,from_name,to_id,text,ts) VALUES(?,'observer',0,'Tutor IA',0,?,?)").run(ctx.code,text,ts);
        const payload={id:info.lastInsertRowid,room:ctx.code,scope:'observer',from_name:'Tutor IA',from_id:0,text,ts};if(roomByCode(ctx.code)?.station_ended)emitRoom(ctx.code,'chat:message',payload);else observerEmit(ctx.code,'chat:message',payload);
      }catch{err('Tutor IA indisponível.');}
    });
    s.on('disconnect',leave);
  });
  return {emitRoom,roomParticipants:participants,updateRole,evict};
}
module.exports={createHub};
