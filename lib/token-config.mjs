import { readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

export function replaceEnvToken(content, token) {
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error('Le jeton semble invalide. Collez uniquement sa valeur, sans guillemets.');
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const next = lines.filter(line => {
    if (!/^\s*(?:export\s+)?GITHUB_TOKEN\s*=/.test(line)) return true;
    if (replaced) return false;
    replaced = true; return true;
  }).map(line => /^\s*(?:export\s+)?GITHUB_TOKEN\s*=/.test(line) ? `GITHUB_TOKEN=${token}` : line);
  if (!replaced) { if (next.at(-1) === '') next.pop(); next.push(`GITHUB_TOKEN=${token}`); }
  return next.join('\n').replace(/\n*$/, '\n');
}

export async function configureToken(token, { envPath, fetchImpl = fetch } = {}) {
  // Vérifier le jeton sans le journaliser et sans demander d’accès en écriture.
  replaceEnvToken('', token);
  let response;
  try { response = await fetchImpl('https://api.github.com/rate_limit', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'RepoAtlas/0.3' }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
  catch { throw new Error('GitHub est injoignable. Aucun fichier n’a été modifié.'); }
  if (!response.ok) throw new Error(response.status === 401 ? 'GitHub refuse ce jeton. Vérifiez sa valeur et sa date d’expiration.' : 'GitHub n’a pas pu vérifier ce jeton. Aucun fichier n’a été modifié.');
  let data;
  try { data = await response.json(); } catch { throw new Error('Réponse de GitHub inattendue. Aucun fichier n’a été modifié.'); }
  if (!Number.isFinite(data.resources?.core?.limit)) throw new Error('Réponse de GitHub inattendue. Aucun fichier n’a été modifié.');
  let original = '';
  try { const info = await lstat(envPath); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Le fichier .env doit être un fichier local ordinaire.'); original = await readFile(envPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(replaceEnvToken(original, token), 'utf8'); } finally { await file.close(); }
    await rename(temporary, envPath);
  } finally { await unlink(temporary).catch(() => {}); }
  return { core: data.resources.core, search: data.resources.search || null };
}

// Relire uniquement côté serveur ; le jeton ne fait jamais partie de /api/status.
export async function readLocalToken(envPath, fallback = '') {
  try { return parseEnv(await readFile(envPath, 'utf8')).GITHUB_TOKEN ?? fallback; }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Impossible de lire la configuration GitHub locale.'); }
}
