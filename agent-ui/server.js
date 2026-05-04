import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4001;
const GEM_ORIGIN = process.env.GEM_ORIGIN || 'http://localhost:4000';

// Serve UI static files
app.use(express.static(path.join(__dirname, 'public')));

// Proxy all /api/* and /auth/* to GEM CO on port 4000
app.use(['/api', '/auth'], createProxyMiddleware({
  target: GEM_ORIGIN,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      res.status(502).json({ error: 'GEM CO unreachable', detail: err.message });
    }
  }
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Agent Harness UI running at http://localhost:${PORT}`);
  console.log(`Proxying API calls to GEM CO at ${GEM_ORIGIN}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT env var to use a different port.`);
    process.exit(1);
  }
  throw err;
});
