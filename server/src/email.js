// Envio de e-mail. Com SMTP_URL (ex.: smtps://usuario:senha@smtp.exemplo.com) e `npm i nodemailer`, envia de verdade.
// Sem isso: em desenvolvimento, imprime a mensagem no console; em produção, só avisa que não enviou.
// `env` pode ser um objeto com getters (lê o valor atual a cada uso, p.ex. do instalador).
export function criarEmailer({ env = process.env, log = console, carregarNodemailer = () => import('nodemailer') } = {}) {
  let transporte = null;
  let chaveTransporte = null;
  async function obter() {
    const url = env.SMTP_URL;
    if (!url) return null;
    if (chaveTransporte === url) return transporte;
    chaveTransporte = url;
    transporte = null;
    try {
      const nm = await carregarNodemailer();
      transporte = (nm.default ?? nm).createTransport(url);
    } catch {
      log.warn('SMTP_URL definido, mas o pacote "nodemailer" não está instalado.');
    }
    return transporte;
  }
  return {
    /** Devolve true só se o e-mail foi realmente entregue ao servidor SMTP. */
    async enviar({ para, assunto, texto }) {
      const t = await obter();
      if (t) {
        try {
          await t.sendMail({ from: env.EMAIL_DE || 'Revalida Prático <nao-responda@localhost>', to: para, subject: assunto, text: texto });
          return true;
        } catch (e) {
          log.error('falha ao enviar e-mail:', e?.message ?? e);
          return false;
        }
      }
      if (env.NODE_ENV !== 'production') log.log(`\n[e-mail simulado] para: ${para}\nassunto: ${assunto}\n${texto}\n`);
      else log.warn('SMTP não configurado: e-mail não enviado.');
      return false;
    },
    /** Testa a conexão e o login no servidor SMTP, sem enviar nada. */
    async verificar() {
      if (!env.SMTP_URL) return { estado: 'nao_configurado' };
      const t = await obter();
      if (!t) return { estado: 'sem_pacote' };
      try { await t.verify(); return { estado: 'ok' }; }
      catch (e) { return { estado: 'falhou', motivo: String(e?.code || e?.message || 'erro').slice(0, 120) }; }
    },
  };
}
