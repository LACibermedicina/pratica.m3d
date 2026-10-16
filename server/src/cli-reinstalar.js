// Reabre o instalador direto pelo servidor (para quem perdeu a conta root): `npm run reinstalar`
// Não apaga dados. Para apagar dados use o painel (root) ou `npm run reinstalar -- --limpar`.
import 'dotenv/config';
import pool, { q } from './db.js';
import { limparBanco, reabrirInstalador } from './instalacao.js';

const limpar = process.argv.includes('--limpar');
if (limpar && !process.argv.includes('--sim')) { console.error('Isto APAGA usuários, salas e avaliações. Repita com --limpar --sim para confirmar.'); process.exit(1); }
if (limpar) await limparBanco(q); else await reabrirInstalador(q);
console.log(limpar ? 'Banco limpo e instalador reaberto.' : 'Instalador reaberto. Reinicie a API para imprimir o código de instalação no log.');
await pool.end();
