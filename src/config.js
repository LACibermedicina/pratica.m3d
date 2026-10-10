'use strict';
/**
 * pratica.M3D v6 — configuração central.
 * TODAS as credenciais vivem exclusivamente em variáveis de ambiente / .env.
 * Nenhuma chave é embutida no código ou exposta ao frontend.
 */
require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');
if(process.env.NODE_ENV === 'production' && (!process.env.ROOT_PASSWORD || process.env.ROOT_PASSWORD === '@0Arcano')) throw Error('Defina ROOT_PASSWORD forte antes de iniciar em produção.');

module.exports = {
  ROOT,
  APP_URL: process.env.APP_URL || 'http://localhost:3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  SMTP_URL: process.env.SMTP_URL || '',
  MAIL_FROM: process.env.MAIL_FROM || 'pratica.M3D <noreply@m3d.pro>',
  RECOVERY_DEV_TOKEN: process.env.RECOVERY_DEV_TOKEN === 'true',
  POLLINATIONS_BASE: process.env.POLLINATIONS_BASE || 'https://gen.pollinations.ai/v1',
  MESH_MAX_PARTICIPANTS: Math.max(2, Math.min(12, +(process.env.MESH_MAX_PARTICIPANTS || 6))),
  PORT: +(process.env.PORT || 3000),
  DATA_DIR: path.join(ROOT, 'data'),
  STORAGE_DIR: process.env.STORAGE_DIR || path.join(ROOT, 'storage'),
  SESSION_DAYS: Math.min(30, Math.max(1, +(process.env.SESSION_DAYS || 30))),
  ROOT_PASSWORD: process.env.ROOT_PASSWORD || '@0Arcano',

  // IA — cadeia de failsafe Gemini → OpenAI → Pollinations
  AI_TIMEOUT: +(process.env.AI_TIMEOUT || 35),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  OPENAI_BASE: process.env.OPENAI_BASE || 'https://api.openai.com/v1',
  POLLINATIONS_TOKEN: process.env.POLLINATIONS_TOKEN || '',
  POLLINATIONS_MODEL: process.env.POLLINATIONS_MODEL || 'openai/gpt-5.4-nano',

  // Agora (failsafe de vídeo) — App ID + Certificate, token gerado no servidor
  AGORA_APP_ID: process.env.AGORA_APP_ID || '',
  AGORA_APP_CERT: process.env.AGORA_APP_CERT || '',
  AGORA_TOKEN_TTL: +(process.env.AGORA_TOKEN_TTL || 3600),

  // TURN opcional para o WebRTC P2P (melhora NAT traversal antes de cair no Agora)
  TURN_URLS: process.env.TURN_URLS || '',
  TURN_USERNAME: process.env.TURN_USERNAME || '',
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL || '',

  // Orçamento do watchdog P2P antes do failsafe Agora (ms)
  P2P_WATCHDOG_MS: +(process.env.P2P_WATCHDOG_MS || 8000),
};
