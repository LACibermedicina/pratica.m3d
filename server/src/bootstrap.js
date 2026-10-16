// Garante a conta root a partir do ambiente (ROOT_EMAIL / ROOT_SENHA). A senha nunca fica no código-fonte.
import { emailValido, normalizarEmail, senhaValida } from './seguranca.js';

export async function garantirRoot({ q, bcrypt, env = process.env, log = console }) {
  const senha = env.ROOT_SENHA || env.ROOT_PASSWORD;                  // ROOT_PASSWORD também é aceito
  const email = normalizarEmail(env.ROOT_EMAIL || (senha ? 'root@m3d.pro' : ''));
  if (!email || !senha) {
    log.log('Conta root não configurada (defina ROOT_EMAIL e ROOT_SENHA para criá-la).');
    return { acao: 'ignorado' };
  }
  if (!emailValido(email)) throw new Error('ROOT_EMAIL inválido.');

  // só pode existir um root: qualquer outro vira admin
  await q(`update usuarios set papel_app='admin' where papel_app='root' and email<>$1`, [email]);

  const existe = await q('select id, papel_app from usuarios where email=$1', [email]);
  // fora do padrão de senha do app (ex.: 9 caracteres) = provisória: o painel cobra a troca
  const provisoria = !senhaValida(senha) || env.ROOT_SENHA_PROVISORIA === '1';
  let acao;
  if (!existe.rows[0]) {
    const hash = await bcrypt.hash(senha, 12);
    await q(
      `insert into usuarios (nome, email, senha_hash, papel_app, senha_provisoria) values ('Administrador raiz', $1, $2, 'root', $3)`,
      [email, hash, provisoria],
    );
    acao = 'criado';
  } else {
    await q(`update usuarios set papel_app='root', ativo=true where id=$1`, [existe.rows[0].id]);
    acao = existe.rows[0].papel_app === 'root' ? 'mantido' : 'promovido';
    if (env.ROOT_SENHA_REDEFINIR === '1') {
      const hash = await bcrypt.hash(senha, 12);
      await q(`update usuarios set senha_hash=$2, senha_provisoria=$3, sessao_versao=sessao_versao+1, senha_alterada_em=now() where id=$1`, [existe.rows[0].id, hash, provisoria]);
      acao = 'senha_redefinida';
    }
  }
  if (acao !== 'mantido') await q(`insert into auditoria_admin (ator_id, acao, alvo, detalhes) values (null, 'root_bootstrap', $1, $2)`, [email, JSON.stringify({ acao })]);
  log.log(`Conta root ${email}: ${acao}${provisoria ? ' (senha provisória: troque-a no primeiro acesso)' : ''}.`);
  return { acao, provisoria };
}
