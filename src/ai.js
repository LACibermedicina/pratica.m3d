'use strict';
/**
 * Cadeia de failsafe de IA: Gemini → OpenAI → Pollinations.
 * Cada tentativa é gravada em ai_calls (provedor, modelo, latência, erro).
 * O frontend NUNCA vê chave alguma — só fala com /api/ai/* neste servidor.
 */
const { db, now } = require('./db');
const cfg = require('./config');

function logCall(provider, model, task, ok, latency, error = '') {
  db.prepare('INSERT INTO ai_calls(provider,model,task,ok,latency_ms,error,ts) VALUES(?,?,?,?,?,?,?)')
    .run(provider, model, task, ok ? 1 : 0, latency, String(error).slice(0, 500), now());
}

async function post(url, payload, headers = {}, timeoutSec = cfg.AI_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ------------------------------------------------------------ provedores --- */
const providers = {
  gemini: {
    configured: () => !!cfg.GEMINI_API_KEY,
    async call(messages) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}:generateContent?key=${cfg.GEMINI_API_KEY}`;
      const text = messages.map((m) => `${m.role === 'system' ? 'INSTRUÇÃO' : 'USUÁRIO'}: ${m.content}`).join('\n\n');
      const r = await post(url, {
        contents: [{ parts: [{ text }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
      });
      const out = r.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      if (!out) throw new Error('resposta vazia');
      return { text: out, model: cfg.GEMINI_MODEL };
    },
  },
  openai: {
    configured: () => !!cfg.OPENAI_API_KEY,
    async call(messages) {
      const r = await post(`${cfg.OPENAI_BASE}/chat/completions`, {
        model: cfg.OPENAI_MODEL, messages, temperature: 0.4, max_tokens: 4096,
      }, { Authorization: `Bearer ${cfg.OPENAI_API_KEY}` });
      const out = r.choices?.[0]?.message?.content || '';
      if (!out) throw new Error('resposta vazia');
      return { text: out, model: cfg.OPENAI_MODEL };
    },
  },
  pollinations: {
    configured: () => true, // sempre disponível como último recurso
    async call(messages) {
      const headers = cfg.POLLINATIONS_TOKEN ? { Authorization: `Bearer ${cfg.POLLINATIONS_TOKEN}` } : {};
      const r = await post('https://text.pollinations.ai/openai', {
        model: cfg.POLLINATIONS_MODEL, messages, private: true,
      }, headers);
      const out = r.choices?.[0]?.message?.content || (typeof r === 'string' ? r : '');
      if (!out) throw new Error('resposta vazia');
      return { text: out, model: cfg.POLLINATIONS_MODEL };
    },
  },
};

const CHAIN = ['gemini', 'openai', 'pollinations'];

/** Executa a cadeia de failsafe. Retorna {text, provider, model, attempts}. */
async function aiChat(task, messages) {
  const attempts = [];
  for (const name of CHAIN) {
    const p = providers[name];
    if (!p.configured()) { attempts.push({ provider: name, skipped: true }); continue; }
    const t0 = now();
    try {
      const { text, model } = await p.call(messages);
      logCall(name, model, task, true, now() - t0);
      return { text, provider: name, model, attempts };
    } catch (e) {
      logCall(name, '', task, false, now() - t0, e.message);
      attempts.push({ provider: name, error: e.message });
    }
  }
  const err = new Error('Todos os provedores de IA falharam.');
  err.attempts = attempts;
  throw err;
}

/** Extrai o primeiro bloco JSON válido de um texto da IA. */
function extractJson(text) {
  if (!text) return null;
  const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  for (let end = candidate.length; end > start; end--) {
    const tail = candidate.slice(start, end).trim();
    if (!/[\]}]$/.test(tail)) continue;
    try { return JSON.parse(tail); } catch { /* continua encurtando */ }
  }
  return null;
}

async function aiJson(task, messages) {
  const r = await aiChat(task, messages);
  const data = extractJson(r.text);
  if (data == null) {
    const e = new Error('IA não retornou JSON válido.');
    e.raw = r.text.slice(0, 800);
    throw e;
  }
  return { data, provider: r.provider, model: r.model, attempts: r.attempts };
}

function aiStatus() {
  return CHAIN.map((name) => ({ provider: name, configured: providers[name].configured() }));
}

module.exports = { aiChat, aiJson, aiStatus, extractJson, CHAIN };
