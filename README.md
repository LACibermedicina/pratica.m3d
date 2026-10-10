# pratica.M3D v6 — Plataforma OSCE / Revalida

Reelaboração completa em **Node.js (Express + Socket.io) + SQLite (better-sqlite3/WAL)**.
Foco: **performance**, **videoconferência resiliente**, **cards sem dados ilustrativos falsos**,
**layout imersivo** com a nova logo e **UX WCAG 2.1**.

## Paridade e evolução vs v5 (PHP)

| Módulo | v5 (PHP) | v6 (Node) — como foi resolvido |
|---|---|---|
| Transporte REST | PHP próprio + regex | **Express 4** (`src/routes.js`), 40+ endpoints, RBAC por middleware |
| Tempo real | SSE + polling | **Socket.io** (`src/realtime.js`), presença, mark, timer, sinalização WebRTC, chat |
| Vídeo | WebRTC mesh via SSE | **WebRTC P2P mesh** (`public/js/video.js`) com **watchdog ~8 s** → **failsafe Agora** (token 007 feito no servidor em `src/agora.js`) |
| IA | Gemini → OpenAI → Pollinations (cURL) | Mesma cadeia (`src/ai.js`) via `fetch`, logada em `ai_calls`; chaves só no servidor |
| Correção PEP | Síncrona | **Assíncrona** — fecha o PEP, IA responde depois (não trava o fluxo) |
| XLSX | Leitor ZIP/XLSX manual | **xlsx** (SheetJS) no servidor + no cliente |
| Fluxograma | SVG procedural + XABCDE | Idem (`src/flowcards.js`), **sem imagem/dado fake**: spec real da IA ou template XABCDE |
| Banco | PDO SQLite | **better-sqlite3** síncrono, mesmas PRAGMAs (WAL/FK/busy_timeout) |
| Auth | bcrypt + Bearer | **bcryptjs** + Bearer de 30 dias + Socket.io auth no handshake |
| Logo | SVG inline no PHP | Mesma marca, **SVG ES-module** (`public/js/logo.js`) com breathing animation |
| UI | Tailwind CDN | Mesma stack, agora com **skip-link, aria-live, focus visible, alvos ≥44 px** (WCAG 2.1 AA) |

## Estrutura

```
m3d-v6/
├─ src/
│  ├─ server.js        # Express + Socket.io + estáticos + SPA fallback
│  ├─ config.js        # Lê .env — nenhuma chave no código
│  ├─ db.js            # better-sqlite3 (WAL), schema, seed (428 estações)
│  ├─ auth.js          # bcrypt, sessões Bearer, RBAC, Socket.io auth
│  ├─ ai.js            # Gemini → OpenAI → Pollinations, logs em ai_calls
│  ├─ agora.js         # Token RTC 007 — certificado só no servidor
│  ├─ flowcards.js     # SVG vetorial do fluxograma + XABCDE
│  ├─ stations_io.js   # Import XLSX/JSON, export XLSX/JSON
│  ├─ rooms.js         # Timer autoritativo, marcação, PEP+IA, disputa, SRS
│  ├─ realtime.js      # Socket.io: salas, presença, sinalização, chat
│  └─ routes.js        # 40+ rotas REST
├─ public/
│  ├─ index.html       # Shell + skip-link + landmarks
│  ├─ app.css          # Tema teal/coral animado + utilidades WCAG
│  ├─ favicon.svg      # Logo (reconstruída à mão)
│  └─ js/
│     ├─ app.js        # SPA (dash, salas, catálogo, SRS, flowcards, PEP, admin)
│     ├─ logo.js       # Logo em SVG ES-module
│     └─ video.js      # WebRTC + watchdog + failsafe Agora
├─ data/seed_stations.json   # 428 estações (importadas na primeira execução)
├─ .env.example       # Modelo de configuração — copie para .env
├─ run.sh             # ./run.sh (instala deps e sobe)
└─ README.md
```

## Como rodar

```bash
cp .env.example .env    # defina ROOT_PASSWORD e, se quiser, IA e AGORA
npm install
npm start               # ou: ./run.sh
# http://localhost:3000  — login root / @0Arcano (ou o que estiver no .env)
```

Primeira execução importa automaticamente `data/seed_stations.json` (428 estações).

## Videoconferência — como o failsafe funciona

1. Cliente obtém `iceServers` + `agora.available` em `GET /api/video/config` (sem credencial).
2. Captura mídia local e inicia **WebRTC P2P mesh** com todos os participantes conhecidos (sinalização em `rtc:signal` do Socket.io).
3. Um **watchdog de 8 s** (configurável em `P2P_WATCHDOG_MS`) verifica se algum peer alcançou `connected/completed`.
4. Se não, migra automaticamente para **Agora**: carrega o SDK sob demanda, pede token em `POST /api/agora/token` (gerado no servidor via `src/agora.js`, formato 007) e republicam mídia no mesmo canal `m3d-<code>`.
5. Qualquer cliente pode anunciar `rtc:mode = agora` para que todos migrem juntos.

Se `AGORA_APP_ID`/`AGORA_APP_CERT` não estiverem definidos, o cliente mostra `vídeo: indisponível` e segue com áudio/chat — nenhum crash.

## IA — cadeia de failsafe

Toda chamada passa por `aiChat`/`aiJson`: tenta **Gemini → OpenAI → Pollinations** e registra provedor, modelo, latência e erro em `ai_calls` (visível em `GET /api/ai/logs`, restrito a root/admin). O frontend fala apenas com `/api/ai/*` — nenhuma chave vaza.

## Cards de procedimento — sem dado ilustrativo falso

`POST /api/flowcards` pede à IA um **spec real** `{title, fonte, steps:[{t,text}]}`. Se falhar, cai no template **XABCDE** local (`src/flowcards.js :: xabcdeSpec`), que é um protocolo oficial — não é dado inventado para "preencher". O SVG é desenhado passo a passo a partir desse spec e o `summary` é literal — nenhum texto é fabricado.

## Acessibilidade (WCAG 2.1 AA)

- Skip-link para o conteúdo (`#main`), landmarks `header/main/nav/section`, títulos com `aria-labelledby`.
- Toasts e badge de conexão com `role="status"` e `aria-live="polite"`.
- Alvos de toque ≥ 44 px, foco visível de alto contraste.
- Contraste texto/fundo verificado em todos os componentes.
- Respeita `prefers-reduced-motion` (desliga animações).

## Segurança

- Credenciais **somente** em `.env` (ignorado no `.gitignore`).
- Bearer Token (30 dias) + revogação em `POST /api/logout` e no banimento.
- Headers `X-Content-Type-Options`, `Referrer-Policy`, `express.disable('x-powered-by')`.
- Token Agora assinado no servidor (certificado nunca vai ao cliente).
- RBAC: `root` cria admins; `root/admin` importam catálogo, geram estações por IA e veem logs de IA.

> **Importante:** você compartilhou chaves reais na conversa anterior (Gemini, OpenAI, Pollinations, certificado Agora, token GitHub). **Revogue/regenere TODAS** antes do deploy e coloque os novos valores apenas em `.env`.
