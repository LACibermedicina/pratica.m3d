// Autenticação: JWT + conferência no banco a cada chamada (bloqueio e troca de papel/senha valem na hora).
import { Limitador, normalizarEmail, emailValido, rota } from './seguranca.js';

export const MSG_LOGIN = 'E-mail ou senha incorretos.';
export const MSG_PEDIDO = 'Pedido enviado. Quando receber o token, escolha "Tenho um token".';

export const criarAssinar = ({ jwt, segredo }) => (u) =>
  jwt.sign({ id: u.id, nome: u.nome, papel_app: u.papel_app, v: u.sessao_versao }, segredo, { expiresIn: '12h' });

export function criarAutenticar({ q, jwt, segredo }) {
  return rota(async (req, res, prox) => {
    const cab = req.headers?.authorization || '';
    const token = cab.startsWith('Bearer ') ? cab.slice(7) : null;
    let dec;
    try { dec = jwt.verify(token, segredo); } catch { return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' }); }
    const r = await q('select id, nome, papel_app, ativo, sessao_versao from usuarios where id=$1', [dec.id]);
    const u = r.rows[0];
    // papel vem do banco (não do token); sessao_versao muda ao trocar a senha ou bloquear
    if (!u || !u.ativo || u.sessao_versao !== dec.v) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    req.usuario = { id: u.id, nome: u.nome, papel_app: u.papel_app };
    prox();
  });
}

export function registrarLogin(app, { q, bcrypt, assinar, dummyHash }) {
  const agora = () => Date.now();
  const porIpEmail = new Limitador({ max: 5, janelaMs: 15 * 60e3, agora });
  const porEmail = new Limitador({ max: 20, janelaMs: 15 * 60e3, agora });

  app.post('/api/auth/entrar', rota(async (req, res) => {
    const email = normalizarEmail(req.body?.email);
    const senha = String(req.body?.senha ?? '').slice(0, 200);
    const chave = `${req.ip ?? '?'}|${email}`;
    if (porIpEmail.excedeu(chave) || porEmail.excedeu(email)) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' });
    }
    const r = await q('select id, nome, papel_app, ativo, senha_hash, senha_provisoria, sessao_versao from usuarios where email=$1', [email]);
    const u = r.rows[0];
    // compara sempre, mesmo sem conta: o tempo de resposta não revela se o e-mail existe
    const confere = await bcrypt.compare(senha, u?.senha_hash ?? dummyHash);
    if (!u || !confere) {
      porIpEmail.registrar(chave); porEmail.registrar(email);
      return res.status(401).json({ erro: MSG_LOGIN });
    }
    porIpEmail.limpar(chave);
    if (!u.ativo) return res.status(403).json({ erro: 'Conta bloqueada. Fale com o administrador.' });
    res.json({
      token: assinar(u),
      usuario: { id: u.id, nome: u.nome, papel_app: u.papel_app },
      senhaProvisoria: !!u.senha_provisoria,
    });
  }));
}

/** Pedido de acesso: agora é guardado para o administrador decidir. A resposta é sempre a mesma. */
export function registrarSolicitacao(app, { q }) {
  const limite = new Limitador({ max: 5, janelaMs: 3600e3 });
  app.post('/api/acesso/solicitar', rota(async (req, res) => {
    const nome = String(req.body?.nome ?? '').trim();
    const email = normalizarEmail(req.body?.email);
    if (nome.length < 2 || nome.length > 120 || !emailValido(email)) return res.status(400).json({ erro: 'Confira o nome e o e-mail.' });
    const ip = req.ip ?? '?';
    if (!limite.excedeu(ip)) {
      limite.registrar(ip);
      const msg = String(req.body?.mensagem ?? '').trim().slice(0, 300) || null;
      await q(
        `insert into solicitacoes_acesso (nome, email, mensagem) values ($1,$2,$3)
         on conflict (email) where status = 'pendente' do nothing`, [nome, email, msg]);
    }
    res.json({ ok: true, mensagem: MSG_PEDIDO });
  }));
}
