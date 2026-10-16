import React, { useEffect, useState } from 'react';

// Instalador do primeiro acesso. O código de instalação fica só em memória (nunca em localStorage/URL).
const ETAPAS = ['Código', 'Verificação', 'Parâmetros', 'Administradores', 'Concluir'];
const ICONE = { ok: '✅', aviso: '⚠️', erro: '⛔' };

export default function Instalador({ aoConcluir }) {
  const [etapa, setEtapa] = useState(0);
  const [codigo, setCodigo] = useState('');
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [itens, setItens] = useState([]);
  const [local, setLocal] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [conf, setConf] = useState({});
  const [f, setF] = useState({ APP_URL: '', NOME_INSTITUICAO: '', EMAIL_DE: '', SMTP_URL: '', AGORA_APP_ID: '', AGORA_APP_CERTIFICATE: '', PHP_TOKEN_URL: '' });
  const [root, setRoot] = useState({ email: 'root@m3d.pro', senha: '' });
  const [novo, setNovo] = useState({ nome: '', email: '', senha: '', papel: 'admin' });
  const [emailTeste, setEmailTeste] = useState('');
  const [concluido, setConcluido] = useState(null);

  const chamar = async (rota, corpo = {}) => {
    const r = await fetch(`/api/instalacao/${rota}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codigo-instalacao': codigo },
      body: JSON.stringify(corpo),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.erro || 'Algo deu errado.'), { dados: d, status: r.status });
    return d;
  };
  const rodar = async (fn) => {
    setOcupado(true); setErro(''); setMsg('');
    try { return await fn(); } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };

  async function verificarLocal() {
    const l = [];
    l.push(window.isSecureContext
      ? { id: 'https', status: 'ok', titulo: 'Conexão segura (HTTPS)', detalhe: 'Câmera e microfone podem ser usados neste endereço.' }
      : { id: 'https', status: 'erro', titulo: 'Conexão segura (HTTPS)', detalhe: 'O navegador só libera câmera e microfone em HTTPS (ou localhost). Configure o certificado no servidor web.' });
    l.push(navigator.mediaDevices?.getUserMedia
      ? { id: 'midia', status: 'ok', titulo: 'Câmera/microfone no navegador', detalhe: 'Recurso disponível.' }
      : { id: 'midia', status: 'aviso', titulo: 'Câmera/microfone no navegador', detalhe: 'Este navegador não expõe getUserMedia.' });
    try {
      const r = await fetch('/socket.io/?EIO=4&transport=polling');
      l.push(r.ok ? { id: 'rt', status: 'ok', titulo: 'Tempo real (Socket.IO)', detalhe: 'O proxy repassa /socket.io até a API.' }
        : { id: 'rt', status: 'erro', titulo: 'Tempo real (Socket.IO)', detalhe: `Resposta ${r.status}. Repasse /socket.io (com WebSocket) no proxy.` });
    } catch { l.push({ id: 'rt', status: 'erro', titulo: 'Tempo real (Socket.IO)', detalhe: 'Sem resposta em /socket.io.' }); }
    setLocal(l);
    return l;
  }

  const verificar = () => rodar(async () => {
    const d = await chamar('verificar');
    setItens(d.itens); await verificarLocal();
  });

  const entrarCodigo = () => rodar(async () => {
    const d = await chamar('verificar');
    setItens(d.itens); await verificarLocal();
    const c = await chamar('config-ler');
    setConf(c.config);
    setF((x) => ({ ...x, APP_URL: c.config.APP_URL?.valor || window.location.origin, NOME_INSTITUICAO: c.config.NOME_INSTITUICAO?.valor || '', EMAIL_DE: c.config.EMAIL_DE?.valor || '', PHP_TOKEN_URL: c.config.PHP_TOKEN_URL?.valor || '', AGORA_APP_ID: c.config.AGORA_APP_ID?.valor || '' }));
    setEtapa(1);
  });

  const salvarConfig = () => rodar(async () => {
    const d = await chamar('config', f);
    setConf(d.config); setF((x) => ({ ...x, SMTP_URL: '', AGORA_APP_CERTIFICATE: '' })); // segredos saem da tela depois de salvos
    setMsg('Parâmetros salvos.');
    const v = await chamar('verificar'); setItens(v.itens);
  });

  const testarEmail = () => rodar(async () => {
    const d = await chamar('email-teste', { para: emailTeste });
    setMsg(d.entregue ? 'E-mail de teste entregue ao servidor SMTP.' : 'Não foi entregue (SMTP ausente ou com erro). Veja a verificação.');
  });

  const listarAdmins = () => chamar('admins-lista').then((d) => setAdmins(d.usuarios));
  useEffect(() => { if (etapa === 3 || etapa === 4) rodar(listarAdmins); }, [etapa]); // eslint-disable-line

  const definirRoot = () => rodar(async () => {
    await chamar('root', root);
    setRoot((r) => ({ ...r, senha: '' })); setMsg('Senha da conta raiz definida.'); await listarAdmins();
  });
  const criarAdmin = () => rodar(async () => {
    await chamar('admins', novo);
    setNovo({ nome: '', email: '', senha: '', papel: novo.papel }); setMsg('Usuário criado.'); await listarAdmins();
  });
  const concluir = () => rodar(async () => {
    try { const d = await chamar('concluir'); setConcluido(d); }
    catch (e) { if (e.dados?.bloqueios) { const v = await chamar('verificar'); setItens(v.itens); } throw e; }
  });

  const campo = (k, rot, extra = {}) => (
    <label className="campo" key={k}>{rot}
      <input value={f[k]} disabled={conf[k]?.origem === 'ambiente'} onChange={(e) => setF({ ...f, [k]: e.target.value })}
        placeholder={conf[k]?.origem === 'ambiente' ? 'definido no ambiente do servidor' : extra.dica} type={extra.tipo || 'text'} autoComplete="off" />
      {extra.segredo && conf[k]?.definido && <small className="sub">Já definido (oculto). Deixe vazio para manter.</small>}
    </label>
  );

  const bloqueios = [...itens, ...local].filter((i) => i.status === 'erro');
  const temAdmin = admins.some((a) => (a.papel === 'admin' || a.papel === 'root') && !a.provisoria);

  if (concluido) {
    return (
      <div className="tela estreita" data-passo="instalado">
        <h1>Tudo pronto 🎉</h1>
        <p className="sub">A instalação foi concluída e o instalador foi trancado. Entre com uma das contas de administrador criadas.</p>
        {concluido.avisos?.length > 0 && <div className="aviso">Itens opcionais ainda sem configuração: {concluido.avisos.join(', ')}. Você pode ajustá-los pelo ambiente do servidor.</div>}
        <button className="btn" type="button" onClick={aoConcluir}>Ir para o login</button>
      </div>
    );
  }

  return (
    <div className="tela estreita instalador" data-passo={`etapa-${etapa}`}>
      <h1>Instalação do servidor</h1>
      <ol className="passos" aria-label="Etapas">
        {ETAPAS.map((e, i) => <li key={e} aria-current={i === etapa ? 'step' : undefined} className={i < etapa ? 'feito' : ''}>{e}</li>)}
      </ol>
      {erro && <div className="msg e" role="alert">{erro}</div>}
      {msg && <div className="msg" role="status">{msg}</div>}

      {etapa === 0 && (
        <div className="cartao">
          <div className="sec">Código de instalação</div>
          <p className="sub">Este servidor ainda não foi configurado. Para provar que você é quem administra a máquina, informe o código impresso no console (log) do servidor ao iniciar — procure por “Código de instalação”.</p>
          <label className="campo">Código
            <input value={codigo} onChange={(e) => setCodigo(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" autoComplete="off" />
          </label>
          <button className="btn" type="button" disabled={ocupado || codigo.trim().length < 6} onClick={entrarCodigo}>Começar</button>
        </div>
      )}

      {etapa === 1 && (
        <div className="cartao">
          <div className="sec">Verificação do servidor</div>
          <p className="sub">Confere os serviços que dependem da configuração desta máquina.</p>
          <ul className="verif">
            {[...itens, ...local].map((i) => (
              <li key={i.id} className={i.status}><span aria-hidden="true">{ICONE[i.status]}</span>
                <div><b>{i.titulo}</b><small>{i.detalhe}</small></div></li>
            ))}
          </ul>
          <div className="acoes">
            <button className="btn mini" type="button" disabled={ocupado} onClick={verificar}>Verificar de novo</button>
            <button className="btn mini menta" type="button" onClick={() => setEtapa(2)}>Continuar</button>
          </div>
          {bloqueios.length > 0 && <p className="sub">Há itens com erro. Dá para seguir, mas a instalação só conclui quando os erros do servidor forem corrigidos.</p>}
        </div>
      )}

      {etapa === 2 && (
        <div className="cartao">
          <div className="sec">Parâmetros do servidor</div>
          <p className="sub">Tudo opcional, exceto o que a sua instalação exigir. Valores definidos no ambiente do servidor têm prioridade e aparecem bloqueados.</p>
          {campo('APP_URL', 'Endereço público do site', { dica: 'https://revalida.seudominio.com' })}
          {campo('NOME_INSTITUICAO', 'Nome da instituição')}
          {campo('EMAIL_DE', 'Remetente dos e-mails', { dica: 'Revalida Prático <nao-responda@seudominio.com>' })}
          {campo('SMTP_URL', 'Servidor de e-mail (SMTP)', { dica: 'smtps://usuario:senha@smtp.exemplo.com', segredo: true, tipo: 'password' })}
          {campo('AGORA_APP_ID', 'Agora — App ID (32 caracteres)')}
          {campo('AGORA_APP_CERTIFICATE', 'Agora — Certificado', { segredo: true, tipo: 'password' })}
          {campo('PHP_TOKEN_URL', 'Endereço reserva de token (opcional)')}
          <div className="acoes">
            <button className="btn mini" type="button" disabled={ocupado} onClick={salvarConfig}>Salvar parâmetros</button>
          </div>
          <label className="campo">Enviar e-mail de teste para
            <input value={emailTeste} onChange={(e) => setEmailTeste(e.target.value)} placeholder="voce@exemplo.com" type="email" />
          </label>
          <div className="acoes">
            <button className="btn mini" type="button" disabled={ocupado || !emailTeste} onClick={testarEmail}>Enviar teste</button>
            <button className="btn mini" type="button" onClick={() => setEtapa(1)}>Ver verificação</button>
            <button className="btn mini menta" type="button" onClick={() => setEtapa(3)}>Continuar</button>
          </div>
          {itens.length > 0 && <ul className="verif">{itens.filter((i) => ['email', 'video', 'url'].includes(i.id)).map((i) => (
            <li key={i.id} className={i.status}><span aria-hidden="true">{ICONE[i.status]}</span><div><b>{i.titulo}</b><small>{i.detalhe}</small></div></li>))}</ul>}
        </div>
      )}

      {etapa === 3 && (
        <div className="cartao">
          <div className="sec">Administradores</div>
          <p className="sub">Defina a senha da conta raiz (a senha de exemplo do ambiente é provisória) e/ou crie administradores com senha própria.</p>
          <div className="sec" style={{ fontSize: '.95rem' }}>Conta raiz</div>
          {!admins.some((a) => a.papel === 'root') && (
            <label className="campo">E-mail da conta raiz
              <input value={root.email} onChange={(e) => setRoot({ ...root, email: e.target.value })} type="email" autoComplete="off" />
            </label>
          )}
          <label className="campo">Nova senha da conta raiz
            <input value={root.senha} onChange={(e) => setRoot({ ...root, senha: e.target.value })} type="password" autoComplete="new-password" placeholder="10+ caracteres, com letra e número" />
          </label>
          <button className="btn mini" type="button" disabled={ocupado || root.senha.length < 10} onClick={definirRoot}>Definir senha raiz</button>
          <div className="sec" style={{ fontSize: '.95rem', marginTop: 8 }}>Novo usuário administrativo</div>
          <label className="campo">Nome<input value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} autoComplete="off" /></label>
          <label className="campo">E-mail<input value={novo.email} onChange={(e) => setNovo({ ...novo, email: e.target.value })} type="email" autoComplete="off" /></label>
          <label className="campo">Senha<input value={novo.senha} onChange={(e) => setNovo({ ...novo, senha: e.target.value })} type="password" autoComplete="new-password" /></label>
          <label className="campo">Papel
            <select value={novo.papel} onChange={(e) => setNovo({ ...novo, papel: e.target.value })}>
              <option value="admin">Administrador</option><option value="moderador">Moderador (só revisa estações)</option>
            </select></label>
          <button className="btn mini" type="button" disabled={ocupado || !novo.nome || !novo.email || novo.senha.length < 10} onClick={criarAdmin}>Criar usuário</button>
          <ul className="verif">{admins.map((a) => (
            <li key={a.email} className={a.provisoria ? 'aviso' : 'ok'}><span aria-hidden="true">{a.provisoria ? '⚠️' : '✅'}</span>
              <div><b>{a.nome} · {a.papel}</b><small>{a.email}{a.provisoria ? ' — senha provisória' : ''}</small></div></li>))}</ul>
          <div className="acoes">
            <button className="btn mini" type="button" onClick={() => setEtapa(2)}>Voltar</button>
            <button className="btn mini menta" type="button" onClick={() => setEtapa(4)}>Continuar</button>
          </div>
        </div>
      )}

      {etapa === 4 && (
        <div className="cartao">
          <div className="sec">Revisar e concluir</div>
          <ul className="verif">
            {[...itens, ...local].map((i) => (
              <li key={i.id} className={i.status}><span aria-hidden="true">{ICONE[i.status]}</span><div><b>{i.titulo}</b><small>{i.detalhe}</small></div></li>))}
            <li className={temAdmin ? 'ok' : 'erro'}><span aria-hidden="true">{temAdmin ? '✅' : '⛔'}</span>
              <div><b>Administrador com senha própria</b><small>{temAdmin ? 'Existe ao menos um.' : 'Volte e defina a senha raiz ou crie um administrador.'}</small></div></li>
          </ul>
          <p className="sub">Ao concluir, o instalador é trancado e não pode ser reaberto.</p>
          <div className="acoes">
            <button className="btn mini" type="button" disabled={ocupado} onClick={() => rodar(async () => { const v = await chamar('verificar'); setItens(v.itens); await verificarLocal(); await listarAdmins(); })}>Verificar de novo</button>
            <button className="btn mini" type="button" onClick={() => setEtapa(3)}>Voltar</button>
            <button className="btn coral" type="button" disabled={ocupado} onClick={concluir}>Concluir instalação</button>
          </div>
        </div>
      )}
    </div>
  );
}
