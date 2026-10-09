# pratica.M3D — M3D OSCE Platform (Node.js + Socket.io + SQLite)

Sistema de Simulação Clínica OSCE / Revalida com estações práticas, **videochamada WebRTC P2P (mesh)**, **paciente virtual com IA**, **correção automatizada do PEP** e dashboard com KPIs — tudo em tempo real via WebSockets (sem polling HTTP).

## Arquivos
| Arquivo | Função |
|---|---|
| `server.js` | Backend Node.js completo: Express (API REST) + Socket.io (chat, reações, cards, presença, sinalização WebRTC) + SQLite (`better-sqlite3`) + proxy de IA com failsafe |
| `public/index.html` | Frontend SPA responsivo (mobile & desktop): Tailwind CSS (CDN) + identidade visual M3D, painéis de sala, WebRTC, chat, timer, checklist PEP, gráficos, tour guiado |
| `package.json` | Dependências: `express`, `socket.io`, `better-sqlite3`, `bcryptjs` |
| `pratica_m3d.sqlite` | Banco criado automaticamente na primeira execução |

## Instalação
```bash
npm install
npm start
```
Acesse **http://localhost:3000** — o banco `pratica_m3d.sqlite` é criado sozinho.

- **Login administrador:** `root` / `@0Arcano` (troque depois).
- Requer **Node.js 18+** (usa `fetch` nativo).

## Variáveis de ambiente (IA — cadeia de failsafe)
As chaves ficam **somente no servidor**; o frontend chama `/api/ai` e o servidor tenta em ordem **Gemini → OpenAI → Pollinations**:

| Variável | Padrão |
|---|---|
| `GEMINI_API_KEY` | chave Gemini do projeto |
| `GEMINI_MODEL` | `gemini-flash-latest` |
| `OPENAI_API_KEY` | *(vazio — configure para ativar o 2º nível)* |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `POLLINATIONS_TOKEN` | token Pollinations do projeto |
| `PORT` | `3000` |

## Recursos
- **Auth:** registro/login com `bcrypt`, sessão Bearer de 30 dias (persiste ao fechar o navegador), recuperação de senha por token.
- **Papéis:** `root` (único que promove admins via `set_role`), `admin` (gestão de estações/usuários, relatórios), e na sala: 🩺 Médico, 🎭 Ator, 👑 Chefe de Banca, 👀 Espectador. Root e admins **não podem ser excluídos**.
- **Salas:** exigem ≥1 estação (multi-seleção com troca da estação ativa em tempo real pelo criador), abertas ou fechadas, link de convite `?sala=CÓDIGO` (WhatsApp 🟢) que entra direto mesmo em sala fechada, agregação posterior de membros (➕ Convidar) com prioridade para usuários online 🟢.
- **Tempo real (Socket.io):** chat do lobby e da sala, reações com emoji ao vivo, cards de auxílio compartilháveis, presença online e **sinalização WebRTC mesh** (offer/answer/ICE/hello/bye) com STUN do Google. Fallback de **sinalização manual** (copiar/colar SDP).
- **Videochamada:** `getUserMedia`, mute/câmera, compartilhamento de tela via `replaceTrack`, grade de vídeos responsiva, entrada recv-only para espectadores.
- **IA:** paciente virtual com voz (`SpeechSynthesis` pt-BR) e ditado (`SpeechRecognition`), geração de estações no padrão INEP, enriquecimento de checklist, **toggle 🤖 Correção IA** (transcreve o áudio da estação e pontua o PEP item a item em contexto válido) e **card de revisão didático** (fortes/fracos/sugestões) reaberto pelo Histórico.
- **Catálogo:** 15 estações seed padrão INEP, busca e filtros por grande área (CM/CIR/GO/PED/MFC), importação `.xlsx` (aba "Estações") e JSON, exportação.
- **Dashboard:** 4 KPIs, barras por grande área, rosca de desempenho geral, histórico com botões 🗂 Revisão e 📋 Resumo (imprimível em PDF).

## Estrutura do banco
`users` · `sessions` · `rooms` · `room_members` · `stations` · `history` (performance + card de revisão JSON).
