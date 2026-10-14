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

## Recuperação de senha e conta root

**Configuração** (`server/.env`, veja `.env.example`): `ROOT_EMAIL`, `ROOT_SENHA`, `APP_URL`, `JWT_SEGREDO`, e `SMTP_URL` (+ `npm i nodemailer`) para enviar e-mails.
Para bancos já existentes rode `db/migracoes/002_recuperacao_e_root.sql` (idempotente); bancos novos já recebem tudo pelo `schema.sql`.

**Conta root.** Na partida, a API cria `ROOT_EMAIL` com papel `root` (só pode haver um). A senha vem do ambiente, nunca do código, e fica no banco só como hash bcrypt.
Se a senha não cumprir a regra do app (como `arcano123`, com 9 caracteres), a conta fica *provisória*: o app mostra uma faixa pedindo a troca.
O root faz tudo que o admin faz e mais: tokens de vários usos, promover/rebaixar admins e moderadores e agir sobre admins. Ninguém altera o root pela API.
Perdeu a senha do root? Use "Esqueci minha senha" ou suba a API uma vez com `ROOT_SENHA_REDEFINIR=1`.
Não existe "senha mestra" que entre em qualquer conta: seria uma porta dos fundos.

**Recuperação de senha.** `POST /api/auth/recuperar` responde sempre igual (não revela se a conta existe), envia um link de 60 min e uso único (`APP_URL/#/redefinir/<token>`; o `#` mantém o token fora de logs do servidor). Só o hash do token fica no banco. Máximo de 3 e-mails/hora por endereço. Ao redefinir ou trocar a senha, todas as outras sessões caem.
`POST /api/auth/trocar-senha` (logado) exige a senha atual.

**Painel de administração** (aba Admin do app; o servidor confere cada ação lendo o papel atual no banco):
| Papel | Pode |
|---|---|
| moderador | revisar estações |
| admin | + pedidos de acesso (aprovar gera token de 1 uso preso ao e-mail), tokens de 1 uso, bloquear/desbloquear usuários comuns, gerar link de senha, registro de auditoria |
| root | tudo, inclusive tokens de vários usos e papéis de admin/moderador |

Pedidos de acesso agora são gravados (antes a rota só respondia a mensagem). Toda ação administrativa vai para `auditoria_admin`.
Login: 5 erros por IP+e-mail bloqueiam por 15 min. Bloquear alguém ou trocar a senha derruba as sessões na hora (o papel e o estado da conta são lidos do banco a cada requisição).

**Atenção:** a senha `arcano123` foi escrita em uma conversa e é fraca; use-a só para o primeiro acesso e troque em seguida. Em produção, defina `JWT_SEGREDO` forte (a API recusa subir sem ele com `NODE_ENV=production`) e ative HTTPS. Sessões antigas (sem versão) pedem novo login após a atualização.

**Testes** (`server/`): `npm test` (20 testes contra Postgres real, precisa de `psql`) e `npm run test:e2e` (navegador + HTTP + Postgres; precisa de Playwright e esbuild).
Neles, express, bcrypt, jsonwebtoken e pg são trocados por versões mínimas; **não foram executados** com os pacotes reais, com SMTP real nem com Agora/Socket.IO.

## Versão web (computador)
O mesmo front (`web/`) agora é responsivo: a partir de 900 px de largura o menu vira barra lateral, o painel e a sala usam duas colunas e a administração vira grade de cartões; no celular continua a coluna única. Não há código duplicado: é o mesmo `App.jsx` com CSS adaptativo.
Rodar: `cd web && npm install && npm run dev` (http://localhost:5173) ou `docker compose up --build`. O teste `npm run test:e2e` (em `server/`) confere o layout em 1366 px e 390 px.
