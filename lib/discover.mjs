import { ScanError } from './scan.mjs';

export const DISCOVERY_LIMITS = Object.freeze({ projects: 30, people: 20 });
const LANGUAGES = new Set(['', 'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C', 'C++', 'C#', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'HTML', 'CSS', 'Shell']);
const LICENSES = new Set(['', 'mit', 'apache-2.0', 'gpl-3.0', 'bsd-3-clause']);
const PROJECT_MODES = new Set(['popular', 'recent', 'stars', 'active']);
const PEOPLE_MODES = new Set(['followers', 'repositories', 'starred', 'commits']);

function text(value, label, maximum = 100) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new ScanError(`${label} : saisie invalide ou trop longue.`, 400);
  return value.trim();
}

function choice(value, allowed, fallback, label) {
  const result = value == null || value === '' ? fallback : value;
  if (!allowed.has(result)) throw new ScanError(`${label} invalide.`, 400);
  return result;
}

function integer(value, allowed, fallback, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || !allowed(parsed)) throw new ScanError(`${label} invalide.`, 400);
  return parsed;
}

// Les termes sont cités : un mot-clé ne doit pas injecter de qualificatif GitHub.
const quote = value => `"${value.replace(/["\\]/g, ' ').trim()}"`;
function keywords(value) {
  return value.split(/\s+/).filter(Boolean).map(quote).join(' ');
}
const sinceDate = (days, now) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
const searchPath = (kind, q, sort, perPage, page = 1) => `/search/${kind}?${new URLSearchParams({ q, sort, order: 'desc', per_page: String(perPage), page: String(page) })}`;
const searchLink = (kind, q, sort) => `https://github.com/search?${new URLSearchParams({ q, type: kind, s: sort, o: 'desc' })}`;
const validRepo = repo => repo && !repo.private && !repo.fork && !repo.archived && /^[\w.-]+\/[\w.-]+$/.test(repo.full_name || '');

function searchData(data) {
  if (!data || !Array.isArray(data.items) || !Number.isFinite(data.total_count)) throw new ScanError('Réponse de recherche GitHub incomplète.');
  return data;
}

export function projectQuery(input = {}, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScanError('Filtres de recherche invalides.', 400);
  const mode = choice(input.mode, PROJECT_MODES, 'popular', 'Mode de découverte');
  const language = choice(input.language, LANGUAGES, '', 'Langage');
  const license = choice(input.license, LICENSES, '', 'Licence');
  const query = text(input.query, 'Mot-clé', 100);
  const days = integer(input.days, n => [7, 30, 90].includes(n), 30, 'Période');
  const minStars = integer(input.minStars, n => n >= 0 && n <= 1_000_000, 0, 'Minimum de stars');
  const page = integer(input.page, n => n >= 1 && n <= 34, 1, 'Page');
  const parts = ['is:public', 'fork:false', 'archived:false', `stars:>=${minStars}`];
  if (query) parts.push(keywords(query));
  if (language) parts.push(`language:${quote(language)}`);
  if (license) parts.push(`license:${license}`);
  if (mode === 'popular' || mode === 'recent') parts.push(`created:>=${sinceDate(days, now)}`);
  if (mode === 'active') parts.push(`pushed:>=${sinceDate(days, now)}`);
  const sort = mode === 'recent' || mode === 'active' ? 'updated' : 'stars';
  return { mode, language, license, query, days, minStars, page, q: parts.join(' '), sort };
}

export function normalizeProject(repo) {
  return {
    fullName: repo.full_name, owner: repo.owner?.login || repo.full_name.split('/')[0], ownerType: repo.owner?.type || 'User',
    description: repo.description || '', url: `https://github.com/${repo.full_name}`,
    stars: repo.stargazers_count || 0, forks: repo.forks_count || 0, language: repo.language || null,
    license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null,
    topics: (repo.topics || []).filter(t => typeof t === 'string').slice(0, 5),
    createdAt: repo.created_at, pushedAt: repo.pushed_at,
  };
}

export async function discoverProjects(input, { client, now = new Date() }) {
  const options = projectQuery(input, now);
  const data = searchData(await client.get(searchPath('repositories', options.q, options.sort, DISCOVERY_LIMITS.projects, options.page)));
  const items = data.items.filter(validRepo).map(normalizeProject);
  if (options.mode === 'recent') items.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return {
    kind: 'projects', options, items, total: data.total_count, page: options.page,
    hasNext: options.page * DISCOVERY_LIMITS.projects < Math.min(data.total_count, 1000),
    incomplete: Boolean(data.incomplete_results), warnings: [],
    scope: options.mode === 'recent' ? `Projets créés dans les ${options.days} derniers jours. Les résultats de chaque page sont triés localement par création ; ce n’est pas un classement global par date de création.`
      : options.mode === 'popular' ? `Projets créés dans les ${options.days} derniers jours, classés par stars cumulées. Ce chiffre ne mesure pas les stars gagnées pendant la période.`
      : options.mode === 'active' ? `Projets avec un push dans les ${options.days} derniers jours, classés par mise à jour GitHub. Ce tri ne mesure pas un nombre de commits.`
      : 'Dépôts publics originaux non archivés, classés par stars cumulées, selon les filtres choisis.',
    sourceUrl: searchLink('repositories', options.q, options.sort),
    requests: client.requests, rate: client.rate, fetchedAt: now.toISOString(),
  };
}

