import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { criarSalaVideo } from './video.js';

/* ---------- utilidades ---------- */
const api = async (caminho, { metodo = 'GET', corpo, token } = {}) => {
  const r = await fetch(caminho, {
    method: metodo,
    headers: {
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || 'Algo deu errado. Tente de novo.');
  return dados;
};
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const fmtN = (n) => String(Number(n).toFixed(n % 1 ? 1 : 0)).replace('.', ',');
const NOMES_AREA = { clinica_medica: 'Clínica', cirurgia: 'Cirurgia', ginecologia_obstetricia: 'GO', pediatria: 'Pediatria', mfc: 'MFC' };
const CORES_AREA = { clinica_medica: 'var(--mar)', pediatria: 'var(--menta)', cirurgia: 'var(--uva)', ginecologia_obstetricia: 'var(--sol)', mfc: 'var(--coral)' };

function Anel({ frac, cor, grande, children }) {
  const C = 314.16;
  return (
    <div className={`anel${grande ? ' grande' : ''}`}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="trilho" cx="60" cy="60" r="50" />
        <circle className="arco" cx="60" cy="60" r="50" stroke={cor} strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.min(1, Math.max(0, frac)))}
          style={grande ? { transition: 'stroke-dashoffset .9s linear, stroke .4s' } : undefined} />
      </svg>
      <div className="num">{children}</div>
    </div>
  );
}

