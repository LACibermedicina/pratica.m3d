'use strict';
/**
 * Token RTC da Agora gerado no servidor (formato AccessToken "007", zlib-deflate).
 * Nenhuma dependência externa — certificado NUNCA sai do servidor.
 */
const crypto = require('crypto');
const zlib = require('zlib');
const cfg = require('./config');

const p16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const p32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const pstr = (s) => { const b = Buffer.from(String(s)); return Buffer.concat([p16(b.length), b]); };
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

const K_RTC = 1;        // service type
const PRIV_JOIN = 1;    // privilege join channel

function configured() { return !!(cfg.AGORA_APP_ID && cfg.AGORA_APP_CERT); }

/** Gera token para entrar no canal `channel` como `uid` (string), com papel publisher. */
function buildToken(channel, uid, ttlSec = cfg.AGORA_TOKEN_TTL) {
  if (!configured()) throw new Error('Agora não configurada (AGORA_APP_ID / AGORA_APP_CERT).');
  const issueTs = Math.floor(Date.now() / 1000);
  const expire = ttlSec;
  const expiredTs = issueTs + ttlSec;
  const salt = crypto.randomBytes(4).readUInt32LE(0);

  // ServiceRtc: type + channelName + uid + privileges{join: expiredTs}
  const service = Buffer.concat([
    p16(K_RTC), pstr(channel), pstr(String(uid)),
    p16(1), p16(PRIV_JOIN), p32(expiredTs),
  ]);
  const pack = Buffer.concat([
    pstr(cfg.AGORA_APP_ID), p32(issueTs), p32(expire), p32(salt),
    p16(1), service,
  ]);
  const signKey = hmac(cfg.AGORA_APP_CERT, p32(issueTs));
  const signature = hmac(signKey, pack);
  const content = Buffer.concat([pstr(signature), pack]);
  return '007' + zlib.deflateSync(content).toString('base64');
}

module.exports = { configured, buildToken, appId: () => cfg.AGORA_APP_ID };
