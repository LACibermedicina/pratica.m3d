import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

// em desenvolvimento, serve ../watch em /watch/ (em produção o nginx faz isso)
const servirRelogio = () => ({
  name: 'servir-relogio',
  configureServer(s) {
    s.middlewares.use('/watch', (req, res, next) => {
      const rel = (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]).replace(/\.\.+/g, '');
      const arq = join(process.cwd(), '../watch', rel);
      if (!existsSync(arq)) return next();
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(arq)] || 'text/plain');
      res.end(readFileSync(arq));
    });
  },
});

export default defineConfig({
  plugins: [react(), servirRelogio()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001', '/socket.io': { target: 'http://localhost:3001', ws: true } },
  },
});
