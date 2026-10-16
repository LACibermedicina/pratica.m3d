// Funções administrativas. Quem pode o quê (conferido aqui, no servidor, a cada chamada, lendo o papel ATUAL do banco):
//   moderador : revisar estações
//   admin     : + pedidos de acesso, tokens (1 uso), usuários comuns (bloquear/desbloquear, link de senha), auditoria
//   root      : tudo, inclusive tokens de vários usos, promover/rebaixar admin/moderador e agir sobre admins
// Ninguém altera a conta root por esta API, e ninguém bloqueia/rebaixa a si mesmo.
import { emailValido, gerarToken, idValido, normalizarEmail, rota, sha256 } from './seguranca.js';
import { criarLinkDeRedefinicao, linkDeRedefinicao, VALIDADE_MIN } from './recuperacao.js';

const PAPEIS_ATRIBUIVEIS = ['usuario', 'moderador', 'admin'];
const STATUS_ESTACAO = ['rascunho', 'revisao', 'aprovada'];
const horas = (v, padrao = 72) => {
  const n = Number(v ?? padrao);
  return Number.isInteger(n) && n >= 1 && n <= 720 ? n : null;
};

export function registrarAdmin(app, d) {
  const { q, autenticar, enviar, appUrl } = d;
  const exigir = (...papeis) => (req, res, prox) =>
    papeis.includes(req.usuario?.papel_app) ? prox() : res.status(403).json({ erro: 'Sem permissão para esta ação.' });
  const ADMIN = [autenticar, exigir('admin', 'root')];
  const MODERA = [autenticar, exigir('moderador', 'admin', 'root')];
  const ROOT = [autenticar, exigir('root')];
  const auditar = (req, acao, alvo, detalhes = {}) =>
    q('insert into auditoria_admin (ator_id, acao, alvo, detalhes) values ($1,$2,$3,$4)', [req.usuario.id, acao, String(alvo ?? ''), JSON.stringify(detalhes)]);
  const nao = (res, status, erro) => res.status(status).json({ erro });

  /** Carrega o alvo e confere se o ator pode agir sobre ele. Devolve o alvo ou já responde com erro. */
  async function alvoPermitido(req, res, { papelNovo } = {}) {
    if (!idValido(req.params.id)) return void nao(res, 400, 'Identificador inválido.');
    const r = await q('select id, nome, email, papel_app, ativo from usuarios where id=$1', [req.params.id]);
    const u = r.rows[0];
    if (!u) return void nao(res, 404, 'Usuário não encontrado.');
    if (u.papel_app === 'root') return void nao(res, 403, 'A conta root não pode ser alterada por aqui.');
    if (u.id === req.usuario.id) return void nao(res, 403, 'Você não pode alterar a sua própria conta por aqui.');
    const euRoot = req.usuario.papel_app === 'root';
    if (!euRoot && !['usuario', 'moderador'].includes(u.papel_app)) return void nao(res, 403, 'Só o root altera administradores.');
    if (papelNovo !== undefined && !euRoot) return void nao(res, 403, 'Só o root muda papéis.');
    return u;
  }

  app.get('/api/admin/resumo', ...ADMIN, rota(async (_req, res) => {
    const r = await q(
      `select (select count(*)::int from solicitacoes_acesso where status='pendente') pedidos,
              (select count(*)::int from tokens_acesso where not revogado and tipo<>'master' and usos<usos_max and (expira_em is null or expira_em>now())) tokens,
              (select count(*)::int from usuarios) usuarios,
              (select count(*)::int from estacoes where status='revisao') estacoes_revisao`);
    res.json(r.rows[0]);
  }));

  /* ---------- pedidos de acesso ---------- */
  app.get('/api/admin/pedidos', ...ADMIN, rota(async (_req, res) => {
    const r = await q(`select id, nome, email, mensagem, criado_em from solicitacoes_acesso where status='pendente' order by criado_em`);
    res.json(r.rows);
  }));

  app.post('/api/admin/pedidos/:id/aprovar', ...ADMIN, rota(async (req, res) => {
    if (!idValido(req.params.id)) return nao(res, 400, 'Identificador inválido.');
    const h = horas(req.body?.validadeH);
    if (h === null) return nao(res, 400, 'Validade de 1 a 720 horas.');
    const p = await q(
      `update solicitacoes_acesso set status='aprovada', decidido_por=$2, decidido_em=now()
        where id=$1 and status='pendente' returning nome, email`, [req.params.id, req.usuario.id]);
    if (!p.rows[0]) return nao(res, 404, 'Pedido não encontrado ou já decidido.');
    const token = gerarToken(16);
    await q(
      `insert into tokens_acesso (hash, tipo, email_preso, usos_max, expira_em, nota, criado_por)
       values ($1, 'solicitacao', $2, 1, now() + make_interval(hours => $3), $4, $5)`,
      [sha256(token), normalizarEmail(p.rows[0].email), h, `Pedido de ${p.rows[0].nome}`.slice(0, 120), req.usuario.id]);
    const emailEnviado = await enviar({
      para: p.rows[0].email,
      assunto: 'Seu acesso ao Revalida Prático foi aprovado',
      texto: `Olá, ${p.rows[0].nome}.\n\nSeu pedido foi aprovado. Seu token de cadastro (1 uso, vale por ${h} horas):\n\n${token}\n\nNo app, escolha "Tenho um token" e use o mesmo e-mail deste pedido.`,
    });
    await auditar(req, 'pedido_aprovado', req.params.id, { email: p.rows[0].email, validadeH: h });
    res.json({ token, email: p.rows[0].email, emailEnviado });   // o token só aparece agora
  }));

  app.post('/api/admin/pedidos/:id/recusar', ...ADMIN, rota(async (req, res) => {
    if (!idValido(req.params.id)) return nao(res, 400, 'Identificador inválido.');
    const r = await q(`update solicitacoes_acesso set status='recusada', decidido_por=$2, decidido_em=now() where id=$1 and status='pendente' returning id`, [req.params.id, req.usuario.id]);
    if (!r.rows[0]) return nao(res, 404, 'Pedido não encontrado ou já decidido.');
    await auditar(req, 'pedido_recusado', req.params.id);
    res.json({ ok: true });
  }));

  /* ---------- tokens de acesso ---------- */
  app.get('/api/admin/tokens', ...ADMIN, rota(async (_req, res) => {
    const r = await q(
      `select id, tipo, email_preso, nota, usos, usos_max, expira_em, criado_em from tokens_acesso
        where not revogado and tipo<>'master' and usos<usos_max and (expira_em is null or expira_em>now()) order by criado_em desc limit 100`);
    res.json(r.rows);
  }));

  app.post('/api/admin/tokens', ...ADMIN, rota(async (req, res) => {
    const { email, nota } = req.body ?? {};
    const h = horas(req.body?.validadeH);
    if (h === null) return nao(res, 400, 'Validade de 1 a 720 horas.');
    const euRoot = req.usuario.papel_app === 'root';
    const usos = req.body?.usosMax === undefined ? 1 : Number(req.body.usosMax);
    if (!Number.isInteger(usos) || usos < 1 || usos > 100) return nao(res, 400, 'Usos de 1 a 100.');
    if (usos > 1 && !euRoot) return nao(res, 403, 'Só o root cria tokens de vários usos.');
    const destino = email ? normalizarEmail(email) : null;
    if (destino && !emailValido(destino)) return nao(res, 400, 'E-mail inválido.');
    const token = gerarToken(16);
    await q(
      `insert into tokens_acesso (hash, tipo, email_preso, usos_max, expira_em, nota, criado_por)
       values ($1,'indicacao',$2,$3, now() + make_interval(hours => $4), $5, $6)`,
      [sha256(token), destino, usos, h, nota ? String(nota).trim().slice(0, 120) : null, req.usuario.id]);
    await auditar(req, 'token_criado', destino ?? '(qualquer e-mail)', { usos, validadeH: h });
    res.status(201).json({ token });
  }));

  app.post('/api/admin/tokens/:id/revogar', ...ADMIN, rota(async (req, res) => {
    if (!idValido(req.params.id)) return nao(res, 400, 'Identificador inválido.');
    const r = await q(`update tokens_acesso set revogado=true where id=$1 and tipo<>'master' and not revogado returning id`, [req.params.id]);
    if (!r.rows[0]) return nao(res, 404, 'Token não encontrado.');
    await auditar(req, 'token_revogado', req.params.id);
    res.json({ ok: true });
  }));

  /* ---------- usuários ---------- */
  app.get('/api/admin/usuarios', ...ADMIN, rota(async (req, res) => {
    const busca = String(req.query?.busca ?? '').trim().slice(0, 80);
    const padrao = `%${busca.replace(/[\\%_]/g, '\\$&')}%`;
    const r = await q(
      `select id, nome, email, papel_app, ativo, criado_em from usuarios
        where $1 = '' or nome ilike $2 or email::text ilike $2 order by criado_em desc limit 50`, [busca, padrao]);
    res.json(r.rows);
  }));

  app.patch('/api/admin/usuarios/:id', ...ADMIN, rota(async (req, res) => {
    const { ativo, papel_app: papel } = req.body ?? {};
    if (ativo === undefined && papel === undefined) return nao(res, 400, 'Nada para alterar.');
    if (ativo !== undefined && typeof ativo !== 'boolean') return nao(res, 400, 'Valor inválido.');
    if (papel !== undefined && !PAPEIS_ATRIBUIVEIS.includes(papel)) return nao(res, 400, 'Papel inválido.');
    const u = await alvoPermitido(req, res, { papelNovo: papel });
    if (!u) return;
    await q(
      `update usuarios set ativo = coalesce($2, ativo), papel_app = coalesce($3, papel_app),
              sessao_versao = sessao_versao + (case when $2 = false or $3 is not null then 1 else 0 end) where id=$1`,
      [u.id, ativo ?? null, papel ?? null]);
    await auditar(req, 'usuario_alterado', u.email, { de: { ativo: u.ativo, papel_app: u.papel_app }, para: { ativo: ativo ?? u.ativo, papel_app: papel ?? u.papel_app } });
    res.json({ ok: true });
  }));

  app.post('/api/admin/usuarios/:id/redefinicao', ...ADMIN, rota(async (req, res) => {
    const u = await alvoPermitido(req, res);
    if (!u) return;
    if (!u.ativo) return nao(res, 409, 'A conta está bloqueada. Desbloqueie antes.');
    const token = await criarLinkDeRedefinicao(q, u.id, 'admin');
    await auditar(req, 'link_senha_gerado', u.email);
    res.json({ link: linkDeRedefinicao(appUrl, token), validadeMin: VALIDADE_MIN });   // entregue à pessoa por um canal seguro
  }));

  /* ---------- estações ---------- */
  app.get('/api/admin/estacoes', ...MODERA, rota(async (req, res) => {
    const st = STATUS_ESTACAO.includes(req.query?.status) ? req.query.status : 'revisao';
    const r = await q(`select id, titulo, area, origem, status, duracao_min from estacoes where status=$1 order by criado_em desc limit 100`, [st]);
    res.json(r.rows);
  }));

  app.post('/api/admin/estacoes/:id/status', ...MODERA, rota(async (req, res) => {
    if (!idValido(req.params.id)) return nao(res, 400, 'Identificador inválido.');
    const st = req.body?.status;
    if (!STATUS_ESTACAO.includes(st)) return nao(res, 400, 'Status inválido.');
    const r = await q('update estacoes set status=$2 where id=$1 returning id', [req.params.id, st]);
    if (!r.rows[0]) return nao(res, 404, 'Estação não encontrada.');
    await auditar(req, 'estacao_status', req.params.id, { status: st });
    res.json({ ok: true });
  }));

  /* ---------- auditoria ---------- */
  app.get('/api/admin/auditoria', ...ADMIN, rota(async (_req, res) => {
    const r = await q(
      `select a.id, a.acao, a.alvo, a.detalhes, a.criado_em, u.nome as ator
         from auditoria_admin a left join usuarios u on u.id=a.ator_id order by a.id desc limit 100`);
    res.json(r.rows);
  }));

  void ROOT; // reservado para futuras ações exclusivas do root
}