export function peopleQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScanError('Filtres de recherche invalides.', 400);
  const mode = choice(input.mode, PEOPLE_MODES, 'followers', 'Classement');
  const query = text(input.query, 'Nom recherché', 60);
  const location = text(input.location, 'Localisation', 80);
  const language = choice(input.language, LANGUAGES, '', 'Langage');
  const days = integer(input.days, n => [30, 90].includes(n), 30, 'Période des commits');
  const page = integer(input.page, n => n >= 1 && n <= 50, 1, 'Page');
  const parts = ['type:user', 'repos:>0'];
  if (query) parts.push(keywords(query), 'in:login,name');
  if (location) parts.push(`location:${quote(location)}`);
  if (language) parts.push(`language:${quote(language)}`);
  return { mode, query, location, language, days, page, sort: mode === 'repositories' ? 'repositories' : 'followers', q: parts.join(' ') };
}

export async function discoverPeople(input, { client, now = new Date(), onProgress = () => {} }) {
  const options = peopleQuery(input);
  onProgress({ message: 'Recherche des profils publics…' });
  const data = searchData(await client.get(searchPath('users', options.q, options.sort, DISCOVERY_LIMITS.people, options.page)));
  const people = data.items.filter(user => user.type === 'User' && /^[a-zA-Z0-9-]{1,39}$/.test(user.login || '')).map(user => ({
    login: user.login, name: null, location: null, bio: '', followers: null, publicRepos: null,
    starredProjects: null, indexedCommits: null, metricIncomplete: false,
    metricUrl: null, projects: [], url: `https://github.com/${user.login}`,
  }));
  const warnings = [];
  function warn(error, login) {
    const quota = error.status === 429 || error.rate?.remaining === 0;
    const key = quota ? `quota:${error.rate?.resource || 'github'}` : `${error.status}:${error.message}`;
    const existing = warnings.find(item => item.key === key);
    if (existing) { if (!existing.profiles.includes(login)) existing.profiles.push(login); return; }
    warnings.push({ key, status: error.status, rate: error.rate || null, profiles: [login], message: error.message });
  }
  for (const person of people) {
    onProgress({ message: `Lecture du profil · ${person.login}` });
    try {
      const profile = await client.get(`/users/${person.login}`);
      person.name = profile.name || null;
      person.location = profile.location || null;
      person.bio = profile.bio || '';
      person.followers = Number.isFinite(profile.followers) ? profile.followers : null;
      person.publicRepos = Number.isFinite(profile.public_repos) ? profile.public_repos : null;
    } catch (error) {
      if (client.signal?.aborted) throw error;
      warn(error, person.login);
      if (error.status === 401) break;
    }
    if (options.mode === 'starred' || options.mode === 'commits') {
      onProgress({ message: `Mesure des ${options.mode === 'starred' ? 'projets étoilés' : 'commits indexés'} · ${person.login}` });
      try {
        if (options.mode === 'starred') {
          const q = `user:${person.login} is:public fork:false archived:false stars:>=1`;
          const repositories = searchData(await client.get(searchPath('repositories', q, 'stars', 3)));
          person.starredProjects = repositories.total_count;
          person.metricIncomplete = Boolean(repositories.incomplete_results);
          person.metricUrl = searchLink('repositories', q, 'stars');
          person.projects = repositories.items.filter(validRepo).map(normalizeProject);
        } else {
          const q = `author:${person.login} committer-date:>=${sinceDate(options.days, now)} is:public`;
          const commits = searchData(await client.get(searchPath('commits', q, 'committer-date', 1)));
          person.indexedCommits = commits.total_count;
          person.metricIncomplete = Boolean(commits.incomplete_results);
          person.metricUrl = searchLink('commits', q, 'committer-date');
        }
      } catch (error) {
        if (client.signal?.aborted) throw error;
        warn(error, person.login);
        if (error.stop || error.status === 429 || error.status === 401) break;
      }
    }
  }
  if (options.mode === 'starred' || options.mode === 'commits') {
    const key = options.mode === 'starred' ? 'starredProjects' : 'indexedCommits';
    people.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  }
  return {
    kind: 'people', options, items: people, total: data.total_count, page: options.page,
    hasNext: options.page * DISCOVERY_LIMITS.people < Math.min(data.total_count, 1000),
    incomplete: Boolean(data.incomplete_results) || people.some(person => person.metricIncomplete), warnings,
    scope: options.mode === 'starred' ? `Tri sur ${people.length} profil${people.length > 1 ? 's' : ''} de cette page, après présélection par abonnés, selon le nombre de dépôts publics originaux non archivés avec au moins une star. Ce n’est pas un classement mondial.`
      : options.mode === 'commits' ? `Tri sur ${people.length} profil${people.length > 1 ? 's' : ''} de cette page, après présélection par abonnés, selon les commits publics indexés par GitHub sur ${options.days} jours. Seules les branches par défaut sont recherchées ; ce n’est ni le total de leurs contributions ni un classement mondial.`
      : options.mode === 'repositories' ? 'Classement GitHub par nombre de dépôts publics, forks inclus. Un dépôt public n’a pas nécessairement de licence open source.'
      : 'Classement GitHub par nombre d’abonnés, selon les filtres choisis.',
    locationNote: 'Localisation déclarée librement sur le profil GitHub : pas de géolocalisation vérifiée, de nationalité ou de regroupement automatique par continent.',
    sourceUrl: searchLink('users', options.q, options.sort),
    requests: client.requests, rate: client.rate, fetchedAt: now.toISOString(),
  };
}
