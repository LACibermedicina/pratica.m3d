'use strict';
// Fixtures locais: verificam contratos e evidências, não validam um modelo clínico real.
const http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');const {spawn}=require('child_process');
const BASE='http://127.0.0.1:3334',store=fs.mkdtempSync(path.join(os.tmpdir(),'m3d-ai-'));let backend;const results=[];let malformed=false;
const mock=http.createServer((req,res)=>{let text='';req.on('data',d=>text+=d);req.on('end',()=>{const body=JSON.parse(text),messages=body.messages;let reply;
 if(req.url.startsWith('/openai'))reply='fixture without JSON';
 else {let payload;try{payload=JSON.parse(messages.at(-1).content);}catch{}
   if(payload?.checklist && payload.transcript){const candidate=payload.transcript.find(s=>s.role==='candidato'),actor=payload.transcript.find(s=>s.role==='ator');reply=JSON.stringify({items:malformed?[]:[{index:0,marcado:1,segment_id:candidate.id,citacao:'Confirma seu nome completo?',justificativa:'Pergunta do candidato confirma identidade.'},{index:1,marcado:1,segment_id:actor.id,citacao:actor.text,justificativa:'Fixture tenta creditar fala do ator.'},{index:2,marcado:1,segment_id:candidate.id,citacao:'Conduta que não foi dita',justificativa:'Fixture tenta usar citação inexistente.'}]});}
   else reply='Resposta simulada do paciente para testes de integração.';
 }
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:reply}}]}));});});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const call=async(p,t,b)=>{const r=await fetch(BASE+p,{method:b?'POST':'GET',headers:{...(t?{Authorization:'Bearer '+t}:{}),...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});return {status:r.status,...await r.json()};};
const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});console.log('PASS',name);};
(async()=>{
 await new Promise(r=>mock.listen(3335,r));backend=spawn(process.execPath,['src/server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'3334',STORAGE_DIR:store,ROOT_PASSWORD:'FixtureRoot123!',GEMINI_API_KEY:'',OPENAI_API_KEY:'fixture-key',OPENAI_BASE:'http://127.0.0.1:3335/openai',POLLINATIONS_TOKEN:'fixture-key',POLLINATIONS_BASE:'http://127.0.0.1:3335/pollinations'},stdio:'ignore'});
 for(let i=0;i<80;i++){try{if((await call('/health')).ok)break;}catch{}await delay(100);}
 const root=await call('/api/login',null,{login:'root',password:'FixtureRoot123!'}),rt=root.token;
 const candidate=await call('/api/register',null,{name:'Fixture médico',email:'doctor@fixture.local',password:'FixturePassword123!'}),ct=candidate.token;
 const actor=await call('/api/register',null,{name:'Fixture ator',email:'actor@fixture.local',password:'FixturePassword123!'}),at=actor.token;
 await call('/api/stations',rt,{id:'fixture-ai',tema:'Fixture não clínica — teste IA',area:'CM',instrucoes:'Teste de contrato',roteiro_ator:'Roteiro de fixture',checklist:[{item:'Confirma identidade',peso:1},{item:'Exame físico',peso:1},{item:'Plano terapêutico',peso:1}]});
 const r=await call('/api/rooms',ct,{station_ids:['fixture-ai'],ai_mode:1});const code=r.room.code;
 await call(`/api/rooms/${code}/invite`,ct,{email:actor.user.email});await call(`/api/rooms/${code}/role`,ct,{user_id:actor.user.id,role:'ator'});
 for(const t of [ct,at])await call(`/api/rooms/${code}/consent`,t,{consent:true});
 await call(`/api/rooms/${code}/transcript`,ct,{text:'Confirma seu nome completo?'});await call(`/api/rooms/${code}/transcript`,at,{text:'Já fizeram meu exame físico.'});
 let pep;
 await check('JSON inválido aciona próximo provedor na cadeia',async()=>{const r=await call(`/api/rooms/${code}/grade-audio`,ct,{consent:true});assert(r.ok);assert.equal(r.score,1);pep=await call('/api/peps/'+r.pep_id,ct);assert.equal(pep.pep.ai.provider,'pollinations');});
 await check('Fala do ator não conta como desempenho do candidato',()=>assert.equal(pep.pep.items[1].marcado,0));
 await check('Citação inexistente não gera ponto',()=>assert.equal(pep.pep.items[2].marcado,0));
 await check('PEP guarda transcrição e justificativas individuais',()=>{assert(JSON.parse(pep.pep.transcript).length===2);assert(pep.pep.items.every(i=>i.justificativa));});
 await check('Logs registram falha e sucesso reais das fixtures',async()=>{const r=await call('/api/ai/logs',rt);assert(r.logs.some(l=>l.provider==='openai' && !l.ok));assert(r.logs.some(l=>l.provider==='pollinations' && l.ok));});
 await check('Resposta incompleta nunca gera PEP com nota inventada',async()=>{malformed=true;const newRoom=await call('/api/rooms',ct,{station_ids:['fixture-ai'],ai_mode:1});await call(`/api/rooms/${newRoom.room.code}/consent`,ct,{consent:true});await call(`/api/rooms/${newRoom.room.code}/transcript`,ct,{text:'Confirma seu nome completo?'});const r=await call(`/api/rooms/${newRoom.room.code}/grade-audio`,ct,{consent:true});assert.equal(r.status,502);assert.equal((await call('/api/peps',ct)).peps.length,1);});
 fs.writeFileSync(path.join(__dirname,'results-ai-fixture.json'),JSON.stringify({suite:'Contratos IA com provedores simulados locais',passed:results.length,results,limitations:['Respostas artificiais de teste; não valida qualidade médica, modelos reais ou credenciais externas.']},null,2));console.log('TOTAL',results.length,'PASS');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{backend?.kill();mock.close();setTimeout(()=>fs.rmSync(store,{recursive:true,force:true}),300).unref();});
