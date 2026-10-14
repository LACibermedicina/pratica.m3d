// Envio de e-mail. Com SMTP_URL (ex.: smtps://usuario:senha@smtp.exemplo.com) e `npm i nodemailer`, envia de verdade.
// Sem isso: em desenvolvimento, imprime a mensagem no console; em produção, só avisa que não enviou.
export function criarEmailer({ env = process.env, log = console } = {}) {
  let transporte = null;
  let tentou = false;
  async function obter() {
    if (tentou) return transporte;
    tentou = true;
    if (!env.SMTP_URL) return null;
    try {
      const nm = await import('nodemailer');
      transporte = (nm.default ?? nm).createTransport(env.SMTP_URL);
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
  };
}
