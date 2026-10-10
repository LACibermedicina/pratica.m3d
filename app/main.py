"""pratica.M3D v4 — FastAPI + WebSocket (presença, chat, timer, sinalização WebRTC)."""
import os, json, time, uuid, asyncio, secrets
import bcrypt
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from .db import conn, init, AREAS
from . import ai as AI
from . import stations_io, flowcards

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(BASE, 'static')
os.makedirs(os.path.join(STATIC, 'flowcards'), exist_ok=True)

SESSION_DAYS = 30
app = FastAPI(title='pratica.M3D v4')

# ----------------------------------------------------------------- auth utils
def new_session(uid):
    c = conn()
    tok = secrets.token_urlsafe(32)
    now = int(time.time())
    c.execute("INSERT INTO sessions VALUES(?,?,?,?)", (tok, uid, now, now + SESSION_DAYS * 86400))
    c.commit(); c.close()
    return tok

def auth_user(req):
    tok = req.headers.get('authorization', '').replace('Bearer ', '') or req.query_params.get('token', '')
    if not tok: return None
    c = conn()
    r = c.execute("""SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                     WHERE s.token=? AND s.expires_at>?""", (tok, int(time.time()))).fetchone()
    c.close()
    return dict(r) if r else None

def require_admin(u):
    return u and u['role'] in ('admin', 'root')

def station_dict(r):
    d = dict(r)
    d['exames'] = json.loads(d['exames'])
    d['checklist'] = json.loads(d['checklist'])
    d['roteiroAtor'] = d.pop('roteiro_ator')
    return d

# ----------------------------------------------------------------- REST: auth
@app.post('/api/register')
async def register(req: Request):
    b = await req.json()
    name, email, pw = (b.get('name') or '').strip(), (b.get('email') or '').strip().lower(), b.get('pass') or ''
    if len(name) < 2 or '@' not in email or len(pw) < 4:
        return JSONResponse({'error': 'dados inválidos'}, 400)
    c = conn()
    if c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        c.close(); return JSONResponse({'error': 'e-mail já cadastrado'}, 409)
    h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
    cur = c.execute("INSERT INTO users(name,email,pass,created_at) VALUES(?,?,?,?)",
                    (name, email, h, int(time.time())))
    uid = cur.lastrowid; c.commit(); c.close()
    return {'token': new_session(uid)}

@app.post('/api/login')
async def login(req: Request):
    b = await req.json()
    login_, pw = (b.get('login') or '').strip().lower(), b.get('pass') or ''
    c = conn()
    r = c.execute("SELECT * FROM users WHERE lower(email)=? OR lower(name)=?", (login_, login_)).fetchone()
    c.close()
    if not r or not bcrypt.checkpw(pw.encode(), r['pass'].encode()):
        return JSONResponse({'error': 'credenciais inválidas'}, 401)
    return {'token': new_session(r['id'])}

@app.get('/api/me')
async def me(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'não autenticado'}, 401)
    return {'id': u['id'], 'name': u['name'], 'email': u['email'], 'role': u['role'],
            'avatar': u['avatar'], 'layout': json.loads(u['layout'] or '{}')}

@app.post('/api/logout')
async def logout(req: Request):
    tok = req.headers.get('authorization', '').replace('Bearer ', '')
    c = conn(); c.execute("DELETE FROM sessions WHERE token=?", (tok,)); c.commit(); c.close()
    return {'ok': True}

@app.post('/api/forgot')
async def forgot(req: Request):
    b = await req.json()
    email = (b.get('email') or '').strip().lower()
    c = conn()
    u = c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone()
    if not u: c.close(); return JSONResponse({'error': 'e-mail não encontrado'}, 404)
    tok = secrets.token_urlsafe(16)
    c.execute("INSERT INTO resets VALUES(?,?,?)", (tok, email, int(time.time()) + 3600))
    c.commit(); c.close()
    return {'token': tok, 'notice': 'ambiente local: o token é devolvido aqui (sem SMTP)'}

