export const LIMITS = Object.freeze({ branches: 16, pullBranches: 10, recentForks: 20, starredForks: 10, pullRequests: 30, commits: 30 });

export class ScanError extends Error {
  constructor(message, status = 502, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function parseRepository(value) {
  if (typeof value !== 'string' || value.length > 300) throw new ScanError('Collez une URL de dépôt comme https://github.com/tomnomnom/gron.', 400);
  let url;
  try { url = new URL(value.trim()); } catch { throw new ScanError('L’URL doit commencer par https://github.com/.', 400); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new ScanError('Utilisez une URL https://github.com/propriétaire/dépôt, sans paramètres ni identifiants.', 400);
  }
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (parts.length !== 2 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) {
    throw new ScanError('Collez l’URL du dépôt, sans /tree/, /issues/ ou autre sous-page.', 400);
  }
  parts[1] = parts[1].replace(/\.git$/, '');
  if (!parts[1] || parts[1] === '.' || parts[1] === '..') throw new ScanError('Le nom du dépôt est invalide.', 400);
  return parts.join('/');
}

export class GitHubClient {
  constructor({ token = '', fetchImpl = fetch, cache = new Map(), rateStates = new Map(), signal } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.rateStates = rateStates;
    this.signal = signal;
    this.requests = 0;
    this.rate = null;
  }

  async get(path) {
    const allowed = /^\/repos\/[\w.-]+\/[\w.-]+(?:[/?]|$)/.test(path) || /^\/search\/(repositories|users|commits)\?/.test(path) || /^\/users\/[a-zA-Z0-9-]+$/.test(path);
    if (!allowed || path.includes('://')) throw new ScanError('Chemin GitHub non autorisé.', 400);
    this.signal?.throwIfAborted();
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < 600_000) return structuredClone(cached.data);
    if (this.requests >= 42) throw new ScanError('Budget de requêtes atteint. Les résultats disponibles sont conservés.', 429);
    const resource = path.startsWith('/search/') ? 'search' : 'core';
    const knownRate = this.rateStates.get(resource);
    if (knownRate?.remaining === 0 && knownRate.reset > Date.now()) {
      this.rate = knownRate;
      throw new ScanError('Quota GitHub épuisé. Réessayez après sa réinitialisation ou configurez GITHUB_TOKEN.', 429, { rate: knownRate, stop: true });
    }
    this.requests++;
    let response;
    try {
      response = await this.fetchImpl('https://api.github.com' + path, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'RepoAtlas/0.3',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(this.signal ? [this.signal] : [])]),
        redirect: 'error',
      });
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw new ScanError('GitHub est injoignable ou met trop de temps à répondre. Réessayez.', 502);
    }
    if (response.headers.has('x-ratelimit-remaining')) {
      this.rate = { remaining: Number(response.headers.get('x-ratelimit-remaining')), reset: Number(response.headers.get('x-ratelimit-reset')) * 1000, resource: response.headers.get('x-ratelimit-resource') || resource };
      this.rateStates.set(this.rate.resource, this.rate);
    }
    if (!response.ok) {
      if (response.status === 404) throw new ScanError('Dépôt ou branche introuvable. Cette version accepte uniquement les dépôts publics.', 404);
      if (response.status === 401) throw new ScanError('Le jeton GitHub du serveur est invalide. Corrigez GITHUB_TOKEN puis redémarrez.', 401);
      if (response.status === 422) throw new ScanError('GitHub ne peut pas traiter ces filtres. Précisez la recherche ou choisissez un autre filtre.', 422);
      if (response.status === 403 || response.status === 429) throw new ScanError('GitHub limite les requêtes ou refuse cet accès. Réessayez plus tard ; un jeton personnel augmente généralement le quota.', response.status, { rate: this.rate, stop: true });
      throw new ScanError(`GitHub n’a pas pu effectuer cette comparaison (HTTP ${response.status}).`, response.status);
    }
    const data = await response.json();
    // Les erreurs et les dépôts privés ne sont jamais mis en cache.
    if (!data.private && !data.head?.repo?.private && !data.items?.some(item => item.private || item.repository?.private)) {
      if (this.cache.size >= 150) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(path, { at: Date.now(), data: structuredClone(data) });
    }
    return data;
  }
}

function normalizeFork(repo) {
  if (!repo || repo.private || !repo.full_name || !repo.owner?.login || !repo.default_branch) return null;
  return {
    fullName: repo.full_name, owner: repo.owner.login, branch: repo.default_branch,
    stars: repo.stargazers_count || 0, pushedAt: repo.pushed_at, archived: Boolean(repo.archived),
  };
}

