'use strict';
const {RtcTokenBuilder,RtcRole}=require('agora-token');
const cfg=require('./config');
const configured=()=>!!(cfg.AGORA_APP_ID && cfg.AGORA_APP_CERT);
function buildToken(channel,uid,ttl=cfg.AGORA_TOKEN_TTL){
  if(!configured())throw Error('Agora não configurada.');
  const seconds=Math.max(60,Math.min(86400,+ttl || 3600));
  const token=RtcTokenBuilder.buildTokenWithUserAccount(cfg.AGORA_APP_ID,cfg.AGORA_APP_CERT,channel,String(uid),RtcRole.PUBLISHER,seconds,seconds);
  if(!token)throw Error('Credenciais Agora inválidas.');return token;
}
module.exports={configured,buildToken,appId:()=>cfg.AGORA_APP_ID};
