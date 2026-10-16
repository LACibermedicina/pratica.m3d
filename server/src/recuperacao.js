// Recuperação e troca de senha.
//  POST /api/auth/recuperar   {email}           → sempre a mesma resposta (não revela se a conta existe)
//  POST /api/auth/redefinir   {token, senha}    → usa o link do e-mail (uso único, 60 min)
//  POST /api/auth/trocar-senha {atual, nova}    → logado; derruba as outras sessões
import { Limitador, emailValido, gerarToken, MSG_SENHA, normalizarEmail, rota, senhaValida, sha256 } from './seguranca.js';

export const MSG_RECUPERAR = 'Se houver uma conta com esse e-mail, enviamos um link para criar uma nova senha. Ele vale por 60 minutos.';
export const MSG_LINK = 'Link inválido, vencido ou já usado. Peça um novo em "Esqueci minha senha".';
export const VALIDADE_MIN = 60;

export const linkDeRedefinicao = (appUrl, token) => `${String(typeof appUrl === 'function' ? appUrl() : appUrl).replace(/\/$/, '')}/#/redefinir/${token}`;

/** Cria um link novo e invalida os anteriores ainda abertos do mesmo usuário. Devolve o token em claro (mostrar/enviar uma vez). */
export async function criarLinkDeRedefinicao(q, usuarioId, origem = 'usuario') {
  const token = gerarToken();
  await q(`update recuperacoes_senha set usado_em = now() where usuario_id = $1 and usado_em is null`, [usuarioId]);
  await q(
    `insert into recuperacoes_senha (usuario_id, hash, origem, expira_em) values ($1, $2, $3, now() + make_interval(mins => $4))`,
    [usuarioId, sha256(token), origem, VALIDADE_MIN],
  );
  return token;
}

export function registrarRecuperacao(app, d) {
  const { q, autenticar, bcrypt, assinar, enviar, appUrl } = d;
  const agora = d.agora ?? (() => Date.now());
  const lim = d.limitadores ?? {
    ip: new Limitador({ max: 10, janelaMs: 3600e3, agora }),
    email: new Limitador({ max: 3, janelaMs: 3600e3, agora }),
    redefinir: new Limitador({ max: 10, janelaMs: 3600e3, agora }),
    trocar: new Limitador({ max: 5, janelaMs: 15 * 60e3, agora }),
  };

  app.post('/api/auth/recuperar', rota(async (req, res) => {
    const email = normalizarEmail(req.body?.email);
    if (!emailValido(email)) return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    const ip = req.ip ?? '?';
    if (lim.ip.excedeu(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco e tente de novo.' });
    lim.ip.registrar(ip);
    // acima de 3 pedidos/hora para o mesmo e-mail: responde igual, mas não envia nada (impede inundar a caixa de alguém)
    if (!lim.email.excedeu(email)) {
      lim.email.registrar(email);
      const r = await q('select id, nome from usuarios where email=$1 and ativo', [email]);
      const u = r.rows[0];
      if (u) {
        const token = await criarLinkDeRedefinicao(q, u.id, 'usuario');
        // sem await: o tempo de resposta não deve denunciar se a conta existe
        void enviar({
          para: email,
          assunto: 'Redefinir sua senha · Revalida Prático',
          texto: `Olá, ${u.nome}.\n\nPara criar uma nova senha, abra o link abaixo (vale por ${VALIDADE_MIN} minutos e só funciona uma vez):\n${linkDeRedefinicao(appUrl, token)}\n\nSe você não pediu isso, ignore esta mensagem: sua senha continua a mesma.`,
        }).catch(() => {});
      }
    }
    res.json({ ok: true, mensagem: MSG_RECUPERAR });
  }));

  app.post('/api/auth/redefinir', rota(async (req, res) => {
    const { token, senha } = req.body ?? {};
    const ip = req.ip ?? '?';
    if (lim.redefinir.excedeu(ip)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco e tente de novo.' });
    const t = String(token ?? '').trim();
    if (!/^[0-9a-f]{64}$/.test(t)) { lim.redefinir.registrar(ip); return res.status(400).json({ erro: MSG_LINK }); }
    if (!senhaValida(senha)) return res.status(400).json({ erro: MSG_SENHA });
    const hash = await bcrypt.hash(senha, 10);
    // uma só instrução: consome o link e troca a senha (sem corrida entre dois cliques)
    const r = await q(
      `with t as (
         update recuperacoes_senha set usado_em = now()
          where hash = $1 and usado_em is null and expira_em > now() returning usuario_id)
       update usuarios u
          set senha_hash = $2, senha_provisoria = false, sessao_versao = sessao_versao + 1, senha_alterada_em = now()
         from t where u.id = t.usuario_id and u.ativo returning u.id`,
      [sha256(t), hash],
    );
    if (!r.rows[0]) { lim.redefinir.registrar(ip); return res.status(400).json({ erro: MSG_LINK }); }
    await q('update recuperacoes_senha set usado_em = now() where usuario_id = $1 and usado_em is null', [r.rows[0].id]);
    res.json({ ok: true, mensagem: 'Senha alterada. Entre com a nova senha.' });
  }));

  app.post('/api/auth/trocar-senha', autenticar, rota(async (req, res) => {
    const { atual, nova } = req.body ?? {};
    const chave = req.usuario.id;
    if (lim.trocar.excedeu(chave)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
    if (!senhaValida(nova)) return res.status(400).json({ erro: MSG_SENHA });
    const r = await q('select senha_hash from usuarios where id=$1', [chave]);
    if (!r.rows[0] || !(await bcrypt.compare(String(atual ?? ''), r.rows[0].senha_hash))) {
      lim.trocar.registrar(chave);
      return res.status(400).json({ erro: 'Senha atual incorreta.' });
    }
    if (atual === nova) return res.status(400).json({ erro: 'A nova senha precisa ser diferente da atual.' });
    const hash = await bcrypt.hash(nova, 10);
    const u = await q(
      `update usuarios set senha_hash=$2, senha_provisoria=false, sessao_versao=sessao_versao+1, senha_alterada_em=now()
        where id=$1 returning id, nome, papel_app, sessao_versao`,
      [chave, hash],
    );
    await q('update recuperacoes_senha set usado_em = now() where usuario_id = $1 and usado_em is null', [chave]);
    lim.trocar.limpar(chave);
    // as outras sessões caem (versão nova); esta recebe um token novo
    res.json({ ok: true, token: assinar(u.rows[0]), usuario: { id: u.rows[0].id, nome: u.rows[0].nome, papel_app: u.rows[0].papel_app }, senhaProvisoria: false });
  }));
}
