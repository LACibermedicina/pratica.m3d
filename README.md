# pratica.M3D — Plataforma OSCE / Revalida v3.1

Simulação clínica OSCE com **videochamada WebRTC P2P por papel** (avaliador/candidato/observador), **PEP com correção IA e disputa**, **cards de revisão espaçada**, **amizades, notificações e vídeo no chat público entre amigos** — tudo em tempo real via Socket.io, sem polling.

## Instalação

```bash
npm install
npm start
```

Acesse **http://localhost:3000**. O banco `pratica_m3d.sqlite` é criado automaticamente e o catálogo é semeado com as **estações padronizadas** (`seed_stations.json`, gerado a partir da planilha de estações organizadas).
Admin master: **root / @0Arcano** (troque a senha no perfil).

## Estrutura

```
server.js            backend completo (Express + Socket.io + SQLite)
public/index.html    SPA frontend (copie index.html para public/)
seed_stations.json   catálogo inicial de estações (seed automático no 1º boot)
package.json
```

## Novidades da v3.1

- **Credenciais de IA atualizadas**: Gemini com chave principal + reserva (`X-goog-api-key`, modelo `gemini-flash-latest`), OpenAI (`gpt-4o-mini`) e Pollinations (`sk_...`) — failsafe automático Gemini → OpenAI → Pollinations, com testador no painel admin.
- **Usuário master root** com acesso total: promoção/revogação de admins, exclusão de usuários, configurações, limpeza do chat.
- **Logomarca animada**: cubo isométrico SVG (fiel à identidade teal) com rotação 3D contínua e interação no hover.
- **Detalhe de usuário + privacidade**: clique em qualquer usuário para ver perfil, performance e cards — cada usuário pode **desautorizar** o compartilhamento (perfil / performance / cards) em Perfil → Privacidade.
- **Amizades**: pedidos com aceite/recusa; amigos veem performance, relatórios de revisão e cards entre si.
- **Notificações persistentes**: sino 🔔 na barra superior; notifica mesmo com o destinatário offline (entregues no próximo login).
- **Painel de sessão**: ao abrir a sessão, um card com **tema de revisão aleatório ainda não estudado** + fluxograma objetivo da conduta.
- **Chat público**: mensagens retidas por **2h** (relógio do servidor, exibição no fuso local do usuário) ou até o admin limpar o histórico; **vídeo em conferência** opcional, visível **somente entre amigos**.
- **Importar JSON exclusivo para administradores** (estação individual ou lista, no formato `{"tema","area","especialidade","instrucoes","cenario","roteiroAtor","protocolo","exames":[],"checklist":[{"item","peso"}]}`).
- **Segurança**: cabeçalhos `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`; senhas com bcrypt; sessões Bearer de 30 dias; SQLite em modo WAL.

## Configuração por variáveis de ambiente (opcional)

| Variável | Padrão |
|---|---|
| `PORT` | `3000` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | chaves embutidas (principal + reserva) |
| `GEMINI_MODEL` | `gemini-flash-latest` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | chave embutida / `gpt-4o-mini` |
| `POLLINATIONS_TOKEN` | token embutido |
