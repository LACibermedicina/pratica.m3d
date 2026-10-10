"""Importação XLSX/JSON e exportação de pacotes de estações.
Formato XLSX aceito: aba 'Estações' com cabeçalho contendo (flexível, case-insensitive):
  tema | area | especialidade | nivel | duracao | instrucoes | cenario |
  roteiro_ator (ou roteiroAtor) | protocolo | exames | checklist | fonte | id
- 'exames' e 'checklist' podem ser JSON, texto separado por ';' ou '|'.
- IDs duplicados geram sufixo automático; 'overwrite=1' atualiza pelo id.
Formato JSON: lista de objetos com os mesmos campos (exportado pela própria plataforma)."""
import json, time, uuid, io, openpyxl
from .db import conn, AREAS

FIELDS = ['id', 'tema', 'area', 'especialidade', 'nivel', 'duracao', 'fonte',
          'instrucoes', 'cenario', 'roteiro_ator', 'protocolo', 'exames', 'checklist']
ALIASES = {'roteiroator': 'roteiro_ator', 'roteiro': 'roteiro_ator', 'tema/titulo': 'tema',
           'titulo': 'tema', 'grande area': 'area', 'grande área': 'area',
           'duração': 'duracao', 'nível': 'nivel', 'instruções': 'instrucoes',
           'cenário': 'cenario', 'exames complementares': 'exames', 'pep': 'checklist'}

def _list(v):
    if v is None: return []
    if isinstance(v, list): return v
    s = str(v).strip()
    if not s: return []
    try:
        j = json.loads(s)
        return j if isinstance(j, list) else [j]
    except Exception:
        pass
    sep = '|' if '|' in s else ';'
    return [p.strip() for p in s.split(sep) if p.strip()]

def _norm_row(d):
    out = {}
    for k, v in d.items():
        key = ALIASES.get(str(k).strip().lower(), str(k).strip().lower())
        if key in FIELDS: out[key] = v
    out['exames'] = _list(out.get('exames'))
    out['checklist'] = _list(out.get('checklist'))
    return out

def upsert_station(c, s, overwrite=False):
    now = int(time.time())
    sid = str(s.get('id') or '').strip() or 'st-' + uuid.uuid4().hex[:8]
    area = str(s.get('area') or 'CM').upper().strip()
    if area not in AREAS: area = 'CM'
    exists = c.execute("SELECT 1 FROM stations WHERE id=?", (sid,)).fetchone()
    if exists and not overwrite:
        base, n = sid, 2
        while exists:
            sid = f"{base}-{n}"; n += 1
            exists = c.execute("SELECT 1 FROM stations WHERE id=?", (sid,)).fetchone()
    vals = (sid, str(s.get('tema') or 'Sem título')[:200], area,
            str(s.get('especialidade') or ''), str(s.get('nivel') or 'intermediário'),
            int(s.get('duracao') or 10), str(s.get('fonte') or ''),
            str(s.get('instrucoes') or ''), str(s.get('cenario') or ''),
            str(s.get('roteiro_ator') or ''), str(s.get('protocolo') or ''),
            json.dumps(s['exames'], ensure_ascii=False),
            json.dumps(s['checklist'], ensure_ascii=False), now, now)
    if exists:
        c.execute("""UPDATE stations SET tema=?,area=?,especialidade=?,nivel=?,duracao=?,fonte=?,
          instrucoes=?,cenario=?,roteiro_ator=?,protocolo=?,exames=?,checklist=?,updated_at=? WHERE id=?""",
          vals[1:13] + (vals[14], sid))
        return 'updated', sid
    c.execute("""INSERT INTO stations(id,tema,area,especialidade,nivel,duracao,fonte,instrucoes,
      cenario,roteiro_ator,protocolo,exames,checklist,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'import',?,?)""", vals)
    return 'created', sid

def import_xlsx(content, overwrite=False):
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
    sheet = 'Estações' if 'Estações' in wb.sheetnames else wb.sheetnames[0]
    ws = wb[sheet]
    rows = list(ws.iter_rows(values_only=True))
    # localiza a linha de cabeçalho (procura uma célula 'tema' ou 'estações' válida)
    hi, header = -1, []
    for i, r in enumerate(rows[:15]):
        low = [str(x).strip().lower() if x else '' for x in r]
        if any(x in ALIASES or x in FIELDS for x in low) and ('tema' in low or 'titulo' in low
           or 'tema/titulo' in low or 'id' in low):
            hi, header = i, low; break
    if hi < 0:
        hi, header = 0, [str(x).strip().lower() if x else '' for x in rows[0]]
    res = {'created': 0, 'updated': 0, 'skipped': 0, 'errors': []}
    c = conn()
    for r in rows[hi + 1:]:
        if not r or not any(r): continue
        d = {header[j]: r[j] for j in range(min(len(header), len(r))) if header[j]}
        s = _norm_row(d)
        if not s.get('tema'):
            res['skipped'] += 1; continue
        try:
            kind, _ = upsert_station(c, s, overwrite)
            res[kind] += 1
        except Exception as e:
            res['errors'].append(str(e)[:150])
    c.commit(); c.close()
    return res

def import_json(content, overwrite=False):
    data = json.loads(content.decode('utf-8') if isinstance(content, bytes) else content)
    if isinstance(data, dict): data = data.get('stations', [data])
    res = {'created': 0, 'updated': 0, 'skipped': 0, 'errors': []}
    c = conn()
    for raw in data:
        s = _norm_row(raw)
        if not s.get('tema'):
            res['skipped'] += 1; continue
        try:
            kind, _ = upsert_station(c, s, overwrite)
            res[kind] += 1
        except Exception as e:
            res['errors'].append(str(e)[:150])
    c.commit(); c.close()
    return res

def export_package(ids=None):
    c = conn()
    if ids:
        q = "SELECT * FROM stations WHERE id IN (%s)" % ','.join('?' * len(ids))
        rows = c.execute(q, ids).fetchall()
    else:
        rows = c.execute("SELECT * FROM stations").fetchall()
    c.close()
    out = []
    for r in rows:
        out.append({'id': r['id'], 'tema': r['tema'], 'area': r['area'],
                    'especialidade': r['especialidade'], 'nivel': r['nivel'],
                    'duracao': r['duracao'], 'fonte': r['fonte'],
                    'instrucoes': r['instrucoes'], 'cenario': r['cenario'],
                    'roteiro_ator': r['roteiro_ator'], 'protocolo': r['protocolo'],
                    'exames': json.loads(r['exames']), 'checklist': json.loads(r['checklist'])})
    return {'format': 'pratica-m3d-stations', 'version': 4,
            'exported_at': int(time.time()), 'count': len(out), 'stations': out}
