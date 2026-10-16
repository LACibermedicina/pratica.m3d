// Rotas de vídeo: token Agora por papel e permissão de áudio dos observadores (controlada pelo chefe da sala).
import crypto from 'node:crypto';
import { idValido, rota } from './seguranca.js';
import { permissoesDeMidia } from './agora.js';

export const uidAgora = (usuarioId) =>
  (parseInt(crypto.createHash('md5').update(String(usuarioId)).digest('hex').slice(0, 8), 16) % 2000000000) + 1;

export function registrarVideo(app, d) {
  const { q, autenticar, agora, cfg, emitir } = d;

  const carregar = async (sessaoId, usuarioId) => {
    if (!idValido(sessaoId)) return null;
    const r = await q(
      `select s.canal_video, s.audio_observadores, s.status, p.papel
       from sessoes s join sessao_participantes p on p.sessao_id=s.id and p.usuario_id=$2
       where s.id=$1`, [sessaoId, usuarioId]);
    return r.rows[0] ?? null;
  };

  app.get('/api/sessoes/:id/agora-token', autenticar, rota(async (req, res) => {
    const s = await carregar(req.params.id, req.usuario.id);
    if (!s) return res.status(403).json({ erro: 'Você não está nesta sala.' });
    const perm = permissoesDeMidia(s.papel, s.audio_observadores);
    const base = { canal: s.canal_video, papel: s.papel, audioObservadores: s.audio_observadores, pode: perm };

    // Failsafe: sem credenciais Agora a sala abre em modo demo (nada quebra).
    if (!agora.configurado()) return res.json({ modo: 'demo', ...base });

    const uid = uidAgora(req.usuario.id);
    const modoAudio = !perm.audio ? 'nenhum' : s.papel === 'observador' ? 'curto' : 'sempre';
    const t = await agora.gerarToken({ canal: s.canal_video, uid, audio: modoAudio });
    res.json({ modo: 'agora', appId: agora.appId(), uid, ...t, ...base, fallbackUrl: cfg.obter('PHP_TOKEN_URL') || null });
  }));

  // Só o chefe da sala (avaliador/ator) libera ou bloqueia o áudio dos observadores.
  app.patch('/api/sessoes/:id/audio-observadores', autenticar, rota(async (req, res) => {
    const s = await carregar(req.params.id, req.usuario.id);
    if (!s || s.papel !== 'avaliador_ator') return res.status(403).json({ erro: 'Só o chefe da sala pode mudar isso.' });
    if (typeof req.body?.liberado !== 'boolean') return res.status(400).json({ erro: 'Informe liberado: true ou false.' });
    if (s.status === 'finalizada') return res.status(409).json({ erro: 'A sessão já terminou.' });
    await q('update sessoes set audio_observadores=$2 where id=$1', [req.params.id, req.body.liberado]);
    emitir(req.params.id, 'video:permissao', { audio_observadores: req.body.liberado });
    res.json({ audio_observadores: req.body.liberado });
  }));
}