@app.post('/api/reset')
async def reset(req: Request):
    b = await req.json()
    tok, pw = b.get('token', ''), b.get('pass', '')
    c = conn()
    r = c.execute("SELECT * FROM resets WHERE token=? AND expires_at>?", (tok, int(time.time()))).fetchone()
    if not r: c.close(); return JSONResponse({'error': 'token inválido/expirado'}, 400)
    h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
    c.execute("UPDATE users SET pass=? WHERE email=?", (h, r['email']))
    c.execute("DELETE FROM resets WHERE token=?", (tok,))
    c.commit(); c.close()
    return {'ok': True}

@app.post('/api/profile')
async def profile(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    if b.get('name'): c.execute("UPDATE users SET name=? WHERE id=?", (b['name'][:80], u['id']))
    if b.get('avatar'): c.execute("UPDATE users SET avatar=? WHERE id=?", (b['avatar'][:8], u['id']))
    if 'layout' in b: c.execute("UPDATE users SET layout=? WHERE id=?", (json.dumps(b['layout']), u['id']))
    if b.get('newpass'):
        if not bcrypt.checkpw((b.get('oldpass') or '').encode(), u['pass'].encode()):
            c.close(); return JSONResponse({'error': 'senha atual incorreta'}, 400)
        c.execute("UPDATE users SET pass=? WHERE id=?",
                  (bcrypt.hashpw(b['newpass'].encode(), bcrypt.gensalt()).decode(), u['id']))
    c.commit(); c.close()
    return {'ok': True}

@app.post('/api/admin/set_role')
async def set_role(req: Request):
    u = auth_user(req)
    if not u or u['role'] != 'root': return JSONResponse({'error': 'apenas root'}, 403)
    b = await req.json()
    c = conn()
    t = c.execute("SELECT * FROM users WHERE id=?", (b.get('user_id'),)).fetchone()
    if not t or t['role'] == 'root': c.close(); return JSONResponse({'error': 'alvo inválido'}, 400)
    c.execute("UPDATE users SET role=? WHERE id=?", (b.get('role', 'user'), t['id']))
    c.commit(); c.close()
    return {'ok': True}

# ----------------------------------------------------------------- REST: estações
@app.get('/api/stations')
async def stations(req: Request, q: str = '', area: str = '', nivel: str = ''):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    sql, par = "SELECT * FROM stations WHERE frozen=0", []
    if area in AREAS: sql += " AND area=?"; par.append(area)
    if nivel: sql += " AND nivel=?"; par.append(nivel)
    if q: sql += " AND (tema LIKE ? OR instrucoes LIKE ?)"; par += [f'%{q}%', f'%{q}%']
    sql += " ORDER BY area, tema"
    c = conn(); rows = c.execute(sql, par).fetchall(); c.close()
    return {'stations': [station_dict(r) for r in rows]}

@app.get('/api/stations/{sid}')
async def station_one(req: Request, sid: str):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn(); r = c.execute("SELECT * FROM stations WHERE id=?", (sid,)).fetchone(); c.close()
    return station_dict(r) if r else JSONResponse({'error': 'não encontrada'}, 404)

@app.post('/api/stations')
async def station_create(req: Request):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    b = await req.json()
    b['id'] = b.get('id') or 'st-' + uuid.uuid4().hex[:8]
    c = conn()
    kind, sid = stations_io.upsert_station(c, b, overwrite=False)
    c.commit(); c.close()
    return {'ok': True, 'id': sid, 'status': kind}

@app.put('/api/stations/{sid}')
async def station_update(req: Request, sid: str):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    b = await req.json(); b['id'] = sid
    c = conn()
    if not c.execute("SELECT 1 FROM stations WHERE id=?", (sid,)).fetchone():
        c.close(); return JSONResponse({'error': 'não encontrada'}, 404)
    stations_io.upsert_station(c, b, overwrite=True)
    c.commit(); c.close()
    return {'ok': True}

@app.delete('/api/stations/{sid}')
async def station_delete(req: Request, sid: str):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    c = conn(); c.execute("DELETE FROM stations WHERE id=?", (sid,)); c.commit(); c.close()
    return {'ok': True}

@app.post('/api/stations/import')
async def stations_import(req: Request, file: UploadFile, overwrite: int = 0):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    content = await file.read()
    try:
        if file.filename.lower().endswith('.xlsx'):
            res = stations_io.import_xlsx(content, bool(overwrite))
        else:
            res = stations_io.import_json(content, bool(overwrite))
    except Exception as e:
        return JSONResponse({'error': f'falha na importação: {e}'[:300]}, 400)
    return res

@app.get('/api/stations/export/package')
async def stations_export(req: Request, ids: str = ''):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    sel = [s for s in ids.split(',') if s] or None
    pkg = stations_io.export_package(sel)
    return JSONResponse(pkg, headers={'Content-Disposition': 'attachment; filename=stations_pack.json'})

# ----------------------------------------------------------------- REST: IA
@app.get('/api/ai/status')
async def ai_status(req: Request):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    return {'providers': await AI.status()}

@app.get('/api/ai/logs')
async def ai_logs(req: Request, limit: int = 50):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    c = conn()
    rows = c.execute("SELECT * FROM ai_calls ORDER BY id DESC LIMIT ?", (min(limit, 200),)).fetchall()
    c.close()
    return {'logs': [dict(r) for r in rows]}

@app.post('/api/ai/ask')
async def ai_ask(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    try:
        r = await AI.complete(b.get('prompt', ''), b.get('purpose', 'ask'))
        return r
    except Exception as e:
        return JSONResponse({'error': str(e)}, 502)

@app.post('/api/ai/generate_station')
async def ai_gen_station(req: Request):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    b = await req.json()
    tema, nivel = b.get('tema', '').strip(), b.get('nivel', 'intermediário')
    if len(tema) < 3: return JSONResponse({'error': 'informe o tema'}, 400)
    prompt = f"""Você é um elaborador de estações OSCE (Revalida/INEP). Crie uma estação completa sobre:
TEMA: {tema} | NÍVEL: {nivel} | ÁREA: {b.get('area', 'CM')}
Padronize às diretrizes do INEP, SUS e Ministério da Saúde (protocolos XABCDE, RN e curvas OMS quando aplicável).
Responda EXCLUSIVAMENTE um JSON com as chaves:
{{"tema": "...", "area": "CM|CIR|GO|PED|MFC", "especialidade": "...", "nivel": "{nivel}",
 "duracao": 10, "fonte": "gerado por IA — diretrizes MS/INEP",
 "instrucoes": "instruções ao candidato", "cenario": "cenário da estação",
 "roteiro_ator": "roteiro completo do ator/paciente padronizado",
 "protocolo": "conduta esperada segundo protocolo/diretriz",
 "exames": ["exame 1: resultado", ...], "checklist": ["item do PEP 1", ...]}}
Checklist com 8 a 15 itens observáveis. Sem texto fora do JSON."""
    try:
        r = await AI.complete(prompt, 'generate_station')
        spec = AI.extract_json(r['text'])
        spec['id'] = 'ai-' + uuid.uuid4().hex[:8]
        c = conn()
        kind, sid = stations_io.upsert_station(c, spec, overwrite=False)
        c.commit()
        saved = c.execute("SELECT * FROM stations WHERE id=?", (sid,)).fetchone()
        c.close()
        return {'ok': True, 'provider': r['provider'], 'station': station_dict(saved)}
    except Exception as e:
        return JSONResponse({'error': str(e)}, 502)

@app.post('/api/ai/patient')
async def ai_patient(req: Request):
    """Paciente virtual: responde só ao que for perguntado, com base no roteiro do ator."""
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    st = c.execute("SELECT * FROM stations WHERE id=?", (b.get('station_id'),)).fetchone()
    c.close()
    if not st: return JSONResponse({'error': 'estação inválida'}, 404)
    hist = '\n'.join(f"- {m.get('role','?')}: {m.get('text','')}" for m in (b.get('history') or [])[-12:])
    prompt = f"""Você é o PACIENTE de uma simulação OSCE. Responda EXCLUSIVAMENTE ao que foi perguntado,
em primeira pessoa, de forma natural e concisa (1-3 frases), com base somente no roteiro abaixo.
Se a informação não estiver no roteiro, diga que não sabe/não lembra. Nunca revele o diagnóstico.
ROTEIRO: {st['roteiro_ator'][:3000]}
HISTÓRICO:
{hist}
PERGUNTA DO MÉDICO: {b.get('question','')}
RESPOSTA DO PACIENTE:"""
    try:
        r = await AI.complete(prompt, 'patient')
        return {'provider': r['provider'], 'reply': r['text'].strip()[:600]}
    except Exception as e:
        return JSONResponse({'error': str(e)}, 502)

@app.post('/api/ai/correct_pep')
async def ai_correct(req: Request):
    """Corrige a transcrição contra o PEP oficial, item a item, com justificativa."""
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    st = c.execute("SELECT * FROM stations WHERE id=?", (b.get('station_id'),)).fetchone()
    c.close()
    if not st: return JSONResponse({'error': 'estação inválida'}, 404)
    checklist = json.loads(st['checklist'])
    prompt = f"""Você é um avaliador OSCE. Compare a TRANSCRIÇÃO da consulta com o PEP oficial.
Para CADA item, decida "ok" (feito) ou "miss" (não feito) e dê justificativa curta citando o contexto.
Responda EXCLUSIVAMENTE JSON: [{{"idx": 0, "verdict": "ok|miss", "why": "..."}}, ...]
PEP: {json.dumps(checklist, ensure_ascii=False)}
TRANSCRIÇÃO: {(b.get('transcript') or '')[:6000]}"""
    try:
        r = await AI.complete(prompt, 'correct_pep')
        marks = AI.extract_json(r['text'])
        done = sum(1 for m in marks if m.get('verdict') == 'ok')
        score = round(100 * done / max(1, len(checklist)), 1)
        return {'provider': r['provider'], 'marks': marks, 'score': score}
    except Exception as e:
        return JSONResponse({'error': str(e)}, 502)

@app.post('/api/ai/coach')
async def ai_coach(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn()
    rows = c.execute("""SELECT station_id, score, created_at FROM pep_results
                        WHERE user_id=? ORDER BY id DESC LIMIT 30""", (u['id'],)).fetchall()
    c.close()
    hist = json.dumps([dict(r) for r in rows], ensure_ascii=False)
    prompt = f"""Você é um coach de preparação para o Revalida. Analise o histórico de desempenho (JSON) e devolva
EXCLUSIVAMENTE JSON: {{"fortes": [...], "lacunas": [...], "plano": ["passo 1", ...]}} em pt-BR.
HISTÓRICO: {hist}"""
    try:
        r = await AI.complete(prompt, 'coach')
        return {'provider': r['provider'], 'analysis': AI.extract_json(r['text'])}
    except Exception as e:
        return JSONResponse({'error': str(e)}, 502)

# ----------------------------------------------------------------- flowcards
FLOW_PROMPT = """Crie um fluxograma didático de abordagem clínica sobre o tema abaixo, seguindo
diretrizes do Ministério da Saúde / protocolos brasileiros vigentes.
Responda EXCLUSIVAMENTE JSON:
{"title": "...", "fonte": "diretriz utilizada",
 "steps": [{"kind": "inicio|avaliacao|conduta|alerta|reavaliacao", "label": "passo curto", "detail": "detalhe de 1 linha"}, ...]}
Entre 6 e 10 passos, em pt-BR. TEMA: %s"""

@app.post('/api/flowcards')
async def flowcard_create(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    tema = (b.get('tema') or '').strip()
    if len(tema) < 3: return JSONResponse({'error': 'informe o tema'}, 400)
    provider = 'template-local'
    try:
        r = await AI.complete(FLOW_PROMPT % tema, 'flowcard')
        spec = AI.extract_json(r['text']); provider = r['provider']
    except Exception:
        spec = flowcards.fallback_spec(tema)   # nunca falha: cai no template XABCDE
    fid = 'fc-' + uuid.uuid4().hex[:8]
    png = flowcards.render_png(spec, fid)
    cover = flowcards.cover_url(tema) if b.get('cover', True) else None
    c = conn()
    c.execute("INSERT INTO flowcards VALUES(?,?,?,?,?,?,?)",
              (fid, tema, json.dumps(spec, ensure_ascii=False), png, cover, u['id'], int(time.time())))
    c.commit(); c.close()
    return {'ok': True, 'id': fid, 'png': png, 'cover': cover, 'spec': spec, 'provider': provider}

@app.get('/api/flowcards')
async def flowcard_list(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn()
    rows = c.execute("SELECT * FROM flowcards ORDER BY id DESC LIMIT 60").fetchall()
    c.close()
    return {'cards': [dict(r) for r in rows]}

# ----------------------------------------------------------------- PEP / SRS / analytics / disputas
@app.post('/api/pep')
async def pep_save(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    c.execute("""INSERT INTO pep_results(room_code,station_id,user_id,user_name,marks,score,transcript,notes,created_at)
                 VALUES(?,?,?,?,?,?,?,?,?)""",
              (b.get('room_code', ''), b.get('station_id', ''), u['id'], u['name'],
               json.dumps(b.get('marks', {}), ensure_ascii=False), float(b.get('score', 0)),
               (b.get('transcript') or '')[:8000], (b.get('notes') or '')[:2000], int(time.time())))
    c.commit(); c.close()
    return {'ok': True}

@app.post('/api/srs/generate')
async def srs_generate(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    st = c.execute("SELECT * FROM stations WHERE id=?", (b.get('station_id'),)).fetchone()
    if not st: c.close(); return JSONResponse({'error': 'estação inválida'}, 404)
    now = int(time.time()); n = 0
    for item in json.loads(st['checklist']):
        c.execute("""INSERT INTO srs_cards(user_id,station_id,front,back,level,next_due,created_at)
                     VALUES(?,?,?,?,0,?,?)""",
                  (u['id'], st['id'], f"[{st['area']}] {st['tema']} — o que fazer em: {item}?",
                   f"Esperado: {item}. Protocolo: {(st['protocolo'] or 'ver estação')[:300]}",
                   now, now))
        n += 1
    c.commit(); c.close()
    return {'ok': True, 'cards': n}

SRS_STEPS = [1, 3, 7, 15, 30]

@app.get('/api/srs/due')
async def srs_due(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn()
    rows = c.execute("SELECT * FROM srs_cards WHERE user_id=? AND next_due<=? ORDER BY next_due LIMIT 50",
                     (u['id'], int(time.time()))).fetchall()
    c.close()
    return {'cards': [dict(r) for r in rows]}

@app.post('/api/srs/review')
async def srs_review(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    r = c.execute("SELECT * FROM srs_cards WHERE id=? AND user_id=?", (b.get('card_id'), u['id'])).fetchone()
    if not r: c.close(); return JSONResponse({'error': 'card inválido'}, 404)
    lvl = r['level'] + 1 if b.get('remembered') else 0
    lvl = min(lvl, len(SRS_STEPS) - 1)
    c.execute("UPDATE srs_cards SET level=?, next_due=? WHERE id=?",
              (lvl, int(time.time()) + SRS_STEPS[lvl] * 86400, r['id']))
    c.commit(); c.close()
    return {'ok': True, 'level': lvl}

@app.get('/api/analytics')
async def analytics(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn()
    rows = c.execute("""SELECT p.*, s.area FROM pep_results p
                        LEFT JOIN stations s ON s.id=p.station_id
                        WHERE p.user_id=? ORDER BY p.id DESC""", (u['id'],)).fetchall()
    total = len(rows)
    avg = round(sum(r['score'] for r in rows) / total, 1) if total else 0
    by_area = {a: {'n': 0, 'sum': 0} for a in AREAS}
    for r in rows:
        a = r['area'] if r['area'] in by_area else 'CM'
        by_area[a]['n'] += 1; by_area[a]['sum'] += r['score']
    area_avg = {a: round(v['sum'] / v['n'], 1) if v['n'] else None for a, v in by_area.items()}
    done = c.execute("SELECT COUNT(DISTINCT station_id) n FROM pep_results WHERE user_id=?", (u['id'],)).fetchone()['n']
    c.close()
    return {'total': total, 'avg': avg, 'stations_done': done,
            'by_area': area_avg, 'recent': [dict(r) for r in rows[:20]]}

@app.post('/api/disputes')
async def dispute(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    c = conn()
    c.execute("INSERT INTO disputes(station_id,item_idx,user_id,reason,created_at) VALUES(?,?,?,?,?)",
              (b.get('station_id'), b.get('item_idx'), u['id'], (b.get('reason') or '')[:500], int(time.time())))
    sid = b.get('station_id')
    st = c.execute("SELECT checklist FROM stations WHERE id=?", (sid,)).fetchone()
    total_items = max(1, len(json.loads(st['checklist']))) if st else 1
    open_d = c.execute("SELECT COUNT(DISTINCT item_idx) n FROM disputes WHERE station_id=? AND status='open'", (sid,)).fetchone()['n']
    frozen = False
    if open_d / total_items > 0.4:
        c.execute("UPDATE stations SET frozen=1 WHERE id=?", (sid,)); frozen = True
    c.commit(); c.close()
    return {'ok': True, 'frozen': frozen, 'open_disputes': open_d, 'threshold': 0.4}

@app.get('/api/admin/disputes')
async def disputes_list(req: Request):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    c = conn()
    rows = c.execute("""SELECT d.*, s.tema, s.frozen FROM disputes d
                        LEFT JOIN stations s ON s.id=d.station_id ORDER BY d.id DESC LIMIT 100""").fetchall()
    c.close()
    return {'disputes': [dict(r) for r in rows]}

@app.post('/api/admin/disputes/{did}/resolve')
async def dispute_resolve(req: Request, did: int):
    u = auth_user(req)
    if not require_admin(u): return JSONResponse({'error': 'admin'}, 403)
    b = await req.json()
    c = conn()
    d = c.execute("SELECT * FROM disputes WHERE id=?", (did,)).fetchone()
    if d:
        c.execute("UPDATE disputes SET status=? WHERE id=?", (b.get('status', 'resolved'), did))
        if b.get('unfreeze'): c.execute("UPDATE stations SET frozen=0 WHERE id=?", (d['station_id'],))
        if b.get('fix_item') is not None:
            st = c.execute("SELECT checklist FROM stations WHERE id=?", (d['station_id'],)).fetchone()
            cl = json.loads(st['checklist'])
            if 0 <= d['item_idx'] < len(cl):
                cl[d['item_idx']] = b['fix_item']
                c.execute("UPDATE stations SET checklist=? WHERE id=?",
                          (json.dumps(cl, ensure_ascii=False), d['station_id']))
    c.commit(); c.close()
    return {'ok': True}

# ----------------------------------------------------------------- salas (REST) + WS hub
def room_dict(r):
    d = dict(r)
    d['station_ids'] = json.loads(d['station_ids'])
    d['open'] = bool(d['open'])
    return d

@app.get('/api/rooms')
async def rooms_list(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn()
    rows = c.execute("SELECT * FROM rooms WHERE open=1 ORDER BY created_at DESC").fetchall()
    c.close()
    return {'rooms': [room_dict(r) for r in rows]}

@app.post('/api/rooms')
async def room_create(req: Request):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    b = await req.json()
    sids = b.get('station_ids') or []
    if not sids:
        return JSONResponse({'error': 'selecione ao menos uma estação'}, 400)
    c = conn()
    if u['role'] not in ('admin', 'root'):
        mine = c.execute("SELECT code FROM rooms WHERE creator_id=?", (u['id'],)).fetchall()
        for m in mine: c.execute("DELETE FROM rooms WHERE code=?", (m['code'],))  # regra da sala única
    code = uuid.uuid4().hex[:6].upper()
    c.execute("INSERT INTO rooms VALUES(?,?,?,?,?,?,?,?,?)",
              (code, (b.get('name') or 'Sala de treino')[:80], json.dumps(sids), sids[0],
               b.get('rtype', 'ppl'), 1 if b.get('open', True) else 0,
               u['id'], u['name'], int(time.time())))
    c.commit(); c.close()
    return {'ok': True, 'code': code}

@app.delete('/api/rooms/{code}')
async def room_delete(req: Request, code: str):
    u = auth_user(req)
    if not u: return JSONResponse({'error': 'auth'}, 401)
    c = conn()
    r = c.execute("SELECT * FROM rooms WHERE code=?", (code,)).fetchone()
    if not r or (r['creator_id'] != u['id'] and u['role'] not in ('admin', 'root')):
        c.close(); return JSONResponse({'error': 'sem permissão'}, 403)
    c.execute("DELETE FROM rooms WHERE code=?", (code,))
    c.commit(); c.close()
    hub.rooms.pop(code, None)
    return {'ok': True}

# ---------------- Hub WebSocket: presença, chat, timer, sinalização WebRTC
class RoomState:
    def __init__(self):
        self.members = {}            # uid -> {ws, name, role}
        self.timer = {'state': 'idle', 'ends_at': None, 'remain': 600}
        self.task = None
        self.obs_hidden = []         # chat oculto de observadores

class Hub:
    def __init__(self):
        self.rooms = {}              # code -> RoomState
        self.lobby = {}              # uid -> {ws, name}

hub = Hub()

async def ws_send(ws, typ, **kw):
    await ws.send_text(json.dumps({'t': typ, **kw}, ensure_ascii=False))

async def broadcast(code, typ, exclude=None, **kw):
    rs = hub.rooms.get(code)
    if not rs: return
    dead = []
    for uid, m in rs.members.items():
        if uid == exclude: continue
        try: await ws_send(m['ws'], typ, **kw)
        except Exception: dead.append(uid)
    for uid in dead: rs.members.pop(uid, None)

async def lobby_broadcast(typ, **kw):
    dead = []
    for uid, m in hub.lobby.items():
        try: await ws_send(m['ws'], typ, **kw)
        except Exception: dead.append(uid)
    for uid in dead: hub.lobby.pop(uid, None)

def timer_payload(rs):
    if rs.timer['state'] == 'running':
        remain = max(0, int(rs.timer['ends_at'] - time.time()))
    else:
        remain = rs.timer['remain']
    return {'state': rs.timer['state'], 'remain': remain}

async def timer_tick(code):
    rs = hub.rooms.get(code)
    if not rs: return
    alerted = set()
    while True:
        await asyncio.sleep(1)
        if rs.timer['state'] != 'running': continue
        remain = int(rs.timer['ends_at'] - time.time())
        for mark in (180, 60):
            if remain <= mark and mark not in alerted:
                alerted.add(mark)
                await broadcast(code, 'timer:alert', remain=remain, mark=mark)
        if remain <= 0:
            rs.timer = {'state': 'idle', 'ends_at': None, 'remain': 600}
            await broadcast(code, 'timer', **timer_payload(rs))
            await broadcast(code, 'timer:alert', remain=0, mark=0)

@app.websocket('/ws')
async def ws(ws: WebSocket):
    token = ws.query_params.get('token', '')
    c = conn()
    s = c.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?",
                  (token, int(time.time()))).fetchone()
    c.close()
    if not s:
        await ws.close(code=4401); return
    await ws.accept()
    uid, name = s['id'], s['name']
    hub.lobby[uid] = {'ws': ws, 'name': name}
    current_room = None
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            t = msg.get('t')

            if t == 'room:join':
                code = msg.get('code', '').upper()
                c = conn()
                r = c.execute("SELECT * FROM rooms WHERE code=?", (code,)).fetchone()
                c.close()
                if not r:
                    await ws_send(ws, 'error', msg='sala não encontrada'); continue
                rs = hub.rooms.setdefault(code, RoomState())
                role = msg.get('role', 'observer')
                if r['creator_id'] == uid: role = msg.get('role', 'evaluator')
                rs.members[uid] = {'ws': ws, 'name': name, 'role': role}
                current_room = code
                if rs.task is None: rs.task = asyncio.create_task(timer_tick(code))
                rd = room_dict(r)
                await ws_send(ws, 'room:state', room=rd, timer=timer_payload(rs),
                              members=[{'id': m2, 'name': m['name'], 'role': m['role']}
                                       for m2, m in rs.members.items()])
                await broadcast(code, 'room:members', exclude=uid,
                                members=[{'id': m2, 'name': m['name'], 'role': m['role']}
                                         for m2, m in rs.members.items()])
                await lobby_broadcast('room:live', code=code, live=True)

            elif t == 'chat:room' and current_room:
                await broadcast(current_room, 'chat:room',
                                **{'from': name, 'text': msg.get('text', '')[:1000]})

            elif t == 'chat:obs' and current_room:
                # chat oculto: só observadores veem agora; guardado para revelar no fim
                rs = hub.rooms[current_room]
                entry = {'from': name, 'text': msg.get('text', '')[:1000], 'ts': int(time.time())}
                rs.obs_hidden.append(entry)
                for m2, m in rs.members.items():
                    if m['role'] == 'observer':
                        try: await ws_send(m['ws'], 'chat:obs', **entry)
                        except Exception: pass

            elif t == 'chat:lobby':
                c = conn()
                c.execute("INSERT INTO chat_archive(scope,ref,user_name,text,created_at) VALUES('lobby','',?,?,?)",
                          (name, msg.get('text', '')[:1000], int(time.time())))
                c.commit(); c.close()
                await lobby_broadcast('chat:lobby', **{'from': name, 'text': msg.get('text', '')[:1000]})

            elif t == 'room:station' and current_room:
                c = conn()
                r = c.execute("SELECT * FROM rooms WHERE code=?", (current_room,)).fetchone()
                if r and (r['creator_id'] == uid or s['role'] in ('admin', 'root')):
                    sid = msg.get('station_id')
                    if sid in json.loads(r['station_ids']):
                        c.execute("UPDATE rooms SET active_station=? WHERE code=?", (sid, current_room))
                        c.commit()
                        await broadcast(current_room, 'room:station', station_id=sid)
                c.close()

            elif t == 'timer:ctl' and current_room:
                rs = hub.rooms[current_room]
                action = msg.get('action')
                if action == 'start':
                    dur = int(msg.get('seconds') or rs.timer['remain'] or 600)
                    rs.timer = {'state': 'running', 'ends_at': time.time() + dur, 'remain': dur}
                elif action == 'pause' and rs.timer['state'] == 'running':
                    rs.timer = {'state': 'paused', 'ends_at': None,
                                'remain': max(0, int(rs.timer['ends_at'] - time.time()))}
                elif action == 'resume' and rs.timer['state'] == 'paused':
                    rs.timer = {'state': 'running', 'ends_at': time.time() + rs.timer['remain'],
                                'remain': rs.timer['remain']}
                elif action == 'reset':
                    rs.timer = {'state': 'idle', 'ends_at': None, 'remain': int(msg.get('seconds') or 600)}
                elif action == 'adjust':
                    extra = int(msg.get('delta', 0))
                    if rs.timer['state'] == 'running':
                        rs.timer['ends_at'] += extra
                    else:
                        rs.timer['remain'] = max(0, rs.timer['remain'] + extra)
                await broadcast(current_room, 'timer', **timer_payload(rs))

            elif t == 'room:finish' and current_room:
                rs = hub.rooms[current_room]
                await broadcast(current_room, 'chat:obs:reveal', items=rs.obs_hidden)
                rs.obs_hidden = []

            # -------- sinalização WebRTC (relay) --------
            elif t in ('rtc:offer', 'rtc:answer', 'rtc:ice', 'rtc:bye') and current_room:
                rs = hub.rooms[current_room]
                target = rs.members.get(msg.get('to'))
                if target:
                    await ws_send(target['ws'], t, **{'from': uid, 'data': msg.get('data')})

    except WebSocketDisconnect:
        pass
    finally:
        hub.lobby.pop(uid, None)
        if current_room and current_room in hub.rooms:
            rs = hub.rooms[current_room]
            rs.members.pop(uid, None)
            await broadcast(current_room, 'room:members',
                            members=[{'id': m2, 'name': m['name'], 'role': m['role']}
                                     for m2, m in rs.members.items()])
            if not rs.members:
                if rs.task: rs.task.cancel()
                hub.rooms.pop(current_room, None)
                await lobby_broadcast('room:live', code=current_room, live=False)

# ----------------------------------------------------------------- estático / SPA
@app.get('/api/health')
async def health():
    c = conn()
    n = c.execute("SELECT COUNT(*) n FROM stations").fetchone()['n']
    c.close()
    return {'ok': True, 'stations': n, 'version': '4.0-python'}

@app.get('/')
async def index():
    return FileResponse(os.path.join(STATIC, 'index.html'))

app.mount('/static', StaticFiles(directory=STATIC), name='static')

@app.on_event('startup')
async def boot():
    n = init()
    print(f"[pratica.M3D v4] banco pronto — {n} estações")
