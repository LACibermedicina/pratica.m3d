# pratica.M3D v5 — Plataforma OSCE / Revalida

Reelaboração completa em **PHP 8 + SQLite (PDO/WAL)** da plataforma `pratica.M3D v4`
(que era Python/FastAPI). Mesmas funcionalidades, mesma experiência de estudo —
**sem etapa de build**, sem Node.js e sem Socket.io.

| v4 (Python) | v5 (PHP) — como foi resolvido |
|---|---|
| FastAPI + rotas decoradas | **Roteador próprio** em `index.php` + `app/api*.php` (regex → handler) |
| WebSockets (Socket.io) | **SSE** (`/sse`) + POSTs de ação gravando na tabela `events` |
| `sqlite3` stdlib | **PDO SQLite** com `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` |
| `bcrypt` (pip) | **`password_hash()` / `password_verify()`** (bcrypt nativo) |
| `httpx` async | **cURL** com a mesma cadeia de failsafe e o mesmo log em `ai_calls` |
| `matplotlib` (PNG) | **SVG vetorial gerado por código** — nítido em qualquer tela e impressão |
| `openpyxl` (import XLSX) | **Leitor ZIP/XLSX escrito à mão** (sem extensão `zip`) + SheetJS no navegador |
| `uvicorn` | `php -S` (dev) ou **Apache/Nginx + PHP-FPM** (produção) |

---

## ⚠️ Segurança (leia primeiro)

O `server.js` legado (e o backend Python que o substituiu) circulou com **chaves reais**
expostas (Gemini ×2, OpenAI, Pollinations). A v5 **não contém nenhuma chave embutida**:

* todas as credenciais ficam em **`.env`**, lido **exclusivamente pelo PHP**;
* o navegador só fala com `/api/ai/*` — nenhuma chave chega ao frontend;
* há um teste automatizado que **falha** se qualquer chave aparecer no HTML ou no `app.js`.

> **Revogue todas as chaves antigas** antes de subir a v5.

---

## Instalação

```bash
cp .env.example .env     # preencha GEMINI_API_KEY / OPENAI_API_KEY (opcional)
./run.sh                 # sobe em http://localhost:3000
```

Requisitos: **PHP ≥ 8.0** com `pdo_sqlite`, `curl`, `mbstring`, `json`.

```bash
# Debian/Ubuntu
sudo apt-get install -y php-cli php-sqlite3 php-curl php-mbstring

# verificação rápida
curl -s localhost:3000/health
```

No primeiro boot o banco `storage/pratica_m3d.sqlite` é criado e **semeado com as 428
estações** de `data/seed_stations.json` (extraídas da planilha Revalida fornecida).

**Admin master:** `root@pratica.m3d` / `@0Arcano` (defina `ROOT_PASSWORD` no `.env` e troque após o 1º login).
A conta `root` é **imune** a exclusão e a rebaixamento de papel.

---

## Estrutura

```
index.php              roteador único: /api/*, /sse, /cards/*.svg, /assets/*, SPA
app/bootstrap.php      constantes + leitura do .env + autoload dos módulos
app/db.php             schema SQLite (WAL) + seed das 428 estações + eventos SSE
app/auth.php           registro, login, reset, perfil, RBAC (root promove/revoga)
app/ai.php             cadeia Gemini → OpenAI → Pollinations + log + diagnóstico ao vivo
app/flowcards.php      resumo prático por IA + fluxograma VETORIAL (SVG) + biblioteca
app/stations_io.php    leitor XLSX em PHP puro, import/export, normalização e upsert
app/api.php            rotas de auth, catálogo, import/export, KPIs
app/api_ai.php         rotas de IA (estação, paciente, correção de PEP, coach, cards)
app/api_room.php       salas, presença, timer autoritativo, chats, relay WebRTC, PEP, disputa
app/api_study.php      SRS (1·3·7·15·30 dias)
app/sse.php            barramento de tempo real (substitui Socket.io)
app/logo.php           logomarca como SVG escrito à mão (nenhum arquivo de imagem)
app/views/             SPA (head.php, layout.php)
public/assets/         app.css, app.js, favicon.svg  (sem build, Tailwind via CDN)
data/                  seed_stations.json + estacoes.xlsx (428 estações)
storage/               banco SQLite (WAL), fora do controle de versão
tests/smoke.sh         65 verificações ponta a ponta (sobe o servidor e testa as rotas)
```

---

## Endpoints principais

**Identidade & RBAC**
`POST /api/register` · `POST /api/login` · `POST /api/logout` · `POST /api/forgot` · `POST /api/reset`
`GET /api/me` · `POST /api/profile` · `GET /api/admin/users` · `POST /api/admin/set_role` (root) · `GET /api/admin/audit`

**Catálogo & dados**
`GET /api/stations` (filtros `q`, `area`, `nivel`, paginação) · `GET|POST|PUT|DELETE /api/stations/{id}`
`POST /api/stations/import` (XLSX convertido ou JSON, `overwrite=1`) · `GET /api/stations/export?ids|area`
`POST /api/stations/sync` (reimporta `data/estacoes.xlsx`) · `GET /api/meta`

**IA (proxy seguro)**
`GET /api/ai/status` · `GET /api/ai/logs` · `POST /api/ai/generate_station` · `POST /api/ai/patient`
`POST /api/ai/correct_pep` · `POST /api/ai/coach` · `POST /api/ai/ask`

**Simulação**
`GET|POST /api/rooms` · `GET|DELETE /api/rooms/{code}` · `POST /api/rooms/{code}/join|leave|station|timer|chat|finish|rtc`
`POST /api/ping` · `POST /api/pep` · `GET /api/pep/results` · `POST|GET /api/disputes[/{id}]` · `GET /api/analytics` · `POST /api/chat/lobby` · `GET /api/chat/archive`