export function selectBranches(fullName, recent, starred, pulls) {
  const selected = new Map();
  const pool = new Map();
  for (const repo of [...recent, ...starred]) {
    const fork = normalizeFork(repo);
    if (fork && fork.fullName.toLowerCase() !== fullName.toLowerCase()) pool.set(fork.fullName, fork);
  }
  const groups = new Map();
  for (const pr of pulls) {
    if (pr.user?.type === 'Bot') continue;
    const fork = normalizeFork(pr.head?.repo);
    if (!fork || fork.fullName.toLowerCase() === fullName.toLowerCase() || !pr.head.ref || !pr.head.sha) continue;
    pool.set(fork.fullName, fork);
    const key = `${fork.fullName}:${pr.head.ref}`;
    let group = groups.get(fork.fullName);
    if (!group) { group = []; groups.set(fork.fullName, group); }
    const existing = group.find(item => item.key === key);
    const proof = { number: pr.number, title: pr.title, body: (pr.body || '').slice(0, 1500), url: `https://github.com/${fullName}/pull/${pr.number}` };
    if (existing) existing.pulls.push(proof);
    else group.push({ ...fork, branch: pr.head.ref, headSha: pr.head.sha, key, origin: 'pull-request', pulls: [proof] });
  }
  // Un premier ajout par auteur avant une deuxième branche du même fork.
  const queues = [...groups.values()].map(group => [...group]);
  while (selected.size < LIMITS.pullBranches && queues.some(group => group.length)) {
    for (const group of queues) {
      const item = group.shift();
      if (item) selected.set(item.key, item);
      if (selected.size >= LIMITS.pullBranches) break;
    }
  }
  const ranked = [...pool.values()].sort((a, b) => (Date.parse(b.pushedAt) || 0) - (Date.parse(a.pushedAt) || 0) || b.stars - a.stars);
  for (const fork of ranked) {
    const key = `${fork.fullName}:${fork.branch}`;
    if (!selected.has(key)) selected.set(key, { ...fork, key, origin: 'default-branch', pulls: [] });
    if (selected.size >= LIMITS.branches) break;
  }
  return { candidates: [...selected.values()], discoveredForks: pool.size, pullBranches: [...groups.values()].flat().length };
}

