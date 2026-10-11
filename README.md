# Revalida Prático

App completo para treino da 2ª fase prática do Revalida INEP: estações clínicas com checklist PEP,
videoconferência multiusuário (Agora) e modos Solo, Dupla e Observadores.

## Stack

| Camada            | Tecnologia                                             |
|-------------------|--------------------------------------------------------|
| Front-end         | React 18 + Vite (visual do protótipo aprovado)         |
| API + tempo real  | Node.js (Express + Socket.IO)                          |
| Vídeo             | Agora RTC (token no servidor, failsafe e modo demo)    |
| Banco             | PostgreSQL 16 (`db/schema.sql`)                        |
| Token reserva     | PHP (`php/token.php`, proxy failsafe)                  |
| Semente de dados  | Python (`python/seed.py`)                              |

## Subida rápida (Docker)

```bash
cp server/.env.example server/.env   # preencha AGORA_APP_ID e AGORA_APP_CERTIFICATE
docker compose up --build
# em outro terminal, semear as estações de exemplo:
pip install psycopg[binary] && python python/seed.py
```

Abra http://localhost:5173 — duas abas/janelas entram na mesma sala e as câmeras aparecem para todos.

## Subida manual

```bash
# banco
psql $DATABASE_URL -f db/schema.sql
python python/seed.py

# api (porta 3001)
cd server && npm install && npm run dev

# web (porta 5173)
cd web && npm install && npm run dev
```

## Failsafe de vídeo (ordem de tentativa)

1. `GET /api/sessoes/:id/agora-token` (Node) emite token com papel vindo do banco.
2. Falhou? o front tenta `php/token.php` (endpoint reserva).
3. Sem credenciais Agora configuradas? o servidor responde `modo:"demo"` e a sala
   abre com telas simuladas, cronômetro e checklist 100% funcionais — nada quebra.

O cliente renova o token antes de expirar (`token-privilege-will-expire`), reentra
sozinho em queda de rede (`connection-state-change`) e o observador nunca publica
áudio/vídeo.

## Segurança

- Senha com bcrypt; sessão via JWT; regras de papel conferidas no servidor, nunca no cliente.
- O candidato não recebe PEP nem marcações até a finalização.
- Chaves Agora ficam só no servidor (`.env`), nunca no front.
