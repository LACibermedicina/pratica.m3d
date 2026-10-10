"""Cadeia de failsafe de IA: Gemini -> OpenAI -> Pollinations.
Cada tentativa é registrada em ai_calls (provedor, latência, erro) —
o painel /api/ai/status testa os 3 ao vivo e /api/ai/logs mostra o histórico."""
import os, json, time, re, httpx
from .db import conn

CFG = {
    'gemini_key':   os.environ.get('GEMINI_API_KEY', ''),
    'gemini_model': os.environ.get('GEMINI_MODEL', 'gemini-2.0-flash'),
    'oai_base':     os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    'oai_key':      os.environ.get('OPENAI_API_KEY', ''),
    'oai_model':    os.environ.get('OPENAI_MODEL', 'gpt-4o-mini'),
    'poll_model':   os.environ.get('POLLINATIONS_MODEL', 'openai'),
    'timeout':      float(os.environ.get('AI_TIMEOUT', '35')),
}

def log(provider, model, purpose, ok, lat, err=''):
    c = conn()
    c.execute("INSERT INTO ai_calls(provider,model,purpose,ok,latency_ms,error,created_at) VALUES(?,?,?,?,?,?,?)",
              (provider, model, purpose, 1 if ok else 0, lat, (err or '')[:500], int(time.time())))
    c.commit(); c.close()

async def _gemini(prompt):
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{CFG['gemini_model']}:generateContent?key={CFG['gemini_key']}")
    async with httpx.AsyncClient(timeout=CFG['timeout']) as cl:
        r = await cl.post(url, json={"contents": [{"parts": [{"text": prompt}]}]})
        r.raise_for_status()
        d = r.json()
        return d['candidates'][0]['content']['parts'][0]['text']

async def _openai(prompt):
    async with httpx.AsyncClient(timeout=CFG['timeout']) as cl:
        r = await cl.post(f"{CFG['oai_base']}/chat/completions",
                          headers={'Authorization': f"Bearer {CFG['oai_key']}"},
                          json={"model": CFG['oai_model'],
                                "messages": [{"role": "user", "content": prompt}]})
        r.raise_for_status()
        return r.json()['choices'][0]['message']['content']

async def _poll(prompt):
    async with httpx.AsyncClient(timeout=CFG['timeout']) as cl:
        r = await cl.post("https://text.pollinations.ai/openai",
                          json={"model": CFG['poll_model'],
                                "messages": [{"role": "user", "content": prompt}],
                                "private": True})
        r.raise_for_status()
        d = r.json()
        if isinstance(d, dict) and 'choices' in d:
            return d['choices'][0]['message']['content']
        return r.text

PROVIDERS = [
    ('gemini',       _gemini, lambda: bool(CFG['gemini_key'])),
    ('openai',       _openai, lambda: bool(CFG['oai_key'])),
    ('pollinations', _poll,   lambda: True),  # gratuito, sem chave
]

async def complete(prompt, purpose='generic'):
    """Tenta os provedores em ordem; devolve {'provider','text'} ou erro agregado."""
    errors = []
    for name, fn, available in PROVIDERS:
        if not available():
            errors.append(f"{name}: chave ausente (defina via env)")
            continue
        t0 = time.time()
        try:
            out = await fn(prompt)
            log(name, CFG.get(name + '_model', ''), purpose, True, int((time.time() - t0) * 1000))
            return {'provider': name, 'text': out}
        except Exception as e:
            log(name, CFG.get(name + '_model', ''), purpose, False,
                int((time.time() - t0) * 1000), str(e))
            errors.append(f"{name}: {type(e).__name__}: {e}")
    raise RuntimeError("Todos os provedores falharam → " + " | ".join(errors))

async def status():
    """Teste ao vivo de cada provedor (usado no painel de diagnóstico)."""
    out = []
    for name, fn, available in PROVIDERS:
        if not available():
            out.append({'provider': name, 'configured': False, 'ok': False,
                        'error': 'chave ausente — defina a variável de ambiente'})
            continue
        t0 = time.time()
        try:
            txt = await fn("Responda apenas: OK")
            out.append({'provider': name, 'configured': True, 'ok': True,
                        'latency_ms': int((time.time() - t0) * 1000), 'sample': txt[:40]})
        except Exception as e:
            out.append({'provider': name, 'configured': True, 'ok': False,
                        'latency_ms': int((time.time() - t0) * 1000),
                        'error': f"{type(e).__name__}: {e}"[:250]})
    return out

def extract_json(text):
    """Extrai o primeiro bloco JSON ({...} ou [...]) de uma resposta de IA."""
    m = re.search(r'```(?:json)?\s*(.*?)```', text, re.S)
    raw = m.group(1) if m else text
    for opener, closer in (('{', '}'), ('[', ']')):
        i, j = raw.find(opener), raw.rfind(closer)
        if 0 <= i < j:
            try:
                return json.loads(raw[i:j + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError("A IA não devolveu JSON válido")
