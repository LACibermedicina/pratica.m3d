import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { destinoInicial, ligar, lerModo } from './dispositivo.js';

// Identifica o aparelho (celular/desktop/relógio), mede o quadro do app e, num relógio, abre direto a versão mini.
const dispositivo = ligar();
const destino = destinoInicial(dispositivo, lerModo(window.localStorage));

// Erro de renderização nunca pode virar tela em branco: mostra aviso com botão.
class Protecao extends React.Component {
  state = { quebrou: false };
  static getDerivedStateFromError() { return { quebrou: true }; }
  componentDidCatch(e) { console.error('erro de renderização', e); window.__boot?.erro?.('Algo falhou ao desenhar a tela.'); }
  render() {
    if (!this.state.quebrou) return this.props.children;
    return (
      <div className="app"><div className="tela" role="alert">
        <h2>Ops, algo falhou</h2>
        <p className="sub">Não foi possível desenhar esta tela. Recarregue a página; se continuar, avise o administrador.</p>
        <button className="btn" type="button" onClick={() => window.location.reload()}>Recarregar</button>
      </div></div>
    );
  }
}

if (destino && !window.location.pathname.startsWith(destino)) window.location.replace(destino);
else {
  window.__boot?.etapa('js');
  createRoot(document.getElementById('root')).render(<Protecao><App /></Protecao>);
}
