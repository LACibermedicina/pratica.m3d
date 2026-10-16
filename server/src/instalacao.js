// Instalador do primeiro acesso: verifica o servidor, define parâmetros e cria administradores.
//
// Segurança:
//  • todas as rotas (menos /estado) exigem o CÓDIGO DE INSTALAÇÃO, impresso só no console/log do servidor
//    (ou fixado em INSTALL_CODE). Quem apenas alcança a URL de um servidor novo não consegue instalar;
//  • depois de concluída, as rotas ficam trancadas para sempre (a trava está no banco);
//  • segredos (certificado Agora, SMTP) entram cifrados no banco e nunca voltam ao navegador;
//  • tentativas de código errado são limitadas por IP.
import crypto from 'node:crypto';
import { emailValido, Limitador, normalizarEmail, rota, senhaValida, MSG_SENHA, sha256 } from './seguranca.js';
import { CHAVES } from './config.js';

export const TABELAS = ['usuarios', 'estacoes', 'pep_itens', 'sessoes', 'sessao_participantes', 'avaliacoes',
  'comentarios_observador', 'tokens_acesso', 'recuperacoes_senha', 'solicitacoes_acesso', 'auditoria_admin', 'config_servidor'];
export const COLUNAS = [['usuarios', 'sessao_versao'], ['usuarios', 'senha_provisoria'], ['sessoes', 'audio_observadores']];

export const gerarCodigoInstalacao = () => {
  const h = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
};
const mesmoCodigo = (a, b) => {
  const x = Buffer.from(sha256(String(a).trim().toUpperCase())), y = Buffer.from(sha256(String(b).trim().toUpperCase()));
  return crypto.timingSafeEqual(x, y);
};

export async function estaInstalado(q) {
  return (await q(`select 1 from config_servidor where chave='instalado_em'`)).rows.length > 0;
}

/** Servidores que já tinham usuários reais antes do instalador existir não precisam instalar de novo. */
export async function reconhecerInstalacaoExistente(q, log = console) {
  if (await estaInstalado(q)) return true;
  // o administrador pediu reinstalação (ou limpou o banco): não "reconhecer" como instalado só porque há usuários
  if ((await q(`select 1 from config_servidor where chave='reinstalacao_pendente'`)).rows.length) return false;
  const r = await q(`select count(*)::int c from usuarios where papel_app <> 'root'`);
  if (r.rows[0].c > 0) {
    await q(`insert into config_servidor (chave, valor) values ('instalado_em', $1) on conflict do nothing`, [`existente:${new Date().toISOString()}`]);
    log.log('Servidor com usuários já cadastrados: instalador dispensado.');
    return true;
  }
  return false;
}

const ok = (id, titulo, detalhe) => ({ id, titulo, status: 'ok', detalhe });
const aviso = (id, titulo, detalhe) => ({ id, titulo, status: 'aviso', detalhe });
const erro = (id, titulo, detalhe) => ({ id, titulo, status: 'erro', detalhe });

