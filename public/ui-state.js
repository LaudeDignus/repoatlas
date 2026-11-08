// Politique d’affichage partagée : une seule synthèse, même avec plusieurs échecs.
export function feedbackSummary({ warnings = [], error, incomplete = false, rate } = {}, now = Date.now()) {
  const issues = [...warnings, ...(error ? [error] : [])];
  const isQuota = item => item.status === 429 || item.rate?.remaining === 0 || /quota|rate limit|limite les requêtes/i.test(item.message || '');
  const quota = issues.some(isQuota);
  const auth = issues.some(item => item.status === 401);
  const resets = [...issues.map(item => item.rate), rate].filter(item => item?.remaining === 0 && item.reset > now).map(item => item.reset);
  const affected = new Set(issues.flatMap(item => item.profiles || (item.fork ? [item.fork] : [])));
  if (quota || auth) return {
    kind: 'quota', title: auth ? 'La connexion GitHub est à vérifier.' : 'GitHub limite temporairement les données.',
    body: 'Les données disponibles restent affichées. Réessayez après la réinitialisation ou configurez votre accès GitHub.',
    reset: resets.length ? Math.max(...resets) : null, action: 'configure',
  };
  if (error) return { kind: 'error', title: 'La recherche n’a pas abouti.', body: error.message || 'Réessayez dans un instant.', action: 'retry' };
  if (issues.length) return { kind: 'partial', title: 'Quelques informations sont indisponibles.', body: affected.size ? `Données complémentaires manquantes pour ${affected.size} profil${affected.size > 1 ? 's' : ''} ou branche${affected.size > 1 ? 's' : ''}. Les liens restent accessibles.` : 'Les résultats disponibles sont conservés.', action: 'retry' };
  if (incomplete) return { kind: 'partial', title: 'Cette recherche peut être affinée.', body: 'GitHub a renvoyé une sélection incomplète. Précisez les filtres pour obtenir un classement plus fiable.', action: 'filters' };
  return null;
}

export function visibleMetrics(person, mode, days = 30) {
  const metrics = [];
  if (person.followers != null) metrics.push({ value: person.followers, label: 'abonnés' });
  if (person.publicRepos != null) metrics.push({ value: person.publicRepos, label: 'dépôts publics' });
  const value = mode === 'commits' ? person.indexedCommits : mode === 'starred' ? person.starredProjects : null;
  if (value != null) metrics.push({ value, label: mode === 'commits' ? `commits indexés · ${days} j` : 'projets étoilés', featured: true, incomplete: person.metricIncomplete });
  return metrics;
}

export function requestKey(kind, input) {
  return `${kind}:${JSON.stringify(Object.entries(input).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => a.localeCompare(b)))}`;
}

const CACHE_KEY = 'repoatlas:public-results:v4';
const TTL = 600_000;
export function readResultCache(storage, key, now = Date.now()) {
  try {
    const entries = JSON.parse(storage.getItem(CACHE_KEY) || '[]');
    const entry = entries.find(item => item.key === key && now - item.at >= 0 && now - item.at < TTL);
    return entry && ['projects', 'people'].includes(entry.data?.kind) && Array.isArray(entry.data.items) ? entry.data : null;
  } catch { return null; }
}

export function writeResultCache(storage, key, data, now = Date.now()) {
  if (!['projects', 'people'].includes(data?.kind) || !Array.isArray(data.items)) return;
  try {
    const old = JSON.parse(storage.getItem(CACHE_KEY) || '[]');
    const entries = [{ key, data, at: now }, ...old.filter(item => item.key !== key && now - item.at < TTL)].slice(0, 6);
    storage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch { /* Le mode privé ou un stockage plein ne bloque pas la découverte. */ }
}