/* ---------- ENTRAR ---------- */
function TelaEntrar({ aoEntrar }) {
  const [modo, setModo] = useState('entrar');
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [etapa, setEtapa] = useState(1);
  const [token, setToken] = useState('');
  const [f, setF] = useState({ nome: '', email: '', senha: '' });
  const [ocupado, setOcupado] = useState(false);
  const regras = { len: f.senha.length >= 10, let: /[A-Za-z]/.test(f.senha), num: /\d/.test(f.senha) };
  const mud = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const entrar = async () => {
    setOcupado(true); setErro(''); setMsg('');
    try {
      const r = await api('/api/auth/entrar', { metodo: 'POST', corpo: { email: f.email, senha: f.senha } });
      aoEntrar(r);
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  const criar = async () => {
    setErro('');
    if (f.nome.trim().length < 2) return setErro('Informe seu nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return setErro('Informe um e-mail válido.');
    if (!(regras.len && regras.let && regras.num)) return setErro('A senha ainda não cumpre as regras abaixo.');
    setOcupado(true);
    try {
      const r = await api('/api/auth/registrar', { metodo: 'POST', corpo: { nome: f.nome, email: f.email, senha: f.senha, token } });
      setModo('entrar'); setEtapa(1); setToken(''); setMsg(r.mensagem);
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  const pedir = async () => {
    setErro(''); setMsg('');
    if (f.nome.trim().length < 2) return setErro('Informe seu nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return setErro('Informe um e-mail válido.');
    try {
      const r = await api('/api/acesso/solicitar', { metodo: 'POST', corpo: { nome: f.nome, email: f.email } });
      setMsg(r.mensagem);
    } catch (e) { setErro(e.message); }
  };

  return (
    <div className="tela">
      <span className="marca"><span className="logo" aria-hidden="true">✚</span>Revalida Prático</span>
      <h1 className="hero">Treine a 2ª fase <em>em dupla</em>, com cronômetro e vídeo.</h1>

      <div className="seg" role="tablist" aria-label="Como você quer acessar">
        {[['entrar', 'Entrar'], ['token', 'Tenho um token'], ['pedir', 'Pedir acesso']].map(([m, rot]) => (
          <button key={m} type="button" role="tab" aria-selected={modo === m} onClick={() => { setModo(m); setErro(''); setMsg(''); }}>{rot}</button>
        ))}
      </div>

      {modo === 'entrar' && (<>
        <p className="sub">Entre com e-mail e senha.</p>
        <div className="campo"><label htmlFor="e-email">E-mail</label>
          <input id="e-email" type="email" autoComplete="email" value={f.email} onChange={mud('email')} /></div>
        <div className="campo"><label htmlFor="e-senha">Senha</label>
          <input id="e-senha" type="password" autoComplete="current-password" value={f.senha} onChange={mud('senha')}
            onKeyDown={(e) => e.key === 'Enter' && entrar()} /></div>
        <div className={`msg${erro ? ' e' : ''}`} role="status">{erro || msg}</div>
        <button className="btn" type="button" disabled={ocupado} onClick={entrar}>{ocupado ? 'Entrando…' : 'Entrar'}</button>
      </>)}

      {modo === 'token' && (<>
        <div className="passos" aria-label="Etapas do cadastro">
          <span className={`passo${etapa === 1 ? ' on' : ''}`}>1 · Token</span>
          <span className={`passo${etapa === 2 ? ' on' : ''}`}>2 · Seus dados</span>
        </div>
        {etapa === 1 ? (<>
          <p className="sub">Digite o token que o administrador enviou. Ele vale para um único cadastro e tem prazo.</p>
          <div className="campo"><label htmlFor="tk-token">Token de cadastro</label>
            <input id="tk-token" autoComplete="off" autoCapitalize="none" spellCheck="false" placeholder="cole o token aqui"
              value={token} onChange={(e) => setToken(e.target.value)} /></div>
          <div className="msg e" role="alert">{erro}</div>
          <button className="btn menta" type="button" onClick={() => {
            if (!token.trim()) return setErro('Informe o token de cadastro. Se você não tem um, use "Pedir acesso".');
            setErro(''); setEtapa(2);
          }}>Continuar</button>
        </>) : (<>
          <div className="tokok"><span>✓ Token informado</span>
            <button type="button" className="ln" onClick={() => setEtapa(1)}>Corrigir token</button></div>
          <div className="campo"><label htmlFor="tk-nome">Nome</label><input id="tk-nome" autoComplete="name" value={f.nome} onChange={mud('nome')} /></div>
          <div className="campo"><label htmlFor="tk-email">E-mail</label><input id="tk-email" type="email" autoComplete="email" value={f.email} onChange={mud('email')} placeholder="o mesmo e-mail do pedido" /></div>
          <div className="campo"><label htmlFor="tk-senha">Senha</label><input id="tk-senha" type="password" autoComplete="new-password" value={f.senha} onChange={mud('senha')} /></div>
          <div className="regras">
            <span className={regras.len ? 'ok' : ''}>{regras.len ? '✓' : '○'} 10+ caracteres</span>
            <span className={regras.let ? 'ok' : ''}>{regras.let ? '✓' : '○'} uma letra</span>
            <span className={regras.num ? 'ok' : ''}>{regras.num ? '✓' : '○'} um número</span>
          </div>
          <div className="msg e" role="alert">{erro}</div>
          <button className="btn menta" type="button" disabled={ocupado} onClick={criar}>{ocupado ? 'Criando…' : 'Criar conta'}</button>
        </>)}
      </>)}

      {modo === 'pedir' && (<>
        <p className="sub">Sem token? Peça ao administrador. Isso não cria conta: você se cadastra depois, com o token que receber.</p>
        <div className="campo"><label htmlFor="pd-nome">Nome</label><input id="pd-nome" autoComplete="name" value={f.nome} onChange={mud('nome')} /></div>
        <div className="campo"><label htmlFor="pd-email">E-mail</label><input id="pd-email" type="email" autoComplete="email" value={f.email} onChange={mud('email')} /></div>
        <div className={`msg${erro ? ' e' : ''}`} role="status">{erro || msg}</div>
        <button className="btn coral" type="button" onClick={pedir}>Enviar pedido</button>
      </>)}

      <div className="aviso">Cadastro só com token de acesso.</div>
    </div>
  );
}

/* ---------- PAINEL ---------- */
function TelaPainel({ usuario, token, aoAbrirSala }) {
  const [desempenho, setDesempenho] = useState(null);
  const [salas, setSalas] = useState([]);
  const [estacoes, setEstacoes] = useState([]);
  const [estacaoId, setEstacaoId] = useState('');
  const [modo, setModo] = useState('dupla');
  const [papel, setPapel] = useState('avaliador_ator');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');

  useEffect(() => {
    api('/api/desempenho', { token }).then(setDesempenho).catch(() => {});
    api('/api/sessoes', { token }).then(setSalas).catch(() => {});
    api('/api/estacoes', { token }).then((l) => { setEstacoes(l); if (l[0]) setEstacaoId(l[0].id); }).catch(() => {});
  }, [token]);

  const criar = async () => {
    setErro('');
    try {
      const r = await api('/api/sessoes', { metodo: 'POST', token, corpo: { estacaoId, modo } });
      aoAbrirSala(r.id, r.papel);
    } catch (e) { setErro(e.message); }
  };
  const entrarCodigo = async () => {
    const id = codigo.trim().split('/').pop();
    if (!id) return setErro('Cole o código ou link da sala.');
    setErro('');
    try {
      const r = await api(`/api/sessoes/${id}/entrar`, { metodo: 'POST', token, corpo: { papel } });
      aoAbrirSala(id, r.papel);
    } catch (e) { setErro(e.message); }
  };

  const notaMedia = desempenho?.nota_media || 0;
  return (
    <div className="tela">
      <div className="topo">
        <div className="quem"><div className="sub">Bom treino,</div><div className="hello">{usuario.nome.split(' ')[0]} 👋</div></div>
        <div className="avatar" aria-hidden="true">{usuario.nome[0]?.toUpperCase()}</div>
      </div>
      <div className="grid2">
        <div className="cartao">
          <Anel frac={notaMedia / 10} cor="var(--menta)"><span>{fmtN(notaMedia)}</span></Anel>
          <div className="leg">nota média</div>
        </div>
        <div className="cartao" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10 }}>
          <div className="stat"><b>{desempenho?.estacoes ?? 0}</b><span>estações feitas</span></div>
          <div className="stat"><b style={{ color: 'var(--coral)' }}>🎥</b><span>vídeo multiusuário</span></div>
        </div>
      </div>
      <div className="sec">Por área</div>
      <div className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(desempenho?.por_area?.length ? desempenho.por_area : [{ area: 'clinica_medica', nota: 0 }]).map((a) => (
          <div className="barra" key={a.area}>
            <span>{NOMES_AREA[a.area] || a.area}</span>
            <i><u style={{ width: `${(a.nota / 10) * 100}%`, background: CORES_AREA[a.area] || 'var(--mar)' }} /></i>
            <b>{fmtN(a.nota)}</b>
          </div>
        ))}
      </div>

      <div className="sec">Criar sala</div>
      <div className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <select value={estacaoId} onChange={(e) => setEstacaoId(e.target.value)} aria-label="Estação">
          {estacoes.map((e) => <option key={e.id} value={e.id}>{e.titulo} · {NOMES_AREA[e.area]} · {e.duracao_min} min</option>)}
        </select>
        <div className="seg">
          <button type="button" aria-selected={modo === 'dupla'} onClick={() => setModo('dupla')}>Em dupla</button>
          <button type="button" aria-selected={modo === 'solo'} onClick={() => setModo('solo')}>Solo</button>
        </div>
        <button className="btn menta" type="button" onClick={criar} disabled={!estacaoId}>Criar e entrar</button>
      </div>

      <div className="sec">Entrar com código</div>
      <div className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="codigo">
          <input placeholder="código ou link da sala" value={codigo} onChange={(e) => setCodigo(e.target.value)} />
          <button className="btn mini" type="button" onClick={entrarCodigo}>Entrar</button>
        </div>
        <div className="seg">
          {[['avaliador_ator', 'Avaliar'], ['candidato', 'Ser candidato'], ['observador', 'Observar']].map(([p, rot]) => (
            <button key={p} type="button" aria-selected={papel === p} onClick={() => setPapel(p)}>{rot}</button>
          ))}
        </div>
        {erro && <div className="msg e" role="alert">{erro}</div>}
      </div>

      <div className="sec">Minhas salas</div>
      {salas.length === 0 && <p className="sub">Nenhuma sala ainda. Crie uma acima!</p>}
      {salas.map((s) => (
        <button className="sala" type="button" key={s.id} onClick={() => aoAbrirSala(s.id, s.papel)}>
          <span className="ic" style={{ background: s.papel === 'avaliador_ator' ? 'var(--coral-t)' : s.papel === 'candidato' ? 'var(--uva-t)' : 'var(--sol-t)' }}>
            {s.papel === 'avaliador_ator' ? '🩺' : s.papel === 'candidato' ? '🧑‍⚕️' : '👀'}</span>
          <span><b>{s.titulo}</b><small>Você {s.papel === 'avaliador_ator' ? 'avalia' : s.papel === 'candidato' ? 'é candidato' : 'observa'} · {s.observadores} observador(es)</small></span>
          <span className={`tag ${s.status === 'em_andamento' ? 'vivo' : 'espera'}`}>
            {s.status === 'em_andamento' ? 'ao vivo' : s.status === 'finalizada' ? 'finalizada' : 'aguardando'}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- TILE DE VÍDEO ---------- */
function Tile({ nome, track, demo, alt }) {
  const ref = useRef(null);
  useEffect(() => {
    if (track && ref.current) { track.play(ref.current); return () => { try { track.stop(); } catch {} }; }
  }, [track]);
  return (
    <div className={`tile${alt ? ' a' : ''}`}>
      {demo && <span className="demo-tag">demo</span>}
      {track ? <div ref={ref} style={{ position: 'absolute', inset: 0 }} /> : <div className="ini" aria-hidden="true">{nome[0]?.toUpperCase()}</div>}
      <span className="nome">{nome}</span>
    </div>
  );
}

/* ---------- SALA ---------- */
function TelaSala({ sessaoId, token, usuario, aoSair }) {
  const [dados, setDados] = useState(null);
  const [meuPapel, setMeuPapel] = useState(null);
  const [timer, setTimer] = useState({ status: 'parado', restante_ms: 0 });
  const [videos, setVideos] = useState({});   // uid -> {track, nome}
  const [participantes, setParticipantes] = useState([]);
  const [marcas, setMarcas] = useState({});
  const [placar, setPlacar] = useState({ total: 0, max: 0 });
  const [resultado, setResultado] = useState(null);
  const [comentarios, setComentarios] = useState([]);
  const [textoComent, setTextoComent] = useState('');
  const [erro, setErro] = useState('');
  const [avisoVideo, setAvisoVideo] = useState('');
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [demo, setDemo] = useState(false);
  const [confete, setConfete] = useState(false);
  const refs = useRef({ socket: null, video: null });

  const souAvaliador = meuPapel === 'avaliador_ator';
  const souObservador = meuPapel === 'observador';
  const controlaTimer = souAvaliador || dados?.sessao?.modo === 'solo';

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const d = await api(`/api/sessoes/${sessaoId}`, { token });
        if (!vivo) return;
        setDados(d); setMeuPapel(d.meuPapel); setTimer(d.timer);
        setParticipantes(d.participantes); setComentarios(d.comentarios);
        if (d.resultado) setResultado({ nota: d.resultado.nota, max: d.resultado.nota_max });

        const socket = io({ auth: { token } });
        refs.current.socket = socket;
        socket.emit('sala:entrar', { sessaoId }, () => {});
        socket.on('timer:estado', (t) => vivo && setTimer(t));
        socket.on('sala:presenca', (p) => vivo && setParticipantes(p));
        socket.on('pep:placar', (p) => vivo && setPlacar(p));
        socket.on('comentario:novo', (c) => vivo && setComentarios((l) => [...l, c]));
        socket.on('sessao:finalizada', (r) => {
          if (!vivo) return;
          setResultado(r); setConfete(true);
          setTimer((t) => ({ ...t, status: 'parado' }));
        });

        const video = await criarSalaVideo({
          sessaoId, tokenAuth: token,
          aoMudar: (ev) => {
            if (!vivo) return;
            if (ev.tipo === 'video') setVideos((v) => ({ ...v, [ev.uid]: { track: ev.track, nome: ev.local ? 'Você' : `Participante` } }));
            if (ev.tipo === 'saiu-video' || ev.tipo === 'saiu') setVideos((v) => { const n = { ...v }; delete n[ev.uid]; return n; });
          },
          aoErro: (m) => vivo && setAvisoVideo(m),
        });
        if (!vivo) { video.sair?.(); return; }
        refs.current.video = video;
        if (video.modo === 'demo') setDemo(true);
      } catch (e) { vivo && setErro(e.message); }
    })();
    return () => {
      vivo = false;
      refs.current.socket?.disconnect();
      refs.current.video?.sair?.();
    };
  }, [sessaoId, token]);

  // cronômetro local (1s) enquanto o servidor diz "rodando"
  useEffect(() => {
    if (timer.status !== 'rodando') return;
    const iv = setInterval(() => setTimer((t) => ({ ...t, restante_ms: Math.max(0, t.restante_ms - 1000) })), 1000);
    return () => clearInterval(iv);
  }, [timer.status]);

  if (erro) return <div className="tela"><div className="msg e" role="alert">{erro}</div><button className="btn" onClick={aoSair}>Voltar</button></div>;
  if (!dados) return <div className="tela"><p className="sub">Abrindo a sala…</p></div>;

  const total = dados.sessao.duracao_min * 60000;
  const rest = timer.restante_ms;
  const restS = Math.ceil(rest / 1000);
  const corTimer = restS <= 60 ? 'var(--coral)' : restS <= 180 ? 'var(--sol)' : 'var(--mar)';
  const estadoTimer = rest <= 0 ? 'Tempo esgotado'
    : timer.status === 'rodando' ? 'Em andamento'
    : timer.restante_ms === total ? 'Pronto para começar' : 'Pausado';
  const acaoTimer = timer.status === 'rodando' ? 'pausar' : timer.restante_ms === total ? 'iniciar' : 'retomar';
  const maxPep = dados.pep.reduce((n, i) => n + Number(i.pontos_total), 0);
  const observadores = participantes.filter((p) => p.papel === 'observador');
  const papelRotulo = souAvaliador ? 'Você é avaliador(a)' : souObservador ? 'Você está observando' : 'Você é candidato(a)';

  const marcar = (item, nivel) => {
    setMarcas((m) => ({ ...m, [item.id]: nivel }));
    refs.current.socket?.emit('pep:marcar', { pepItemId: item.id, nivel });
  };
  const finalizar = () => {
    if (!window.confirm('Finalizar a avaliação? Itens sem marcação contam como 0.')) return;
    refs.current.socket?.emit('pep:finalizar');
  };
  const enviarComentario = () => {
    const texto = textoComent.trim();
    if (!texto) return;
    refs.current.socket?.emit('comentario:novo', { texto, tempoMs: total - rest });
    setTextoComent('');
  };

  return (
    <div className="tela">
      {confete && <Confete aoFim={() => setConfete(false)} />}
      <div className="topo">
        <div className="quem"><div className="sub">{papelRotulo}</div>
          <h2 style={{ fontSize: '1.25rem' }}>{dados.sessao.titulo}</h2></div>
      </div>

      <div className="cartao timer">
        <Anel grande frac={1 - rest / total} cor={corTimer}><span>{fmt(restS)}</span></Anel>
        <div className="ctl">
          <div className="estado" role="timer">{estadoTimer}</div>
          {controlaTimer && !resultado && (
            <button className="btn menta" type="button" disabled={rest <= 0}
              onClick={() => refs.current.socket?.emit('timer:acao', { acao: acaoTimer })}>
              {timer.status === 'rodando' ? '⏸ Pausar' : timer.restante_ms === total ? '▶ Iniciar' : '▶ Retomar'}
            </button>
          )}
          {dados.sessao.modo === 'dupla' && (
            <button className="ln" type="button" style={{ textAlign: 'left' }}
              onClick={() => navigator.clipboard?.writeText(sessaoId)}>🔗 copiar código da sala</button>
          )}
        </div>
      </div>

      {avisoVideo && <div className="aviso">{avisoVideo}</div>}
      <div className="videos">
        {demo ? (<>
          <Tile nome="Candidato" demo alt={false} />
          <Tile nome="Você" demo alt />
        </>) : (
          Object.entries(videos).length ? Object.entries(videos).map(([uid, v], i) => (
            <Tile key={uid} nome={v.nome} track={v.track} alt={i % 2 === 1} />
          )) : <Tile nome={usuario.nome} />
        )}
      </div>
      {!demo && refs.current.video?.modo === 'agora' && !souObservador && (
        <div className="midia">
          <button className="btn mini" type="button" onClick={async () => { await refs.current.video.alternarMic(!mic); setMic(!mic); }}>
            {mic ? '🎙 Microfone ligado' : '🔇 Microfone mudo'}</button>
          <button className="btn mini" type="button" onClick={async () => { await refs.current.video.alternarCam(!cam); setCam(!cam); }}>
            {cam ? '📷 Câmera ligada' : '📷 Câmera desligada'}</button>
        </div>
      )}
      <div className="plateia">
        <span className="cabecas" aria-hidden="true">
          {observadores.slice(0, 5).map((o, i) => <i key={i} style={{ background: ['var(--coral)', 'var(--sol)', 'var(--uva)', 'var(--menta)', 'var(--mar)'][i % 5] }} />)}
        </span>
        {observadores.length} observador(es) assistindo
      </div>

      {souAvaliador && dados.sessao.script_ator && (
        <div className="cartao"><div className="sec" style={{ marginBottom: 6 }}>Script do paciente simulado</div>
          <p className="sub" style={{ fontSize: '.9rem' }}>{dados.sessao.script_ator}</p></div>
      )}

      {dados.pep.length > 0 && (souAvaliador || dados.sessao.modo === 'solo') && !resultado && (<>
        <div className="sec">Checklist</div>
        <div className="pep">
          {dados.pep.map((it, i) => {
            const niveis = [['nao_realizado', '0', 'z'], ...(it.pontos_parcial != null ? [['parcial', fmtN(it.pontos_parcial), 'p']] : []), ['total', fmtN(it.pontos_total), 't']];
            return (
              <div className={`item${it.critico ? ' crit' : ''}`} key={it.id}>
                {it.critico && <span className="crit-t">ITEM CRÍTICO</span>}
                <p>{i + 1}. {it.descricao}</p>
                <div className="niveis" role="group" aria-label={`Pontuação do item ${i + 1}`}>
                  {niveis.map(([n, rot, cls]) => (
                    <button key={n} type="button" className={`nv ${cls}`}
                      aria-pressed={marcas[it.id] === n} onClick={() => marcar(it, n)}>{rot}</button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cartao" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="placar"><b>{fmtN(placar.total)}</b><small>/ {fmtN(placar.max || maxPep)} pts</small></div>
          <button className="btn coral" type="button" style={{ flex: 1 }} onClick={finalizar}>Finalizar</button>
        </div>
      </>)}

      {souObservador && !resultado && (<>
        <div className="sec">Seus comentários (só você vê durante a prova)</div>
        <div className="codigo">
          <input placeholder={`comentário aos ${fmt(total / 1000 - restS)}`} value={textoComent}
            onChange={(e) => setTextoComent(e.target.value)} maxLength={500}
            onKeyDown={(e) => e.key === 'Enter' && enviarComentario()} />
          <button className="btn mini menta" type="button" onClick={enviarComentario}>Anotar</button>
        </div>
        <div className="coment">
          {comentarios.map((c, i) => (
            <div className="c" key={c.id || i}><small>{fmt(Math.floor((c.tempo_ms || 0) / 1000))}</small><b>{c.autor}:</b> {c.texto}</div>
          ))}
        </div>
      </>)}

      {resultado && (
        <div className="cartao resultado">
          <div className="sec">Avaliação finalizada 🎉</div>
          <b>{fmtN(resultado.nota)}</b>
          <div className="sub">de {fmtN(resultado.max)} pontos</div>
          <button className="btn" type="button" style={{ marginTop: 10 }} onClick={aoSair}>Voltar ao painel</button>
        </div>
      )}
    </div>
  );
}

function Confete({ aoFim }) {
  useEffect(() => { const t = setTimeout(aoFim, 2600); return () => clearTimeout(t); }, [aoFim]);
  const reduz = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduz) return null;
  const cores = ['--mar', '--menta', '--coral', '--sol', '--uva'];
  return (
    <div className="confete" aria-hidden="true">
      {Array.from({ length: 42 }).map((_, i) => (
        <i key={i} style={{
          left: `${Math.random() * 100}%`, background: `var(${cores[i % 5]})`,
          animationDelay: `${Math.random() * 0.5}s`, animationDuration: `${1.2 + Math.random() * 0.9}s`,
        }} />
      ))}
    </div>
  );
}

/* ---------- RAIZ ---------- */
export default function App() {
  const [sessaoAuth, setSessaoAuth] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rp-auth')); } catch { return null; }
  });
  const [tela, setTela] = useState('painel');
  const [sala, setSala] = useState(null); // {id, papel}
  const temaEscuro = () => document.documentElement.dataset.theme === 'dark';

  const entrar = (r) => { localStorage.setItem('rp-auth', JSON.stringify(r)); setSessaoAuth(r); setTela('painel'); };
  const sair = () => { localStorage.removeItem('rp-auth'); setSessaoAuth(null); setSala(null); setTela('entrar'); };
  const abrirSala = (id, papel) => { setSala({ id, papel }); setTela('sala'); };

  return (
    <div className="app">
      <div className="blobs" aria-hidden="true"><i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="blob b4" /></div>
      {!sessaoAuth ? <TelaEntrar aoEntrar={entrar} /> : (
        tela === 'sala' && sala ? (
          <TelaSala key={sala.id} sessaoId={sala.id} token={sessaoAuth.token} usuario={sessaoAuth.usuario}
            aoSair={() => setTela('painel')} />
        ) : <TelaPainel usuario={sessaoAuth.usuario} token={sessaoAuth.token} aoAbrirSala={abrirSala} />
      )}
      {sessaoAuth && (
        <nav className="nav" aria-label="Navegação">
          <button type="button" aria-current={tela === 'painel' ? 'page' : undefined} onClick={() => setTela('painel')}><span aria-hidden="true">🏠</span>Início</button>
          <button type="button" aria-current={tela === 'sala' ? 'page' : undefined} disabled={!sala}
            onClick={() => sala && setTela('sala')} style={!sala ? { opacity: .4 } : undefined}><span aria-hidden="true">🎥</span>Sala</button>
          <button type="button" onClick={sair}><span aria-hidden="true">🚪</span>Sair</button>
        </nav>
      )}
    </div>
  );
}