export function registrarInstalacao(app, d) {
  const { q, bcrypt, cfg, agora, emailer, codigo, segredoJwt, producao = false, log = console } = d;
  const codigoAtual = () => (typeof codigo === 'function' ? codigo() : codigo);
  const limite = new Limitador({ max: 10, janelaMs: 15 * 60 * 1000 });

  const jaInstalado = () => estaInstalado(q); // sem cache: uma reinstalação pedida pelo administrador vale na hora

  const exigir = rota(async (req, res, prox) => {
    if (await jaInstalado()) return res.status(403).json({ erro: 'A instalação já foi concluída.' });
    const chave = `ip:${req.ip}`;
    if (limite.excedeu(chave)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
    if (!mesmoCodigo(req.headers['x-codigo-instalacao'] ?? '', codigoAtual())) {
      limite.registrar(chave);
      return res.status(401).json({ erro: 'Código de instalação incorreto. Ele aparece no console (log) do servidor.' });
    }
    limite.limpar(chave);
    prox();
  });

  app.get('/api/instalacao/estado', rota(async (_req, res) => res.json({ instalado: await jaInstalado() })));

  /* ---------- verificações ---------- */
  async function verificar(req) {
    const itens = [];
    // 1. banco
    let bancoOk = false;
    try {
      const v = (await q('select version() v')).rows[0].v;
      itens.push(ok('banco', 'Banco de dados', `Conectado (${String(v).split(' ').slice(0, 2).join(' ')}).`));
      bancoOk = true;
    } catch { itens.push(erro('banco', 'Banco de dados', 'Não foi possível conectar. Confira DATABASE_URL e se o Postgres está no ar.')); }

    // 2. esquema
    if (bancoOk) {
      try {
        const t = new Set((await q(`select table_name from information_schema.tables where table_schema='public'`)).rows.map((r) => r.table_name));
        const c = new Set((await q(`select table_name||'.'||column_name k from information_schema.columns where table_schema='public'`)).rows.map((r) => r.k));
        const faltaT = TABELAS.filter((x) => !t.has(x));
        const faltaC = COLUNAS.map(([a, b]) => `${a}.${b}`).filter((x) => !c.has(x));
        if (faltaT.length || faltaC.length) itens.push(erro('esquema', 'Estrutura do banco', `Faltam: ${[...faltaT, ...faltaC].join(', ')}. Aplique db/schema.sql (ou as migrações de db/migracoes) e verifique de novo.`));
        else itens.push(ok('esquema', 'Estrutura do banco', 'Todas as tabelas e colunas necessárias existem.'));
      } catch { itens.push(erro('esquema', 'Estrutura do banco', 'Não foi possível ler a estrutura do banco.')); }
    }

    // 3. segredo JWT
    const fraco = !segredoJwt || segredoJwt === 'troque-em-producao' || segredoJwt.length < 32;
    itens.push(!fraco ? ok('jwt', 'Segredo das sessões (JWT_SEGREDO)', 'Definido, com 32+ caracteres.')
      : producao ? erro('jwt', 'Segredo das sessões (JWT_SEGREDO)', 'Fraco ou padrão. Defina 32+ caracteres aleatórios no ambiente.')
        : aviso('jwt', 'Segredo das sessões (JWT_SEGREDO)', 'Valor de desenvolvimento. Em produção, defina 32+ caracteres aleatórios.'));

    // 4. endereço público
    const url = cfg.obter('APP_URL');
    if (!url) itens.push(aviso('url', 'Endereço público (APP_URL)', 'Não definido: links de e-mail apontarão para o endereço de desenvolvimento.'));
    else {
      try {
        const u = new URL(url);
        const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
        if (producao && u.protocol !== 'https:') itens.push(aviso('url', 'Endereço público (APP_URL)', 'Em produção use https:// — câmera e microfone só funcionam em conexão segura.'));
        else if (host && u.host !== host) itens.push(aviso('url', 'Endereço público (APP_URL)', `Definido como ${u.host}, mas você está acessando por ${host}. Links de e-mail podem apontar para o lugar errado.`));
        else itens.push(ok('url', 'Endereço público (APP_URL)', `${u.origin}`));
      } catch { itens.push(erro('url', 'Endereço público (APP_URL)', 'Valor inválido.')); }
    }

    // 5. proxy reverso
    const xff = req.headers['x-forwarded-for'];
    itens.push(xff ? ok('proxy', 'Proxy reverso', 'Cabeçalho X-Forwarded-For recebido: limites de tentativas por IP funcionam.')
      : producao ? aviso('proxy', 'Proxy reverso', 'Sem X-Forwarded-For. Se há um proxy (nginx), repasse o cabeçalho; senão todos os acessos parecem vir do mesmo IP.')
        : ok('proxy', 'Proxy reverso', 'Acesso direto (desenvolvimento).'));

    // 6. e-mail
    const ev = await emailer.verificar();
    itens.push(ev.estado === 'ok' ? ok('email', 'E-mail (SMTP)', 'Conexão e login no servidor SMTP confirmados.')
      : ev.estado === 'nao_configurado' ? aviso('email', 'E-mail (SMTP)', 'Não configurado: recuperação de senha e aprovação de token não enviam e-mail (o link aparece no log em desenvolvimento).')
        : ev.estado === 'sem_pacote' ? erro('email', 'E-mail (SMTP)', 'SMTP definido, mas o pacote "nodemailer" não está instalado (npm i nodemailer).')
          : erro('email', 'E-mail (SMTP)', `Falha ao conectar/entrar (${ev.motivo}). Confira SMTP_URL.`));

    // 7. vídeo Agora
    if (!agora.configurado()) itens.push(aviso('video', 'Vídeo (Agora)', 'Sem credenciais: as salas abrem em modo demonstração (sem vídeo real).'));
    else {
      const id = agora.appId(), cert = cfg.obter('AGORA_APP_CERTIFICATE');
      if (!/^[0-9a-f]{32}$/i.test(id) || !/^[0-9a-f]{32}$/i.test(cert)) itens.push(erro('video', 'Vídeo (Agora)', 'App ID e Certificado devem ter 32 caracteres hexadecimais.'));
      else {
        try {
          const a = await agora.gerarToken({ canal: 'teste-instalador', uid: 1, audio: 'nenhum' });
          const b = await agora.gerarToken({ canal: 'teste-instalador', uid: 1, audio: 'curto' });
          if (!String(a.token).startsWith('007') || a.token === b.token) throw new Error('token fora do formato');
          itens.push(ok('video', 'Vídeo (Agora)', 'Credenciais aceitas e tokens por papel gerados (observador sem áudio / com áudio). O teste ao vivo é abrir uma sala depois da instalação.'));
        } catch (e) { itens.push(erro('video', 'Vídeo (Agora)', `Não foi possível gerar tokens: ${String(e.message).slice(0, 140)}`)); }
      }
    }
    return itens;
  }

  const adminsDefinitivos = async () =>
    (await q(`select count(*)::int c from usuarios where papel_app in ('admin','root') and ativo and not senha_provisoria`)).rows[0].c;

  app.post('/api/instalacao/verificar', exigir, rota(async (req, res) => {
    const itens = await verificar(req);
    res.json({ itens, admins: bancoOkAdmins(itens) ? await adminsDefinitivos().catch(() => 0) : 0 });
  }));
  const bancoOkAdmins = (itens) => itens.find((i) => i.id === 'banco')?.status === 'ok' && itens.find((i) => i.id === 'esquema')?.status === 'ok';

  /* ---------- parâmetros ---------- */
  app.post('/api/instalacao/config-ler', exigir, rota(async (_req, res) => res.json({ config: cfg.visao() })));

  const VALIDAR = {
    APP_URL: (v) => { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw 0; return u.origin; },
    PHP_TOKEN_URL: (v) => { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw 0; return u.toString(); },
    NOME_INSTITUICAO: (v) => { if (v.length > 120) throw 0; return v; },
    EMAIL_DE: (v) => { if (v.length > 200 || /[\r\n]/.test(v)) throw 0; return v; },
    SMTP_URL: (v) => { if (!/^smtps?:\/\//i.test(v) || v.length > 500 || /\s/.test(v)) throw 0; return v; },
    AGORA_APP_ID: (v) => { if (!/^[0-9a-f]{32}$/i.test(v)) throw 0; return v.toLowerCase(); },
    AGORA_APP_CERTIFICATE: (v) => { if (!/^[0-9a-f]{32}$/i.test(v)) throw 0; return v.toLowerCase(); },
  };
  app.post('/api/instalacao/config', exigir, rota(async (req, res) => {
    const corpo = req.body ?? {};
    const aplicados = [], ignorados = [], invalidos = [];
    for (const chave of Object.keys(CHAVES)) {
      const bruto = corpo[chave];
      if (bruto === undefined || bruto === null) continue;
      if (cfg.origem(chave) === 'ambiente') { ignorados.push(chave); continue; } // o ambiente manda
      const v = String(bruto).trim();
      if (v === '') { if (!CHAVES[chave].segredo) { await cfg.definir(chave, null); aplicados.push(chave); } continue; } // segredo vazio = manter
      try { await cfg.definir(chave, VALIDAR[chave](v)); aplicados.push(chave); } catch { invalidos.push(chave); }
    }
    if (invalidos.length) return res.status(400).json({ erro: `Valor inválido em: ${invalidos.join(', ')}.`, invalidos });
    res.json({ aplicados, ignorados, config: cfg.visao() });
  }));

  app.post('/api/instalacao/email-teste', exigir, rota(async (req, res) => {
    if (!emailValido(req.body?.para)) return res.status(400).json({ erro: 'E-mail inválido.' });
    const entregue = await emailer.enviar({ para: req.body.para.trim(), assunto: 'Teste do instalador — Revalida Prático', texto: 'Se você leu isto, o envio de e-mail do servidor está funcionando.' });
    res.json({ entregue });
  }));

  /* ---------- administradores ---------- */
  const auditar = (acao, alvo, detalhes = {}) =>
    q(`insert into auditoria_admin (ator_id, acao, alvo, detalhes) values (null, $1, $2, $3)`, [acao, alvo, JSON.stringify(detalhes)]);

  app.post('/api/instalacao/root', exigir, rota(async (req, res) => {
    const email = normalizarEmail(req.body?.email);
    const senha = req.body?.senha;
    if (!senhaValida(senha)) return res.status(400).json({ erro: MSG_SENHA });
    const hash = await bcrypt.hash(senha, 12);
    const atual = (await q(`select id, email::text e from usuarios where papel_app='root'`)).rows[0];
    if (atual) {
      await q(`update usuarios set senha_hash=$2, senha_provisoria=false, sessao_versao=sessao_versao+1, senha_alterada_em=now(), ativo=true where id=$1`, [atual.id, hash]);
      await auditar('instalador_root_senha', atual.e);
      return res.json({ ok: true, email: atual.e, criado: false });
    }
    if (!emailValido(email)) return res.status(400).json({ erro: 'Informe um e-mail válido para a conta raiz.' });
    const ex = (await q('select id from usuarios where email=$1', [email])).rows[0];
    if (ex) await q(`update usuarios set papel_app='root', ativo=true, senha_hash=$2, senha_provisoria=false, sessao_versao=sessao_versao+1 where id=$1`, [ex.id, hash]);
    else await q(`insert into usuarios (nome, email, senha_hash, papel_app, senha_provisoria) values ('Administrador raiz', $1, $2, 'root', false)`, [email, hash]);
    await auditar('instalador_root_criado', email);
    res.json({ ok: true, email, criado: true });
  }));

  app.post('/api/instalacao/admins', exigir, rota(async (req, res) => {
    const nome = String(req.body?.nome ?? '').trim();
    const email = normalizarEmail(req.body?.email);
    const papel = req.body?.papel === 'moderador' ? 'moderador' : 'admin';
    if (nome.length < 2 || nome.length > 120) return res.status(400).json({ erro: 'Informe o nome (2 a 120 caracteres).' });
    if (!emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!senhaValida(req.body?.senha)) return res.status(400).json({ erro: MSG_SENHA });
    if ((await q('select 1 from usuarios where email=$1', [email])).rows.length) return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail.' });
    await q(`insert into usuarios (nome, email, senha_hash, papel_app, senha_provisoria) values ($1,$2,$3,$4,false)`, [nome, email, await bcrypt.hash(req.body.senha, 12), papel]);
    await auditar('instalador_admin_criado', email, { papel });
    res.json({ ok: true, email, papel });
  }));

  app.post('/api/instalacao/admins-lista', exigir, rota(async (_req, res) => {
    const r = await q(`select nome, email::text email, papel_app papel, senha_provisoria provisoria from usuarios where papel_app in ('root','admin','moderador') order by papel_app, criado_em`);
    res.json({ usuarios: r.rows });
  }));

  /* ---------- concluir ---------- */
  app.post('/api/instalacao/concluir', exigir, rota(async (req, res) => {
    const itens = await verificar(req);
    const bloqueios = itens.filter((i) => i.status === 'erro');
    if (bloqueios.length) return res.status(409).json({ erro: 'Há verificações com erro. Corrija e verifique de novo.', bloqueios: bloqueios.map((b) => b.id) });
    if ((await adminsDefinitivos()) < 1) return res.status(409).json({ erro: 'Defina a senha da conta raiz ou crie um administrador com senha própria antes de concluir.', bloqueios: ['admin'] });
    const r = await q(`insert into config_servidor (chave, valor) values ('instalado_em', $1) on conflict do nothing returning chave`, [new Date().toISOString()]);
    if (!r.rows.length) return res.status(403).json({ erro: 'A instalação já foi concluída.' });
    await q(`delete from config_servidor where chave='reinstalacao_pendente'`);
    await auditar('instalacao_concluida', null, { avisos: itens.filter((i) => i.status === 'aviso').map((i) => i.id) });
    log.log('Instalação concluída.');
    res.json({ ok: true, avisos: itens.filter((i) => i.status === 'aviso').map((i) => i.id) });
  }));
}

/* ====================== reinstalação e limpeza (só o root) ====================== */
export const CONFIRMA_REINSTALAR = 'REINSTALAR';
export const CONFIRMA_LIMPAR = 'APAGAR TUDO';

/** Reabre o instalador: apaga a trava e marca "reinstalação pendente" (sobrevive a reinícios). Não apaga dados. */
export async function reabrirInstalador(q) {
  await q(`delete from config_servidor where chave='instalado_em'`);
  await q(`insert into config_servidor (chave, valor) values ('reinstalacao_pendente', $1) on conflict (chave) do update set valor=excluded.valor, atualizado_em=now()`, [new Date().toISOString()]);
}

/** Apaga dados de uso. Mantém: estrutura, parâmetros do servidor, token master e (por padrão) as estações com checklist. */
export async function limparBanco(q, { apagarEstacoes = false } = {}) {
  await q(`delete from comentarios_observador`);
  await q(`delete from avaliacao_itens`);
  await q(`delete from avaliacoes`);
  await q(`delete from sessao_participantes`);
  await q(`delete from sessoes`);
  await q(`delete from recuperacoes_senha`);
  await q(`delete from solicitacoes_acesso`);
  await q(`delete from tokens_acesso where tipo <> 'master'`);
  await q(`delete from usuarios`);
  if (apagarEstacoes) await q(`delete from estacoes`);
  await reabrirInstalador(q);
}

export function registrarManutencao(app, d) {
  const { q, autenticar, bcrypt, novoCodigo, log = console } = d;
  const tentativas = new Limitador({ max: 5, janelaMs: 15 * 60 * 1000 });
  const SOMENTE_ROOT = (req, res, prox) => (req.usuario?.papel_app === 'root' ? prox() : res.status(403).json({ erro: 'Só a conta root pode fazer isso.' }));

  // exige a senha da própria conta root + frase de confirmação digitada: nada acontece por clique acidental ou sessão esquecida aberta
  async function confirmar(req, res, frase) {
    const chave = `u:${req.usuario.id}`;
    if (tentativas.excedeu(chave)) { res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' }); return false; }
    const u = (await q('select senha_hash from usuarios where id=$1', [req.usuario.id])).rows[0];
    const ok = u && typeof req.body?.senha === 'string' && await bcrypt.compare(req.body.senha, u.senha_hash);
    if (!ok || req.body?.confirmacao !== frase) {
      tentativas.registrar(chave);
      res.status(400).json({ erro: `Confira sua senha e digite exatamente: ${frase}` });
      return false;
    }
    tentativas.limpar(chave);
    return true;
  }
  const auditar = (req, acao, detalhes = {}) =>
    q(`insert into auditoria_admin (ator_id, acao, alvo, detalhes) values ($1,$2,'instalador',$3)`, [req.usuario.id, acao, JSON.stringify(detalhes)]);

  app.post('/api/admin/instalacao/reinstalar', autenticar, SOMENTE_ROOT, rota(async (req, res) => {
    if (!(await confirmar(req, res, CONFIRMA_REINSTALAR))) return;
    await auditar(req, 'reinstalacao_pedida');
    await reabrirInstalador(q);
    const codigo = novoCodigo();
    log.log(`\nREINSTALAÇÃO pedida pelo root. Novo código de instalação: ${codigo}\n`);
    res.json({ ok: true, aviso: 'O instalador foi reaberto para todos os visitantes. O código de instalação aparece no log do servidor.' });
  }));

  app.post('/api/admin/instalacao/limpar-banco', autenticar, SOMENTE_ROOT, rota(async (req, res) => {
    if (!(await confirmar(req, res, CONFIRMA_LIMPAR))) return;
    const apagarEstacoes = req.body?.apagarEstacoes === true;
    const antes = (await q('select count(*)::int c from usuarios')).rows[0].c;
    await limparBanco(q, { apagarEstacoes });
    await q(`insert into auditoria_admin (ator_id, acao, alvo, detalhes) values (null,'banco_limpo','instalador',$1)`, [JSON.stringify({ por: req.usuario.id, usuariosApagados: antes, apagarEstacoes })]);
    const codigo = novoCodigo();
    log.log(`\nBANCO LIMPO pelo root. Novo código de instalação: ${codigo}\n`);
    res.json({ ok: true, aviso: 'Dados apagados. Sua sessão terminou; o instalador foi reaberto (código no log do servidor).' });
  }));
}