**Estudo** `GET /api/srs` · `GET /api/srs/due` · `POST /api/srs/generate|review` · `POST|GET /api/flowcards`
**Tempo real** `GET /sse?room=CODE&since=N` (eventos `chat:room`, `chat:obs`, `timer:ctl`, `room:station`, `room:members`, `rtc`, `pep:result`, `dispute:frozen`, `presence`)

---

## Módulos implementados

1. **Identidade, acesso & segurança** — cadastro/login/reset por token; sessões **Bearer de 30 dias** em
   `sessions`; bcrypt; **RBAC** com `root` (imune), `admin` (gestão, importação, IA geradora, auditoria,
   métricas globais) e `user`; perfil com avatar-emoji e **layout do painel reordenável por drag & drop**
   salvo no servidor (`users.layout`).
2. **Comunicação & videochamada** — **WebRTC mesh** com STUN do Google, relay de sinalização pelo servidor,
   mic/câmera, **troca de dispositivos** e **compartilhamento de tela via `replaceTrack`**;
   **fallback SDP manual** 100% offline (copiar/colar oferta/resposta) e diagnóstico ICE por par;
   chat do lobby (arquivado por hora), chat privado da sala e **chat oculto de observadores** revelado a todos no encerramento.
3. **Módulo de simulação (OSCE)** — regra de sala com ≥1 estação, **sala única** por usuário (admins mantêm várias),
   salas abertas/fechadas e com IA/usuários, **troca da estação ativa em tempo real**, papéis
   🩺/🎭/👀, **timer de 10 min validado no servidor** (start/pause/resume/reset/set, avisos em 3 min e 1 min + beep),
   galeria de exames (laboratório, ECG, raio-X, TC, RM, USG, ectoscopia, sorologias), **PEP com ✓/✗, barra de
   progresso e nota ponderada**, modo estudo e **contestação com congelamento acima de 40%**.
4. **IA & voz** — cadeia **Gemini → OpenAI → Pollinations** com log de cada tentativa (`ai_calls`) e painel
   que testa os três ao vivo; paciente virtual (responde só o perguntado, com `SpeechSynthesis` pt-BR e
   `SpeechRecognition`); **correção automática do PEP** item a item com citação em contexto e justificativa;
   geração de estações padronizadas ao INEP/SUS/XABCDE/OMS.
5. **Ferramentas didáticas** — **SRS** transformando itens do PEP em cartões (1·3·7·15·30 dias) e
   **coach de desempenho** com plano de estudo.
6. **Catálogo, dados & relatórios** — filtros por grande área (CM, CIR, GO, PED, MFC, com cores), nível e texto;
   **importação massiva XLSX** (aba "Estações", cabeçalho flexível com aliases, deduplicação e relatório) e JSON;
   **exportação de pacotes**; KPIs, **barras por área**, **rosca global** e resumo final imprimível em PDF.
7. **Arquitetura** — PHP 8 + PDO SQLite (WAL), SSE para tempo real, SPA Tailwind via CDN sem build.

### Cards de procedimento (diferenciais da v5)

* A IA recebe **o contexto da estação** (tema, área, especialidade, protocolo, cenário, instruções e o PEP
  completo) e devolve um **resumo prático de abordagem ponta a ponta** — do primeiro contato até a resolução —
  **mais** o roteiro do fluxograma em passos classificados (`inicio`, `avaliacao`, `conduta`, `alerta`, `reavaliacao`).
* O servidor **desenha o fluxograma em SVG vetorial** com gradientes e numeração (nada de IA de imagem);
  se a IA falhar, entra o **template XABCDE local**, então o card nunca fica vazio.
* O resultado é **gravado na biblioteca de cards do usuário** (`flowcards`), com busca, visualização em tela
  cheia e impressão/PDF.

---

## Logo

A logomarca é **SVG escrito à mão** em `app/logo.php` (cubo 3D translúcido em gradientes teal + cruz da saúde,
com animação de rotação no hover). Não existe nenhum arquivo de imagem para a marca — o ícone da aba é o mesmo
desenho em `public/assets/favicon.svg`. Para trocar a marca, edite só esse arquivo.

---

## Testes

```bash
bash tests/smoke.sh
```

Sobe o servidor numa porta livre, roda `php -l` em todos os arquivos e valida por HTTP:
autenticação e RBAC (401/403/root imune), catálogo (428 estações, 5 áreas, detalhe com PEP),
import/export com deduplicação, salas (incluindo a recusa de sala sem estação), timer que
**decrementa no servidor**, chats de sala e oculto, relay de sinalização, **SSE emitindo os eventos**,
PEP, **congelamento por contestação > 40%**, SRS, **fluxograma SVG** (vetorial, sem raster, protegido por login),
KPIs, diagnóstico de IA, auditoria e reset de senha.

> **Câmera e microfone exigem teste no navegador** e **HTTPS fora de localhost** — o navegador
> bloqueia `getUserMedia` em HTTP. Use Caddy/Nginx com TLS; a página de diagnóstico ICE da sala
> mostra o estado de cada par e há o fallback de SDP manual.

---

## Produção

Use Apache/Nginx + PHP-FPM apontando para a raiz do projeto (o `.htaccess` em `public/` já protege
`data/`, `storage/` e `app/`). Mantenha o `storage/` com permissão de escrita apenas para o usuário do PHP
e faça backup periódico do `.sqlite` (o modo WAL gera também os arquivos `-wal` e `-shm`).
