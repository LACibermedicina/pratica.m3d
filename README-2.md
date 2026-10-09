# pratica.M3D — Treino OSCE / Revalida (versão PHP + SQLite)

## Arquivos
| Arquivo | Função |
|---|---|
| `index.html` | App completo (logomarca M3D mantida, catálogo, salas, IA, tour) |
| `backend.js` | Camada de integração com o servidor + novos recursos |
| `api.php` | Backend PHP 8 + SQLite (cria `pratica_m3d.sqlite` sozinho) |

## Instalação
1. Servidor com **PHP 8+** e extensão **pdo_sqlite** habilitada (XAMPP, WAMP, hospedagem comum ou `php -S localhost:8000`).
2. Copie os 3 arquivos para a mesma pasta do servidor web.
3. Acesse `http://seu-dominio/index.html`. O banco `pratica_m3d.sqlite` é criado na primeira chamada.
4. Login administrador: **root** / **@0Arcano** (troque depois).

## O que há de novo nesta versão
- **Credenciais no servidor**: senha com `password_hash`, sessão Bearer de 30 dias — o registro continua válido depois de fechar o navegador, e o histórico de performance e as salas ficam gravados no SQLite para os relatórios visuais do dashboard
- **📹 Videochamada WebRTC P2P** dentro da sala (mesh, STUN Google): sinalização automática via `api.php` (`signal_send`/`signal_poll`), fallback entre abas via `localStorage` e fallback manual copiar/colar SDP (botão "📋 Sinal manual"). Mute 🎤, câmera 📷 e compartilhar tela 🖥 incluídos.
- **🃏 Cards de auxílio compartilháveis**: avaliador/ator/chefe envia cards por modalidade (anamnese, exame físico, exames, conduta, comunicação) que aparecem em tempo real para o candidato e entram no resumo final.
- **😀 Reações e emojis**: seletor de emojis no chat do lobby e da sala + reações rápidas (👍❤️😂👏🔥😮) transmitidas em tempo real (`room_event`/`room_events`).
- **👥 Modo Colaborativo**: papéis Chefe 👑 (vê todas as folhas, modera) e Espectador 👀 (assiste sem pontuar); roteamento automático por papel ao entrar — médico/ator/chefe caem direto na videochamada.
- **📋 Resumo final da sessão**: ao finalizar, um card agrega cenário do candidato + folha do ator + cards compartilhados + pontuação + feedback de IA, com impressão/PDF e reabertura pelo Histórico do dashboard (botão "📋 Resumo")..
- **Sala exige estação**: sem selecionar ≥1 estação, a sala não abre. Agora dá para selecionar **várias estações** e o criador alterna a estação ativa dentro da sala.
- **Sala sem convidados + WhatsApp**: crie a sala só com a estação e compartilhe o link (`?sala=CÓDIGO`) pelo botão 🟢 WhatsApp — o convidado faz login/cadastro e entra direto (vale até para sala fechada). Depois, agregue participantes pelo botão **➕ Convidar** (lista com 🟢 online primeiro).
- **🤖 Correção IA**: toggle ao lado do **▶ Iniciar**. Ligado, o app transcreve o áudio da estação (médico + ator, reconhecimento pt-BR) e, ao finalizar, a IA verifica item a item do PEP se o elemento foi citado **em contexto válido**, marcando ✓/✗ e a pontuação automaticamente.
- **🗂 Card de revisão didático**: aberto ao fim da estação corrigida por IA (ou pelo botão no Histórico), com pontos fortes, pontos a desenvolver, sugestões de conduta, PEP item a item justificado e opção de imprimir/PDF.

## Notas
- Sem o `api.php` acessível, o app cai automaticamente no modo local original (sql.js/localStorage, sincronização entre abas).
- O chat continua local (abas do mesmo navegador); salas, presença, usuários e histórico são do servidor quando ele está ativo.
- A recuperação de senha retorna o token na tela em ambiente local; em produção, envie por e-mail (mail()/SMTP) em `api.php` → ação `forgot`.
- Reconhecimento de voz requer Chrome/Edge e HTTPS (ou localhost).
- Rotacione as chaves de IA expostas em versões anteriores e mantenha as novas em Config > Credenciais.
