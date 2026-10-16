import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { destinoInicial, ligar, lerModo } from './dispositivo.js';

// Identifica o aparelho (celular/desktop/relógio) e, num relógio, abre direto a versão mini.
const dispositivo = ligar();
const destino = destinoInicial(dispositivo, lerModo(window.localStorage));
if (destino && !window.location.pathname.startsWith(destino)) window.location.replace(destino);
else createRoot(document.getElementById('root')).render(<App />);
