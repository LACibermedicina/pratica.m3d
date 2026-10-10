# pratica.M3D v6.2 — módulo do ecossistema m3d.pro

Versão candidata da plataforma com servidor. Consolidada a partir dos arquivos enviados, com preservação do catálogo e dos roteiros existentes.

## Instalação local
Requer Node.js 22 LTS e npm. Sem build do frontend.

```sh
npm ci
cp .env.example .env
npm start
```

Abra http://localhost:3000. Em desenvolvimento, a conta seed é root e a senha é a definida em ROOT_PASSWORD (padrão legado local @0Arcano). NÃO publique esta senha: NODE_ENV=production recusa o padrão público ou variável ausente. Altere a senha da conta seed pelo perfil antes do deploy. Mudar ROOT_PASSWORD depois do primeiro seed NÃO altera a senha já gravada no SQLite.

## Homologação
```sh
npm test
node tests/ai-fixture.cjs
npx playwright install chromium
# Linux: instale dependências de Chromium, se necessário.
npx playwright install-deps chromium
npm run test:browser
```
50 verificações HTTP/Socket.io/SQLite; 17 verificações Chromium (três contextos com mídia sintetizada, mais SDP manual local); 6 verificações de contratos IA com provedores simulados. Resultados em tests/results-*.json. Não validam serviços externos ou conformidade clínica.

## Uso da sala
1. Selecione uma ou mais estações; escolha grupo ou paciente IA, pública ou privada, simulação ou estudo.
2. O criador entra como avaliador em grupo, ou candidato em sala IA. Demais participantes entram como observadores. Papéis são atribuídos pelo criador e protegidos pelo backend; uma estação tem um candidato ativo.
3. Convide contas por e-mail para salas privadas e compartilhe o código. O convite autoriza acesso; não envia e-mail de convite.
4. Inicie áudio/vídeo, ajuste dispositivos e atribua candidato/ator/observadores. Alteração de papéis exige pausar o timer.
5. Inicie o timer oficial, libere exames reais, marque PEP. Modo estudo não calcula nota ou cronômetro.
6. Chat oculto fica entre observadores até encerrar a estação. Chat privado só é entregue aos envolvidos; auditoria administrativa fica no servidor.
7. Gravação local exige autorização dos participantes presentes. Registro de voz é opcional, por falante. Os streams presentes ao iniciar são misturados; novos streams não são adicionados à gravação já iniciada. Guarde o download antes de fechar a página.
8. Para IA, autorize explicitamente envio dos textos/transcrições e configure provedores. Sem transcrição ou resposta válida, não se inventa nota. Resultado é sujeito a revisão médica.

## Migração e dados
O backend faz migrações aditivas das tabelas SQLite; pare o servidor e faça backup consistente antes de atualizar. Não misture o app standalone com os arquivos Node. O pacote não inclui banco com usuários de teste, credenciais reais, node_modules ou versão standalone.
O seed preserva as 428 estações e adiciona apenas ano/prova declarados na planilha enviada. Não representa verificação oficial INEP. Planilha original em data/Estacoes_Revalida_Organizadas.xlsx. Para bancos existentes, importe esta planilha como administrador para acrescentar metadados sem apagar roteiros/PEP. Os IDs rev- são vinculados ao código inferido do material, não prova de autoria INEP.
XLSX exporta checklist em JSON para preservar pesos. Importação parcial mescla com registros existentes, e IDs ausentes recebem UUID. Campos vazios da planilha não apagam dados clínicos existentes.

## Produção e configurações
- HTTPS e proxy WebSocket; APP_URL deve ser a origem pública correta. Não foi feito deploy no domínio m3d.pro.
- ROOT_PASSWORD forte/única antes do primeiro boot; confira a senha existente antes de migrar.
- SMTP_URL e MAIL_FROM para entrega real de recuperação. Token dura 30 minutos, é armazenado como hash e só funciona uma vez. RECOVERY_DEV_TOKEN deve permanecer false fora de testes.
- Chaves de IA apenas em .env/variáveis; teste cada provedor em Admin. Ordem Gemini → OpenAI → Pollinations. JSON inválido aciona próximo provedor. Modelos e planos podem mudar: verifique disponibilidade na sua conta.
- TURN opcional (credencial é entregue a usuário autenticado; prefira credenciais temporárias em produção). STUN não garante passagem por qualquer NAT.
- Agora precisa de AGORA_APP_ID e AGORA_APP_CERT. Tokens e privilégios são gerados pelo pacote oficial agora-token e renovados pelo cliente. SDK 4.21.0 original preservado; chamada real não homologada neste ambiente.
- Mesh com limite recomendado de 6; acima disso solicita migração Agora, se configurada. Não equivale a comprovação de capacidade de grandes conferências.
- SDP manual foi testado no mesmo ambiente sem socket/STUN; requer rede compatível e troca de SDP por canal externo. Não é garantia universal 100% offline.
- SpeechRecognition não é universal; pode enviar áudio a serviço do navegador. A aplicação não oferece diarização universal nem transcrição automática de arquivos gravados.
- Gravação local não impede captura pelo sistema operacional ou cliente adulterado. Para uso real, implemente política de privacidade, retenção, consentimento e revisão LGPD.
- Rate limit em memória, adequado a uma instância; solução distribuída, CSP compatível, testes de carga, pentest, backups/restore e auditoria WCAG 2.1 ainda necessários.

## Contestação — regra consolidada
Em PEP sem avaliador humano, candidato contesta índices específicos. Administrador resolve e identifica os critérios anulados. Mais de 40% dos critérios TOTAIS anulados congela a estação para revisão, bloqueando novas salas. Exatamente 40% não congela. Isto NÃO usa o percentual de contestações rejeitadas. Parecer IA não aplica anulação automaticamente.

## Marca
Arquitetura proposta: pratica.M3D, módulo de prática clínica, com assinatura de endosso m3d.pro. Mantido o símbolo médico 3D recebido, paleta teal e cores por papel/área. Não foi criado novo símbolo por IA; não há brand kit oficial adicional de m3d.pro neste pacote.

## Evidências e limites
Veja VERIFICACAO.html (matriz completa), VERIFICACAO.json e testes. Há 0 vulnerabilidades conhecidas no npm audit de produção executado nesta entrega, após atualização do SheetJS para 0.20.3 do CDN oficial. Isto não é garantia de ausência de vulnerabilidades.
Exames anexos, qualidade médica dos roteiros, aderência INEP/SUS/MS/RN/OMS, voz física, tela física, SMTP/Agora/IA reais e deploy HTTPS permanecem dependentes de homologação. Estações geradas por IA são rascunhos não validados.
