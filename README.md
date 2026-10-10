# pratica.M3D v4 — Plataforma OSCE / Revalida (Python)

Reelaboração completa em **Python (FastAPI + WebSockets) + SQLite**, substituindo o backend Node.js legado. Mantém todas as funcionalidades (videochamada WebRTC mesh, PEP com correção IA e disputa, SRS, timer sincronizado, chat em tempo real) e adiciona **diagnóstico real da cadeia de IA**, **importação/exportação de pacotes de estações (XLSX/JSON)** e **cards de revisão com fluxogramas do Ministério da Saúde**.

## ⚠️ Segurança (leia primeiro)
O `server.js` legado expunha **chaves reais** (Gemini ×2, OpenAI, Pollinations) em texto claro.
**Revogue todas essas chaves** e configure as novas exclusivamente via variáveis de ambiente — a v4 **não contém nenhuma chave embutida**.

## Instalação

```bash
cp .env.example .env        # preencha GEMINI_API_KEY / OPENAI_API_KEY (opcional)
./run.sh                    # ou: pip install -r requirements.txt && uvicorn app.main:app --port 3000
```

Acesse **http://localhost:3000**. O banco `data/pratica_m3d.sqlite` é criado no 1º boot e semeado com as **428 estações** da planilha fornecida (`data/seed_stations.json`).
Admin master: **root / @0Arcano** (troque a senha no perfil).

## O que mudou nesta versão

| Problema relatado | Correção na v4 |
|---|---|
| IA falhava sem diagnóstico ao gerar estações | Painel **"testar provedores"** (`/api/ai/status`) testa Gemini/OpenAI/Pollinations ao vivo com latência e erro real; **todas as chamadas são logadas** (`ai_calls`) e visíveis no painel; geração de estação devolve o provedor usado e o erro agregado quando todos falham |
| Videochamada sem gestão de conexão | Estado ICE visível por peer na sala, controles mic/câmera/tela (replaceTrack), **fallback SDP manual** (copiar/colar) 100% offline |
| Importação de estações limitada | Importação **XLSX (aba "Estações", cabeçalho flexível com aliases)** e **JSON** com criação/atualização por id (`overwrite`), deduplicação automática e relatório criadas/atualizadas/ignoradas; **exportação de pacotes** (todas ou seleção por ids) |
| Cards de revisão estáticos | **Fluxogramas didáticos em PNG gerados no servidor** (matplotlib, offline) a partir de spec gerada pela IA — com **fallback XABCDE local** se a IA estiver fora — + **capa ilustrativa por IA de imagem** (Pollinations, sem chave) |

## Estrutura

```
app/main.py        REST + hub WebSocket (presença, chat, chat oculto, timer, relay WebRTC)
app/ai.py          cadeia de failsafe Gemini→OpenAI→Pollinations + logging + diagnóstico
app/db.py          schema SQLite (WAL) + seed das 428 estações
app/stations_io.py importação XLSX/JSON e exportação de pacotes
app/flowcards.py   renderização dos fluxogramas (matplotlib) + capa IA
static/index.html  SPA completa (Tailwind, sem build)
data/              banco, seed, planilha original e frontend legado (referência)
```

## Endpoints principais

- Auth: `POST /api/register|login|forgot|reset`, `GET /api/me`, `POST /api/profile`, `POST /api/admin/set_role` (root)
- Estações: `GET/POST/PUT/DELETE /api/stations`, `POST /api/stations/import` (xlsx/json, `?overwrite=1`), `GET /api/stations/export/package?ids=...`
- IA: `GET /api/ai/status|logs`, `POST /api/ai/generate_station|patient|correct_pep|coach|ask`
- Simulação: `POST/GET/DELETE /api/rooms`, `POST /api/pep|disputes`, `GET /api/analytics`
- Estudo: `POST /api/srs/generate|review`, `GET /api/srs/due`, `POST /api/flowcards`, `GET /api/flowcards`
- Tempo real: `WS /ws?token=...` — eventos `room:join/state/members/station`, `timer:ctl/timer/timer:alert`, `chat:room/obs/lobby`, `rtc:offer/answer/ice/bye`

## Formato XLSX aceito (aba "Estações")

Colunas (case-insensitive, com aliases): `id, tema, area, especialidade, nivel, duracao, fonte, instrucoes, cenario, roteiro_ator, protocolo, exames, checklist` — `exames`/`checklist` aceitam JSON ou itens separados por `;`/`|`.

## WebRTC em produção

WebRTC exige **HTTPS** fora de localhost (o navegador bloqueia câmera/mic em HTTP). Suba atrás de um reverse proxy com TLS (Caddy/Nginx) e mantenha os STUNs do Google (já configurados); o estado ICE por peer aparece na sala para diagnóstico.
