# pratica.M3D — Plataforma OSCE / Revalida v3

Simulação clínica OSCE com **videochamada WebRTC P2P por papel** (avaliador/candidato/observador), **PEP com correção IA e sistema de disputa**, **cards de revisão com repetição espaçada** e **timer sincronizado** — tudo em tempo real via Socket.io, sem polling.

## Instalação

```bash
npm install
npm start
```

Acesse **http://localhost:3000**. O banco `pratica_m3d.sqlite` é criado automaticamente.
Admin padrão: **root / @0Arcano** (troque a senha no perfil).

## Novidades da v3 (reelaboração)

- **Papéis na estação**: ao entrar, cada usuário escolhe *Avaliador/Ator*, *Candidato* ou *Observador* — o painel muda conforme o papel.
- **Chat oculto de observadores**: anotações e perguntas à IA (botão 🤖) ficam visíveis só entre observadores e são **revelados a todos ao encerrar a estação**.
- **Timer sincronizado**: o botão Iniciar vira **Pausar**; o tempo é fonte única no servidor e **customizável pelo avaliador** a qualquer momento.
- **Gestão de estações**: abrir estação vazia ou com usuários online selecionados, link de convite copiável, estação aberta ou fechada (só presentes/convidados pelo link).
- **PEP com disputa**: candidato sem avaliador pode discordar de itens — a pontuação do item é invalidada e **redistribuída**; acima do limiar (padrão 40%, configurável pelo admin) a prática é **anulada** e some do dashboard até revisão.
- **IA**: geração de estações por argumento + **nível de complexidade** (protocolos INEP/SUS/MS, OMS, XABCDE, atendimento ao RN, suturas), correção do PEP por transcrição da prática (captura de fala no navegador), **cards didáticos por argumento**, coach de desempenho.
- **Biblioteca de cards**: flashcards com pergunta (caso clínico) → resposta, agrupados por área ou aleatorizados, acertos contam no desempenho, **revisão espaçada** (1/3/7/15/30 dias) e vínculo ao PEP/estação de origem.
- **Chat público** com autor + dia/hora, **arquivado por hora** e consultável no dashboard de relatórios do admin.
- **Perfil**: avatar emoji, nome, senha; **dashboard personalizável** com drag & drop e quadros colapsáveis (preferências salvas no servidor).
- **Área técnica/IA (failsafe) visível e testável somente por administradores**.

## IA (variáveis de ambiente)

`GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `POLLINATIONS_TOKEN`, `POLLINATIONS_MODEL`.
Ordem de tentativa: **Gemini → OpenAI → Pollinations**. As chaves nunca vão ao navegador.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | API REST + Socket.io + SQLite + proxy IA |
| `public/index.html` | SPA completa (dashboard, estações, sala, cards, revisões, admin) |
| `pratica_m3d.sqlite` | Banco (auto-criado) |