function classify(text) {
  if (/^(docs?|readme)(\b|\()/i.test(text)) return 'Documentation';
  if (/\b(fix|fixes|fixed|bug|accept|repair|correct|handle|support)\b/i.test(text)) return 'Correctif / compatibilité';
  if (/\b(add|adds|added|feat|feature|implement|enable|introduce)\b/i.test(text)) return 'Fonctionnalité';
  if (/\b(perf|performance|faster|speed|buffer|memory|optim)/i.test(text)) return 'Performance';
  if (/\b(docs?|readme|documentation)\b/i.test(text)) return 'Documentation';
  if (/\b(bump|deps|dependency|dependencies|ci|workflow|release)\b/i.test(text)) return 'Maintenance';
  return 'Changement à examiner';
}

export function summarizeComparison(candidate, comparison, fullName, baseSha) {
  const commits = (comparison.commits || []).map(item => ({
    sha: item.sha, title: (item.commit?.message || '').split('\n')[0],
    url: `https://github.com/${candidate.fullName}/commit/${item.sha}`,
  }));
  const ahead = comparison.ahead_by || 0;
  const headSha = candidate.headSha || (ahead > 0 ? commits.at(-1)?.sha : null);
  // Avec pagination, le dernier commit reçu n’est pas forcément le head.
  const pinnedHead = candidate.headSha || (comparison.total_commits <= commits.length ? headSha : null);
  const compareHead = `${candidate.owner}:${candidate.fullName.split('/')[1]}:${pinnedHead || candidate.branch}`;
  const compareUrl = `https://github.com/${fullName}/compare/${baseSha}...${encodeURIComponent(compareHead)}`;
  const files = (comparison.files || []).map(file => ({
    path: file.filename, status: file.status, additions: file.additions || 0, deletions: file.deletions || 0,
    codeUrl: `https://github.com/${candidate.fullName}/blob/${encodeURIComponent(pinnedHead || candidate.branch)}/${file.filename.split('/').map(encodeURIComponent).join('/')}`,
  }));
  const signals = [
    ...candidate.pulls.map(pr => ({ title: pr.title, description: pr.body, kind: classify(pr.title), source: `PR #${pr.number}`, url: pr.url })),
    ...commits.filter(commit => !/^merge\b/i.test(commit.title)).map(commit => ({ title: commit.title, kind: classify(commit.title), source: 'Commit', url: commit.url })),
  ];
  const seen = new Set();
  const unique = signals.filter(item => { const key = item.title.toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  const ranked = unique.sort((a, b) => Number(['Maintenance', 'Documentation'].includes(a.kind)) - Number(['Maintenance', 'Documentation'].includes(b.kind)));
  return {
    ...candidate, headSha: pinnedHead, ahead, behind: comparison.behind_by || 0,
    status: comparison.status, compareUrl, repoUrl: `https://github.com/${candidate.fullName}`,
    files, filesTruncated: files.length >= 300,
    commits, commitsTruncated: (comparison.total_commits || 0) > commits.length,
    signals: ranked.slice(0, 8), totalSignals: unique.length,
  };
}

export async function scanRepository(value, { client, onProgress = () => {} } = {}) {
  const requested = parseRepository(value);
  const warnings = [];
  onProgress({ phase: 'repository', message: 'Lecture du dépôt d’origine…' });
  const repo = await client.get(`/repos/${requested}`);
  if (repo.private) throw new ScanError('Cette version analyse uniquement les dépôts publics.', 400);
  const fullName = repo.full_name;
  const branch = repo.default_branch;
  if (!fullName || !branch || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new ScanError('Réponse du dépôt GitHub incomplète.');
  // Une référence immuable commune évite que l’origine change pendant le scan.
  const base = await client.get(`/repos/${fullName}/commits/${encodeURIComponent(branch)}`);
  const baseSha = base.sha;
  if (!/^[a-f0-9]{40,64}$/i.test(baseSha || '')) throw new ScanError('Impossible de fixer la version de référence.');
  onProgress({ phase: 'discovery', message: 'Recherche des forks et des branches de pull requests…' });
  let recent = [], starred = [], pulls = [];
  for (const [kind, path] of [
    ['recent', `/repos/${fullName}/forks?sort=newest&per_page=${LIMITS.recentForks}`],
    ['starred', `/repos/${fullName}/forks?sort=stargazers&per_page=${LIMITS.starredForks}`],
    ['pulls', `/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=${LIMITS.pullRequests}`],
  ]) {
    try {
      const data = await client.get(path);
      if (!Array.isArray(data)) throw new ScanError('Réponse GitHub inattendue.');
      if (kind === 'recent') recent = data;
      if (kind === 'starred') starred = data;
      if (kind === 'pulls') pulls = data;
    } catch (error) {
      if (client.signal?.aborted) throw error;
      warnings.push({ status: error.status, rate: error.rate || null, message: `${kind === 'pulls' ? 'Branches des PR' : 'Sélection de forks'} : ${error.message}` });
      if (error.stop || error.status === 429 || error.status === 401) break;
    }
  }
  const selection = selectBranches(fullName, recent, starred, pulls);
  const results = [];
  let checked = 0;
  for (const candidate of selection.candidates) {
    onProgress({ phase: 'compare', message: `Comparaison ${checked + 1}/${selection.candidates.length} · ${candidate.fullName}`, done: checked, total: selection.candidates.length });
    try {
      // Fixer aussi la tête des branches par défaut : les liens de fichiers
      // doivent viser exactement la version comparée, même si la branche avance.
      if (!candidate.headSha) {
        const commit = await client.get(`/repos/${candidate.fullName}/commits/${encodeURIComponent(candidate.branch)}`);
        if (!/^[a-f0-9]{40,64}$/i.test(commit.sha || '')) throw new ScanError('Version de la branche introuvable.');
        candidate.headSha = commit.sha;
      }
      const head = `${candidate.owner}:${candidate.headSha}`;
      const comparison = await client.get(`/repos/${fullName}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(head)}?per_page=${LIMITS.commits}`);
      results.push(summarizeComparison(candidate, comparison, fullName, baseSha));
    } catch (error) {
      if (client.signal?.aborted) throw error;
      warnings.push({ fork: candidate.fullName, branch: candidate.branch, status: error.status, rate: error.rate || null, message: error.message });
      if (error.stop || error.status === 429 || error.status === 401) break;
    }
    checked++;
  }
  return {
    repository: { fullName, branch, sha: baseSha, description: repo.description || '', url: `https://github.com/${fullName}`, forks: repo.forks_count || 0 },
    scannedAt: new Date().toISOString(), limits: LIMITS,
    selection: { discoveredForks: selection.discoveredForks, candidates: selection.candidates.length, compared: results.length, pullsRead: pulls.length, recentRead: recent.length, starredRead: starred.length },
    results: results.sort((a, b) => Number(b.ahead > 0) - Number(a.ahead > 0) || a.behind - b.behind || b.ahead - a.ahead),
    warnings, requests: client.requests, rate: client.rate,
  };
}
