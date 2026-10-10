'use strict';
/**
 * pratica.M3D v6 — configuração central.
 * TODAS as credenciais vivem exclusivamente em variáveis de ambiente / .env.
 * Nenhuma chave é embutida no código ou exposta ao frontend.
 */
require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PORT: +(process.env.PORT || 3000),
  DATA_DIR: path.join(ROOT, 'data'),
  STORAGE_DIR: process.env.STORAGE_DIR || path.join(ROOT, 'storage'),
  SESSION_DAYS: +(process.env.SESSION_DAYS || 30),
  ROOT_PASSWORD: process.env.ROOT_PASSWORD || '@0Arcano',

  // IA — cadeia de failsafe Gemini → OpenAI → Pollinations
  AI_TIMEOUT: +(process.env.AI_TIMEOUT || 35),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  OPENAI_BASE: process.env.OPENAI_BASE || 'https://api.openai.com/v1',
  POLLINATIONS_TOKEN: process.env.POLLINATIONS_TOKEN || '',
  POLLINATIONS_MODEL: process.env.POLLINATIONS_MODEL || 'openai',

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
