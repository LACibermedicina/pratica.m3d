import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { criarSalaVideo } from './video.js';
import Instalador from './Instalador.jsx';
import { gravarModo, podeTrocarVersao } from './dispositivo.js';

/* Relógio de bolso: atalho discreto, sempre no canto, para a versão mini (/watch/). */
function RelogioDeBolso() {
  return (
    <button type="button" className="rel-bolso" aria-label="Abrir a versão relógio (mini)" title="Versão relógio (mini)"
      onClick={() => {
        try { const t = JSON.parse(window.localStorage.getItem('rp-auth'))?.token; if (t) window.localStorage.setItem('rv-watch', t); } catch { /* sem sessão */ }
        gravarModo(window.localStorage, 'relogio'); window.location.assign('/watch/');
      }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 2.5h4M12 2.5v2.2" /><circle cx="12" cy="13.5" r="7.5" /><circle cx="12" cy="13.5" r="5.6" strokeWidth="0.8" />
        <path d="M12 9.8v3.9l2.6 1.6" /><path d="M18.2 6.2l1.3-1.3" />
      </svg>
    </button>
  );
}

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
  if (!r.ok) {
    if (r.status === 401 && token) window.dispatchEvent(new Event('rp-401')); // sessão encerrada no servidor (bloqueio, troca de senha…)
    throw new Error(dados.erro || 'Algo deu errado. Tente de novo.');
  }
  return dados;
};
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const REGRAS_SENHA = (v) => ({ len: v.length >= 10, let: /[A-Za-z]/.test(v), num: /\d/.test(v) });
const senhaOk = (v) => { const r = REGRAS_SENHA(v); return r.len && r.let && r.num && v.length <= 128; };
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
function TelaEntrar({ aoEntrar, aviso = '' }) {
  const [modo, setModo] = useState('entrar');
  const [msg, setMsg] = useState(aviso);
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
  const recuperar = async () => {
    setErro(''); setMsg('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return setErro('Informe um e-mail válido.');
    setOcupado(true);
    try {
      const r = await api('/api/auth/recuperar', { metodo: 'POST', corpo: { email: f.email } });
      setMsg(r.mensagem);
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
    <div className="tela estreita">
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
        <button type="button" className="ln" onClick={() => { setModo('recuperar'); setErro(''); setMsg(''); }}>Esqueci minha senha</button>
      </>)}

      {modo === 'recuperar' && (<>
        <p className="sub">Informe o e-mail da conta. Se ela existir, enviamos um link para criar uma nova senha (vale 60 minutos).</p>
        <div className="campo"><label htmlFor="rc-email">E-mail</label>
          <input id="rc-email" type="email" autoComplete="email" value={f.email} onChange={mud('email')}
            onKeyDown={(e) => e.key === 'Enter' && recuperar()} /></div>
        <div className={`msg${erro ? ' e' : ''}`} role="status">{erro || msg}</div>
        <button className="btn" type="button" disabled={ocupado} onClick={recuperar}>{ocupado ? 'Enviando…' : 'Enviar link'}</button>
        <button type="button" className="ln" onClick={() => { setModo('entrar'); setErro(''); setMsg(''); }}>← Voltar para entrar</button>
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

/* ---------- REDEFINIR SENHA (link do e-mail) ---------- */
function TelaRedefinir({ token, aoConcluir, aoCancelar }) {
  const [senha, setSenha] = useState('');
  const [conf, setConf] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const r = REGRAS_SENHA(senha);
  const salvar = async () => {
    setErro('');
    if (!senhaOk(senha)) return setErro('A senha ainda não cumpre as regras abaixo.');
    if (senha !== conf) return setErro('As senhas não são iguais.');
    setOcupado(true);
    try {
      const x = await api('/api/auth/redefinir', { metodo: 'POST', corpo: { token, senha } });
      aoConcluir(x.mensagem);
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  return (
    <div className="tela estreita">
      <span className="marca"><span className="logo" aria-hidden="true">✚</span>Revalida Prático</span>
      <h1 className="hero">Crie uma <em>nova senha</em></h1>
      <p className="sub">Escolha uma senha que você não usa em outros lugares.</p>
      <div className="campo"><label htmlFor="rd-senha">Nova senha</label>
        <input id="rd-senha" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></div>
      <div className="campo"><label htmlFor="rd-conf">Repita a senha</label>
        <input id="rd-conf" type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && salvar()} /></div>
      <div className="regras">
        <span className={r.len ? 'ok' : ''}>{r.len ? '✓' : '○'} 10+ caracteres</span>
        <span className={r.let ? 'ok' : ''}>{r.let ? '✓' : '○'} uma letra</span>
        <span className={r.num ? 'ok' : ''}>{r.num ? '✓' : '○'} um número</span>
      </div>
      <div className="msg e" role="alert">{erro}</div>
      <button className="btn menta" type="button" disabled={ocupado} onClick={salvar}>{ocupado ? 'Salvando…' : 'Salvar nova senha'}</button>
      <button type="button" className="ln" onClick={aoCancelar}>Cancelar</button>
    </div>
  );
}

/* ---------- CONTA ---------- */
function TelaConta({ sessaoAuth, token, aoAtualizar, aoSair }) {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const r = REGRAS_SENHA(nova);
  const trocar = async () => {
    setErro(''); setMsg('');
    if (!senhaOk(nova)) return setErro('A nova senha ainda não cumpre as regras abaixo.');
    setOcupado(true);
    try {
      const x = await api('/api/auth/trocar-senha', { metodo: 'POST', token, corpo: { atual, nova } });
      aoAtualizar({ token: x.token, usuario: x.usuario, senhaProvisoria: false });
      setAtual(''); setNova(''); setMsg('Senha trocada. Os outros aparelhos foram desconectados.');
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  const papel = { root: 'Administrador raiz', admin: 'Administrador', moderador: 'Moderador', usuario: 'Usuário' }[sessaoAuth.usuario.papel_app] || '';
  return (
    <div className="tela estreita">
      <div className="topo"><div className="quem"><div className="sub">{papel}</div><h2 style={{ fontSize: '1.3rem' }}>{sessaoAuth.usuario.nome}</h2></div></div>
      {sessaoAuth.senhaProvisoria && <div className="aviso">Sua senha é provisória e conhecida por quem configurou o sistema. Troque-a agora.</div>}
      <div className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="sec">Trocar senha</div>
        <div className="campo"><label htmlFor="cs-atual">Senha atual</label>
          <input id="cs-atual" type="password" autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} /></div>
        <div className="campo"><label htmlFor="cs-nova">Nova senha</label>
          <input id="cs-nova" type="password" autoComplete="new-password" value={nova} onChange={(e) => setNova(e.target.value)} /></div>
        <div className="regras">
          <span className={r.len ? 'ok' : ''}>{r.len ? '✓' : '○'} 10+ caracteres</span>
          <span className={r.let ? 'ok' : ''}>{r.let ? '✓' : '○'} uma letra</span>
          <span className={r.num ? 'ok' : ''}>{r.num ? '✓' : '○'} um número</span>
        </div>
        <div className={`msg${erro ? ' e' : ''}`} role="status">{erro || msg}</div>
        <button className="btn menta" type="button" disabled={ocupado} onClick={trocar}>{ocupado ? 'Salvando…' : 'Trocar senha'}</button>
      </div>
      <button className="btn coral" type="button" onClick={aoSair}>Sair da conta</button>
    </div>
  );
}

/* ---------- ADMINISTRAÇÃO (moderador, admin e root; o servidor confere cada ação) ---------- */
const PRAZOS = [['24', '24 h'], ['72', '72 h'], ['168', '7 dias']];
const ROTULO_PAPEL_APP = { usuario: 'usuário', moderador: 'moderador', admin: 'admin', root: 'root' };
const dataCurta = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function TelaAdmin({ token, usuario }) {
  const euRoot = usuario.papel_app === 'root';
  const ehAdmin = euRoot || usuario.papel_app === 'admin';
  const abas = [...(ehAdmin ? [['pedidos', 'Pedidos'], ['tokens', 'Tokens'], ['usuarios', 'Usuários']] : []), ['estacoes', 'Estações'], ...(ehAdmin ? [['registro', 'Registro']] : []), ...(euRoot ? [['sistema', 'Sistema']] : [])];
  const [aba, setAba] = useState(abas[0][0]);
  const [cx, setCx] = useState({ aba: '', lista: [] });   // lista + a aba a que ela pertence (evita mostrar dados da aba anterior)
  const dados = cx.aba === aba ? cx.lista : [];
  const [busca, setBusca] = useState('');
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [segredo, setSegredo] = useState(null);      // { titulo, valor, nota } — aparece uma vez
  const [form, setForm] = useState({ email: '', nota: '', validadeH: '72', usosMax: '1' });
  const [prazo, setPrazo] = useState({});

  const carregar = async () => {
    setErro('');
    const rota = { pedidos: '/api/admin/pedidos', tokens: '/api/admin/tokens', usuarios: `/api/admin/usuarios?busca=${encodeURIComponent(busca)}`, estacoes: '/api/admin/estacoes?status=revisao', registro: '/api/admin/auditoria' }[aba];
    const daAba = aba;
    if (aba === 'sistema') { setCx({ aba: daAba, lista: [] }); return; }
    try { setCx({ aba: daAba, lista: await api(rota, { token }) }); } catch (e) { setErro(e.message); setCx({ aba: daAba, lista: [] }); }
  };
  useEffect(() => { setMsg(''); carregar(); }, [aba]); // eslint-disable-line react-hooks/exhaustive-deps

  const agir = async (caminho, metodo, corpo, ok) => {
    setErro(''); setMsg('');
    try { const r = await api(caminho, { metodo, token, corpo }); if (ok) ok(r); await carregar(); return r; }
    catch (e) { setErro(e.message); }
  };
  const copiar = (t) => navigator.clipboard?.writeText(t).then(() => setMsg('Copiado.')).catch(() => setMsg('Selecione e copie à mão.'));

  return (
    <div className="tela admin">
      <div className="topo"><div className="quem"><div className="sub">{euRoot ? 'Painel do administrador raiz' : ehAdmin ? 'Painel do administrador' : 'Painel do moderador'}</div><h2 style={{ fontSize: '1.3rem' }}>Administração</h2></div></div>
      <div className="seg rolavel" role="tablist">
        {abas.map(([k, rot]) => <button key={k} type="button" role="tab" aria-selected={aba === k} onClick={() => setAba(k)}>{rot}</button>)}
      </div>

      {segredo && (
        <div className="cartao segredo-box" role="status">
          <div className="sec">{segredo.titulo}</div>
          <code className="segredo">{segredo.valor}</code>
          {segredo.nota && <p className="sub">{segredo.nota}</p>}
          <p className="sub">Guarde agora: por segurança, não será mostrado de novo.</p>
          <div className="midia"><button className="btn mini" type="button" onClick={() => copiar(segredo.valor)}>Copiar</button>
            <button className="btn mini coral" type="button" onClick={() => setSegredo(null)}>Fechar</button></div>
        </div>
      )}
      <div className={`msg${erro ? ' e' : ''}`} role="status">{erro || msg}</div>

      {aba === 'pedidos' && (dados.length === 0 ? <p className="sub">Nenhum pedido pendente.</p> : dados.map((p) => (
        <div className="cartao item-adm" key={p.id}>
          <b>{p.nome}</b><small>{p.email} · {dataCurta(p.criado_em)}</small>
          {p.mensagem && <p className="sub">“{p.mensagem}”</p>}
          <div className="acoes">
            <select aria-label="Validade do token" value={prazo[p.id] || '72'} onChange={(e) => setPrazo({ ...prazo, [p.id]: e.target.value })}>
              {PRAZOS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}</select>
            <button className="btn mini menta" type="button" onClick={() => agir(`/api/admin/pedidos/${p.id}/aprovar`, 'POST', { validadeH: Number(prazo[p.id] || 72) },
              (r) => setSegredo({ titulo: `Token para ${p.nome}`, valor: r.token, nota: r.emailEnviado ? 'Também enviado por e-mail.' : 'E-mail não enviado: envie você o token.' }))}>Aprovar</button>
            <button className="btn mini coral" type="button" onClick={() => window.confirm('Recusar este pedido?') && agir(`/api/admin/pedidos/${p.id}/recusar`, 'POST')}>Recusar</button>
          </div>
        </div>
      )))}

      {aba === 'tokens' && (<>
        <div className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="sec">Novo token</div>
          <input aria-label="E-mail (opcional)" type="email" placeholder="e-mail da pessoa (opcional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input aria-label="Nota" placeholder="nota (opcional)" maxLength={120} value={form.nota} onChange={(e) => setForm({ ...form, nota: e.target.value })} />
          <div className="acoes">
            <select aria-label="Validade" value={form.validadeH} onChange={(e) => setForm({ ...form, validadeH: e.target.value })}>{PRAZOS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}</select>
            {euRoot ? <input aria-label="Usos" type="number" min="1" max="100" style={{ width: 90 }} value={form.usosMax} onChange={(e) => setForm({ ...form, usosMax: e.target.value })} /> : <span className="sub">1 uso</span>}
          </div>
          <button className="btn menta" type="button" onClick={() => agir('/api/admin/tokens', 'POST',
            { email: form.email || undefined, nota: form.nota || undefined, validadeH: Number(form.validadeH), ...(euRoot ? { usosMax: Number(form.usosMax) } : {}) },
            (r) => setSegredo({ titulo: 'Token criado', valor: r.token }))}>Criar token</button>
        </div>
        <div className="sec">Tokens ativos</div>
        {dados.length === 0 ? <p className="sub">Nenhum.</p> : dados.map((t) => (
          <div className="cartao item-adm" key={t.id}>
            <b>{t.tipo}{t.email_preso ? ` · ${t.email_preso}` : ''}</b>
            <small>{t.usos}/{t.usos_max} usos · {t.expira_em ? `vence ${dataCurta(t.expira_em)}` : 'sem prazo'}{t.nota ? ` · ${t.nota}` : ''}</small>
            <div className="acoes"><button className="btn mini coral" type="button" onClick={() => window.confirm('Revogar este token?') && agir(`/api/admin/tokens/${t.id}/revogar`, 'POST')}>Revogar</button></div>
          </div>))}
      </>)}

      {aba === 'usuarios' && (<>
        <div className="codigo"><input aria-label="Buscar" placeholder="buscar por nome ou e-mail" value={busca} onChange={(e) => setBusca(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && carregar()} />
          <button className="btn mini" type="button" onClick={carregar}>Buscar</button></div>
        {dados.map((u) => {
          const intocavel = u.papel_app === 'root' || u.id === usuario.id || (!euRoot && !['usuario', 'moderador'].includes(u.papel_app));
          return (
            <div className="cartao item-adm" key={u.id}>
              <b>{u.nome} <span className={`tag ${u.ativo ? 'vivo' : 'espera'}`}>{u.ativo ? ROTULO_PAPEL_APP[u.papel_app] : 'bloqueado'}</span></b>
              <small>{u.email}</small>
              {!intocavel && (
                <div className="acoes">
                  <button className="btn mini coral" type="button" onClick={() => agir(`/api/admin/usuarios/${u.id}`, 'PATCH', { ativo: !u.ativo })}>{u.ativo ? 'Bloquear' : 'Desbloquear'}</button>
                  {u.ativo && <button className="btn mini" type="button" onClick={() => agir(`/api/admin/usuarios/${u.id}/redefinicao`, 'POST', undefined,
                    (r) => setSegredo({ titulo: `Link de senha de ${u.nome}`, valor: r.link, nota: `Vale ${r.validadeMin} minutos. Entregue à pessoa por um canal seguro.` }))}>Link de senha</button>}
                  {euRoot && <select aria-label="Papel" value={u.papel_app} onChange={(e) => agir(`/api/admin/usuarios/${u.id}`, 'PATCH', { papel_app: e.target.value })}>
                    {['usuario', 'moderador', 'admin'].map((p) => <option key={p} value={p}>{ROTULO_PAPEL_APP[p]}</option>)}</select>}
                </div>)}
            </div>);
        })}
      </>)}

      {aba === 'estacoes' && (dados.length === 0 ? <p className="sub">Nenhuma estação aguardando revisão.</p> : dados.map((e) => (
        <div className="cartao item-adm" key={e.id}><b>{e.titulo}</b><small>{e.area} · {e.origem} · {e.duracao_min} min</small>
          <div className="acoes"><button className="btn mini menta" type="button" onClick={() => agir(`/api/admin/estacoes/${e.id}/status`, 'POST', { status: 'aprovada' })}>Aprovar</button>
            <button className="btn mini" type="button" onClick={() => agir(`/api/admin/estacoes/${e.id}/status`, 'POST', { status: 'rascunho' })}>Devolver</button></div></div>)))}

      {aba === 'sistema' && <SistemaRoot token={token} />}

      {aba === 'registro' && dados.map((a) => (
        <div className="cartao item-adm" key={a.id}><b>{a.acao.replaceAll('_', ' ')}</b><small>{a.ator || 'sistema'} · {a.alvo || '—'} · {dataCurta(a.criado_em)}</small></div>))}
    </div>
  );
}

/* ---------- SISTEMA (só root): reinstalar e limpar banco ---------- */
function SistemaRoot({ token }) {
  const [f, setF] = useState({ senha: '', confirmacao: '', apagarEstacoes: false });
  const [acao, setAcao] = useState(null); // 'reinstalar' | 'limpar-banco'
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const FRASE = { 'reinstalar': 'REINSTALAR', 'limpar-banco': 'APAGAR TUDO' };
  const executar = async () => {
    setErro(''); setOcupado(true);
    try {
      await api(`/api/admin/instalacao/${acao}`, { metodo: 'POST', token, corpo: { senha: f.senha, confirmacao: f.confirmacao, apagarEstacoes: f.apagarEstacoes } });
      try { localStorage.removeItem('rp-auth'); } catch { /* ok */ }
      window.location.reload(); // o instalador reaberto assume a tela
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  return (
    <div className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="sistema">
      <div className="sec">Instalação do sistema</div>
      <p className="sub">Só você (root) pode reabrir o instalador. Enquanto ele estiver aberto, todos os visitantes veem o instalador; o código aparece no log do servidor.</p>
      {!acao && (<>
        <button className="btn mini" type="button" onClick={() => setAcao('reinstalar')}>Reinstalar o sistema (mantém os dados)</button>
        <button className="btn mini coral" type="button" onClick={() => setAcao('limpar-banco')}>Limpar o banco de dados…</button>
      </>)}
      {acao && (<>
        <div className="aviso">{acao === 'reinstalar'
          ? 'O instalador será reaberto. Usuários, salas e avaliações continuam; você passa de novo pelas etapas.'
          : 'APAGA todos os usuários (inclusive você), salas, avaliações, comentários e tokens, e reabre o instalador. Não dá para desfazer.'}</div>
        {acao === 'limpar-banco' && (
          <label className="chave-audio"><input type="checkbox" checked={f.apagarEstacoes} onChange={(e) => setF({ ...f, apagarEstacoes: e.target.checked })} /><span>Apagar também as estações e checklists</span></label>
        )}
        <label className="campo">Sua senha<input type="password" value={f.senha} autoComplete="current-password" onChange={(e) => setF({ ...f, senha: e.target.value })} /></label>
        <label className="campo">Digite <b>{FRASE[acao]}</b> para confirmar<input value={f.confirmacao} autoComplete="off" onChange={(e) => setF({ ...f, confirmacao: e.target.value })} /></label>
        {erro && <div className="msg e" role="alert">{erro}</div>}
        <div className="acoes">
          <button className="btn mini" type="button" onClick={() => { setAcao(null); setErro(''); setF({ senha: '', confirmacao: '', apagarEstacoes: false }); }}>Cancelar</button>
          <button className="btn mini coral" type="button" disabled={ocupado || !f.senha || f.confirmacao !== FRASE[acao]} onClick={executar}>Confirmar</button>
        </div>
      </>)}
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
    <div className="tela painel">
      <div className="topo">
        <div className="quem"><div className="sub">Bom treino,</div><div className="hello">{usuario.nome.split(' ')[0]} 👋</div></div>
        <div className="avatar" aria-hidden="true">{usuario.nome[0]?.toUpperCase()}</div>
      </div>
      <div className="col">
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

      </div>
      <div className="col">
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

      </div>
      <div className="sec largo">Minhas salas</div>
      {salas.length === 0 && <p className="sub largo">Nenhuma sala ainda. Crie uma acima!</p>}
      <div className="salas-lista">
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
  const [mic, setMic] = useState(false);
  const [cam, setCam] = useState(false);
  const [demo, setDemo] = useState(false);
  const [conectando, setConectando] = useState(true);
  const [audioObs, setAudioObs] = useState(false);       // o chefe liberou o áudio dos observadores?
  const [podeAudio, setPodeAudio] = useState(false);     // eu posso usar o microfone? (decisão do servidor)
  const [somBloqueado, setSomBloqueado] = useState(false);
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

        setAudioObs(Boolean(d.sessao.audio_observadores));
        socket.on('video:permissao', (p) => {
          if (!vivo) return;
          setAudioObs(Boolean(p.audio_observadores));
          refs.current.video?.sincronizar?.().then((pd) => { if (vivo && pd) setPodeAudio(Boolean(pd.audio)); });
        });
        // o vídeo abre sozinho; se falhar (rede), tenta de novo quando a estação começar
        refs.current.iniciarVideo = async () => {
          if (refs.current.video || refs.current.abrindo || !vivo) return;
          refs.current.abrindo = true; setConectando(true);
          try {
            const video = await criarSalaVideo({
              sessaoId, tokenAuth: token,
              aoMudar: (ev) => {
                if (!vivo) return;
                if (ev.tipo === 'video') setVideos((v) => ({ ...v, [ev.uid]: { track: ev.track, nome: ev.local ? 'Você' : 'Participante' } }));
                if (ev.tipo === 'saiu-video' || ev.tipo === 'saiu') setVideos((v) => { const n = { ...v }; delete n[ev.uid]; return n; });
              },
              aoErro: (m) => vivo && setAvisoVideo(m),
              aoPermissao: (a) => vivo && setPodeAudio(a),
              aoSomBloqueado: (b) => vivo && setSomBloqueado(b),
            });
            if (!vivo) { video.sair?.(); return; }
            refs.current.video = video;
            setPodeAudio(Boolean(video.pode?.audio));
            if (video.modo === 'demo') { setDemo(true); const pr = d.meuPapel !== 'observador'; setCam(pr); setMic(pr); }
            else { setCam(video.cameraLigada()); setMic(video.microfoneLigado()); }
          } catch (e) { vivo && setAvisoVideo(e.message || 'Vídeo indisponível.'); }
          finally { refs.current.abrindo = false; vivo && setConectando(false); }
        };
        await refs.current.iniciarVideo();
      } catch (e) { vivo && setErro(e.message); }
    })();
    return () => {
      vivo = false;
      refs.current.socket?.disconnect();
      refs.current.video?.sair?.();
    };
  }, [sessaoId, token]);

  // ao iniciar a estação o vídeo já tem de estar aberto: se ainda não conectou, tenta agora
  useEffect(() => {
    if (timer.status === 'rodando') refs.current.iniciarVideo?.();
  }, [timer.status]);

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
    <div className="tela sala-tela">
      {confete && <Confete aoFim={() => setConfete(false)} />}
      <div className="col">
      <div className="topo">
        <div className="quem"><div className="sub">{papelRotulo}</div>
          <h2 style={{ fontSize: '1.25rem' }}>{dados.sessao.titulo}</h2></div>
      </div>

      {avisoVideo && <div className="aviso" role="status">{avisoVideo}</div>}
      <div className="videos" aria-label="Vídeo da sala">
        {demo ? (<>
          <Tile nome="Candidato" demo alt={false} />
          <Tile nome="Você" demo alt />
        </>) : (
          Object.entries(videos).length ? Object.entries(videos).map(([uid, v], i) => (
            <Tile key={uid} nome={v.nome} track={v.track} alt={i % 2 === 1} />
          )) : <Tile nome={conectando ? 'Conectando vídeo…' : usuario.nome} />
        )}
      </div>
      {somBloqueado && <button className="btn mini menta" type="button" onClick={() => refs.current.video?.retomarSom()}>🔈 Tocar para ouvir a sala</button>}
      <div className="midia" role="group" aria-label="Câmera e microfone">
        <button className="btn mini" type="button" aria-pressed={cam} onClick={async () => {
          const alvo = !cam;
          const v = refs.current.video;
          const feito = v?.modo === 'agora' ? await v.alternarCam(alvo) : alvo;
          setCam(alvo ? Boolean(feito) : false);
        }}>{cam ? '📷 Fechar câmera' : '📷 Abrir câmera'}</button>
        {(!souObservador || podeAudio) ? (
          <button className="btn mini" type="button" aria-pressed={mic} onClick={async () => {
            const alvo = !mic;
            const v = refs.current.video;
            const feito = v?.modo === 'agora' ? await v.alternarMic(alvo) : alvo;
            setMic(alvo ? Boolean(feito) : false);
          }}>{mic ? '🎙 Microfone ligado' : '🔇 Microfone mudo'}</button>
        ) : (
          <button className="btn mini" type="button" disabled aria-disabled="true" title="O chefe da sala ainda não liberou o áudio dos observadores">🔇 Áudio liberado só pelo chefe</button>
        )}
      </div>
      {souAvaliador && dados.sessao.modo === 'dupla' && !resultado && (
        <label className="cartao chave-audio">
          <input type="checkbox" checked={audioObs} onChange={async (e) => {
            const liberado = e.target.checked;
            setAudioObs(liberado);
            try { await api(`/api/sessoes/${sessaoId}/audio-observadores`, { metodo: 'PATCH', corpo: { liberado }, token }); }
            catch (err) { setAudioObs(!liberado); setAvisoVideo(err.message); }
          }} />
          <span><b>Liberar o microfone dos observadores</b><small>{audioObs ? 'Liberado: observadores podem falar.' : 'Bloqueado (padrão): observadores só ouvem e podem abrir a câmera.'}</small></span>
        </label>
      )}

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

      </div>
      <div className="col">
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
const lerHashRedefinir = () => {
  const m = window.location.hash.match(/^#\/redefinir\/([0-9a-f]{64})$/i);
  if (m) window.history.replaceState(null, '', window.location.pathname + window.location.search); // tira o token da barra de endereço
  return m ? m[1].toLowerCase() : null;
};

export default function App() {
  const [sessaoAuth, setSessaoAuth] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rp-auth')); } catch { return null; }
  });
  const [tela, setTela] = useState('painel');
  const [sala, setSala] = useState(null); // {id, papel}
  const [tokenSenha, setTokenSenha] = useState(lerHashRedefinir);
  const [aviso, setAviso] = useState('');
  const [instalado, setInstalado] = useState(null); // null = descobrindo
  const [dispositivo, setDispositivo] = useState(() => document.documentElement.dataset.dispositivo || 'desktop');
  useEffect(() => {
    const ler = () => setDispositivo(document.documentElement.dataset.dispositivo || 'desktop'); // dispositivo.js atualiza ao redimensionar
    window.addEventListener('resize', ler); return () => window.removeEventListener('resize', ler);
  }, []);

  useEffect(() => {
    fetch('/api/instalacao/estado').then((r) => r.json()).then((d) => setInstalado(d.instalado !== false)).catch(() => setInstalado(true));
  }, []);

  const guardar = (r) => { localStorage.setItem('rp-auth', JSON.stringify(r)); setSessaoAuth(r); };
  const entrar = (r) => { guardar(r); setTela('painel'); setAviso(''); };
  const sair = (motivo = '') => { localStorage.removeItem('rp-auth'); setSessaoAuth(null); setSala(null); setTela('entrar'); setAviso(motivo); };
  const abrirSala = (id, papel) => { setSala({ id, papel }); setTela('sala'); };

  useEffect(() => {
    const aoCair = () => sair('Sua sessão terminou. Entre novamente.');
    const aoHash = () => { const t = lerHashRedefinir(); if (t) setTokenSenha(t); };
    window.addEventListener('rp-401', aoCair);
    window.addEventListener('hashchange', aoHash);
    return () => { window.removeEventListener('rp-401', aoCair); window.removeEventListener('hashchange', aoHash); };
  }, []);

  const papelApp = sessaoAuth?.usuario?.papel_app;
  const ehGestor = ['moderador', 'admin', 'root'].includes(papelApp);

  let conteudo;
  if (instalado === null) {
    conteudo = <div className="tela"><p className="sub">Carregando…</p></div>;
  } else if (instalado === false && !tokenSenha) {
    conteudo = <Instalador aoConcluir={() => { setInstalado(true); setAviso('Instalação concluída! Entre com a conta de administrador.'); }} />;
  } else if (tokenSenha) {
    conteudo = <TelaRedefinir token={tokenSenha}
      aoConcluir={(m) => { setTokenSenha(null); sair(m); }}
      aoCancelar={() => setTokenSenha(null)} />;
  } else if (!sessaoAuth) {
    conteudo = <TelaEntrar aoEntrar={entrar} aviso={aviso} />;
  } else if (tela === 'sala' && sala) {
    conteudo = <TelaSala key={sala.id} sessaoId={sala.id} token={sessaoAuth.token} usuario={sessaoAuth.usuario} aoSair={() => setTela('painel')} />;
  } else if (tela === 'conta') {
    conteudo = <TelaConta sessaoAuth={sessaoAuth} token={sessaoAuth.token} aoAtualizar={guardar} aoSair={() => sair()} />;
  } else if (tela === 'admin' && ehGestor) {
    conteudo = <TelaAdmin token={sessaoAuth.token} usuario={sessaoAuth.usuario} />;
  } else {
    conteudo = <TelaPainel usuario={sessaoAuth.usuario} token={sessaoAuth.token} aoAbrirSala={abrirSala} />;
  }

  return (
    <div className="app">
      <div className="blobs" aria-hidden="true"><i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><i className="blob b4" /></div>
      {instalado && sessaoAuth && !tokenSenha && sessaoAuth.senhaProvisoria && tela !== 'conta' && (
        <button type="button" className="faixa" onClick={() => setTela('conta')}>⚠ Sua senha é provisória. Toque para trocar.</button>
      )}
      {podeTrocarVersao(dispositivo) && <RelogioDeBolso />}
      {conteudo}
      {instalado && sessaoAuth && !tokenSenha && (
        <nav className="nav" aria-label="Navegação">
          <button type="button" aria-current={tela === 'painel' ? 'page' : undefined} onClick={() => setTela('painel')}><span aria-hidden="true">🏠</span>Início</button>
          <button type="button" aria-current={tela === 'sala' ? 'page' : undefined} disabled={!sala}
            onClick={() => sala && setTela('sala')} style={!sala ? { opacity: .4 } : undefined}><span aria-hidden="true">🎥</span>Sala</button>
          {ehGestor && <button type="button" aria-current={tela === 'admin' ? 'page' : undefined} onClick={() => setTela('admin')}><span aria-hidden="true">🛡</span>Admin</button>}
          <button type="button" aria-current={tela === 'conta' ? 'page' : undefined} onClick={() => setTela('conta')}><span aria-hidden="true">👤</span>Conta</button>
          <button type="button" onClick={() => sair()}><span aria-hidden="true">🚪</span>Sair</button>
        </nav>
      )}
    </div>
  );
}
