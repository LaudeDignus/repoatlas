import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readLocalToken } from './lib/token-config.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GitHubClient, scanRepository, ScanError } from './lib/scan.mjs';
import { discoverProjects, discoverPeople } from './lib/discover.mjs';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ...['app.js', 'discover.js', 'feedback.js', 'ui-state.js', 'locations.js'].map(file => ['/' + file, [file, 'text/javascript; charset=utf-8']]), ...['style.css', 'discover.css'].map(file => ['/' + file, [file, 'text/css; charset=utf-8']])]);

export function createApp({ token = process.env.GITHUB_TOKEN || '', tokenProvider, fetchImpl = fetch } = {}) {
  let cache = new Map(), rateStates = new Map(), accessId = randomUUID();
  async function refreshCredentials() {
    if (!tokenProvider) return;
    const next = await tokenProvider();
    if (typeof next !== 'string') throw new Error('Configuration GitHub invalide.');
    if (next !== token) { token = next; cache = new Map(); rateStates = new Map(); accessId = randomUUID(); }
  }
  let busy = false;
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    // Application locale : empêcher un site tiers d’utiliser le jeton du serveur.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: 'Utilisez cette application via localhost ou 127.0.0.1.' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return json(res, 403, { error: 'Origine refusée.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Requête externe refusée.' });
    const url = new URL(req.url, `http://${host}`);
    const action = new Map([['/api/scan', scanRepository], ['/api/discover/projects', discoverProjects], ['/api/discover/people', discoverPeople]]).get(url.pathname);
    if (req.method === 'POST' && action) {
      if (busy) return json(res, 409, { error: 'Une analyse est déjà en cours. Attendez sa fin ou annulez-la.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Format JSON attendu.' });
      busy = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 2048) throw new ScanError('Requête trop longue.', 413);
        }
        let input;
        try { input = JSON.parse(body); } catch { throw new ScanError('Requête JSON invalide.', 400); }
        await refreshCredentials();
        const client = new GitHubClient({ token, fetchImpl, cache, rateStates, signal: controller.signal });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        const send = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
        const result = await action(url.pathname === '/api/scan' ? input?.url : input, { client, onProgress: progress => send({ type: 'progress', ...progress }) });
        send({ type: 'result', data: result });
        res.end();
      } catch (error) {
        const message = controller.signal.aborted ? 'Analyse interrompue ou délai maximal atteint. Vous pouvez réessayer.' : error instanceof ScanError ? error.message : 'L’analyse a échoué. Réessayez.';
        if (!res.destroyed) {
          if (res.headersSent) { res.end(JSON.stringify({ type: 'error', message, status: error.status || 500, rate: error.rate || null }) + '\n'); }
          else json(res, error.status || 500, { error: message, status: error.status || 500, rate: error.rate || null });
        }
      } finally { clearTimeout(timer); busy = false; }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      try { await refreshCredentials(); return json(res, 200, { authenticated: Boolean(token), accessId }); }
      catch { return json(res, 500, { error: 'Configuration GitHub locale illisible.' }); }
    }
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      try { const data = await readFile(resolve(ROOT, file)); res.writeHead(200, { 'Content-Type': type }); res.end(data); }
      catch { json(res, 500, { error: 'Fichier de l’application manquant.' }); }
      return;
    }
    json(res, 404, { error: 'Page introuvable.' });
  });
}

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4328);
  const envPath = fileURLToPath(new URL('./.env', import.meta.url));
  const fileTokenAtStartup = await readLocalToken(envPath);
  const inheritedToken = process.env.GITHUB_TOKEN || '';
  const fallbackToken = inheritedToken === fileTokenAtStartup ? '' : inheritedToken;
  const server = createApp({ tokenProvider: () => readLocalToken(envPath, fallbackToken) });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Le port ${port} est occupé. Choisissez-en un autre avec PORT=4329 npm start.` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`RepoAtlas → http://127.0.0.1:${port}`));
}
