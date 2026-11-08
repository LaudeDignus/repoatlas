import { reportFeedback, clearFeedback } from './feedback.js';
const $ = id => document.getElementById(id);
let result = null;
let active = null;
let runId = 0;

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function link(text, url, className) {
  const element = node('a', className, text);
  element.href = url;
  element.target = '_blank';
  element.rel = 'noopener noreferrer';
  return element;
}

function renderCard(item) {
  const card = node('article', 'card');
  const top = node('div', 'card-top');
  const identity = node('div', 'fork-identity');
  const title = node('h3', 'fork-title');
  title.append(link(item.fullName, item.repoUrl));
  const branch = node('p', 'branch');
  branch.append(node('span', '', '⑂'), node('code', '', item.branch), node('span', 'origin', item.origin === 'pull-request' ? 'Branche de PR' : 'Branche principale'));
  if (item.archived) branch.append(node('span', '', 'Dépôt archivé'));
  identity.append(title, branch);
  const counts = node('div', 'counts');
  counts.append(node('span', item.ahead ? 'badge ahead' : 'badge neutral', `↑ ${item.ahead} en avance`), node('span', item.behind ? 'badge behind' : 'badge ahead', item.behind ? `↓ ${item.behind} en retard` : '✓ Aucun retard'));
  top.append(identity, counts);
  const body = node('div', 'card-body');
  if (item.ahead) {
    const list = node('ul', 'signals');
    for (const signal of item.signals) {
      const li = node('li', 'signal');
      const content = node('div');
      content.append(link(signal.title, signal.url));
      const meta = node('p', 'signal-meta');
      meta.append(node('span', '', signal.source), node('span', '', '·'), node('span', '', signal.kind));
      content.append(meta);
      if (signal.description) {
        const details = node('details');
        details.append(node('summary', '', 'Lire la proposition de l’auteur'), node('p', 'description', signal.description));
        content.append(details);
      }
      li.append(node('span', 'signal-icon', '↗'), content);
      list.append(li);
    }
    body.append(list);
    if (!item.signals.length) body.append(node('p', 'branch-message', 'Commits supplémentaires détectés. Consultez la comparaison pour les examiner.'));
    if (item.commitsTruncated || item.totalSignals > item.signals.length) body.append(node('p', 'small-note', `Aperçu limité à ${item.commits.length} commits et ${item.signals.length} pistes. La comparaison GitHub donne le détail.`));
  } else body.append(node('p', 'branch-message', item.behind ? 'Cette branche n’apporte aucun commit supplémentaire et reste en retard sur la référence.' : 'Cette branche est identique à la référence comparée.'));
  const footer = node('div', 'card-footer');
  footer.append(link('Voir les changements ↗', item.compareUrl));
  if (item.files.length) {
    const details = node('details', 'file-details');
    details.append(node('summary', '', `${item.files.length}${item.filesTruncated ? '+' : ''} fichier${item.files.length > 1 ? 's' : ''} concerné${item.files.length > 1 ? 's' : ''}`));
    const list = node('ul', 'file-list');
    for (const file of item.files) {
      const li = node('li');
      if (file.status === 'removed') li.append(node('span', '', `${file.path} · supprimé`));
      else li.append(link(file.path, file.codeUrl));
      li.append(node('span', '', `+${file.additions} −${file.deletions}`));
      list.append(li);
    }
    details.append(list);
    if (item.filesTruncated) details.append(node('p', 'small-note', 'GitHub limite la liste à 300 fichiers. Consultez le dépôt pour aller plus loin.'));
    footer.append(details);
  }
  card.append(top, body, footer);
  return card;
}

function filterResults() {
  if (!result) return;
  const query = $('filter').value.trim().toLocaleLowerCase('fr');
  const items = result.results.filter(item => {
    if (!$('show-unchanged').checked && !item.ahead) return false;
    const haystack = [item.fullName, item.branch, ...item.signals.flatMap(s => [s.title, s.description || '', s.kind]), ...item.files.map(f => f.path)].join(' ').toLocaleLowerCase('fr');
    return !query || haystack.includes(query);
  });
  $('cards').replaceChildren(...items.map(renderCard));
  $('result-count').textContent = `${items.length} branche${items.length > 1 ? 's' : ''} affichée${items.length > 1 ? 's' : ''}`;
  $('empty').hidden = items.length > 0;
  $('empty').textContent = query ? 'Aucun résultat dans les données chargées. Essayez un autre mot-clé, par exemple « yaml » ou « stream ».' : result.results.length ? 'Aucun ajout dans les branches affichées. Vous pouvez inclure les branches sans ajout ou explorer un autre dépôt.' : 'Aucune branche n’a pu être comparée. Consultez les informations de l’analyse ci-dessus.';
}

function showResults(data) {
  result = data;
  $('results').hidden = false;
  $('welcome').hidden = true;
  $('results-title').textContent = data.repository.fullName;
  $('repo-description').textContent = data.repository.description;
  $('repo-link').href = data.repository.url;
  const stats = [
    [new Set(data.results.map(i => i.fullName)).size, 'forks comparés'],
    [data.selection.compared, 'branches comparées'],
    [data.results.filter(i => i.ahead > 0).length, 'branches avec des ajouts'],
    [data.repository.forks, 'forks au total sur GitHub'],
  ];
  $('stats').replaceChildren(...stats.map(([value, label]) => { const e = node('div', 'stat'); e.append(node('strong', '', value), node('span', '', label)); return e; }));
  reportFeedback('forks', data, { retry: startScan });
  const date = new Date(data.scannedAt).toLocaleString('fr-FR');
  $('snapshot-note').textContent = `Analyse du ${date}. Référence : ${data.repository.branch} (${data.repository.sha.slice(0, 10)}). ${data.requests} requêtes GitHub effectuées, cache valable dix minutes. ${data.rate ? `Quota restant observé : ${data.rate.remaining}.` : ''} Les comparaisons reposent sur cette référence ; les titres des branches peuvent évoluer ensuite.`;
  $('filter').value = '';
  filterResults();
  $('results-title').focus({ preventScroll: true });
}

export async function startScan() {
  if (!$('scan-form').reportValidity()) return;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  const thisRun = ++runId;
  clearFeedback('forks');
  $('scan-state').hidden = false;
  $('progress-text').textContent = 'Connexion à GitHub…';
  $('scan-button').disabled = true;
  $('gron-example').disabled = true;
  $('results').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: $('repo-url').value }), signal: controller.signal });
    if (!response.ok) { const body = await response.json(); throw Object.assign(new Error(body.error || 'La requête a échoué.'), { status: response.status, rate: body.rate }); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', completed = false;
    function event(line) {
      if (!line.trim() || thisRun !== runId || controller.signal.aborted) return;
      const item = JSON.parse(line);
      if (item.type === 'progress') $('progress-text').textContent = item.message;
      if (item.type === 'error') throw Object.assign(new Error(item.message), { status: item.status, rate: item.rate });
      if (item.type === 'result') { completed = true; showResults(item.data); }
    }
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); event(line); }
      if (done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!completed) throw new Error('La connexion a été interrompue avant la fin. Réessayez.');
  } catch (error) {
    if (thisRun !== runId) return;
    if (error.name !== 'AbortError') reportFeedback('forks', { error: { message: error instanceof TypeError ? 'Le serveur local ne répond pas. Vérifiez que npm start est lancé.' : error.message, status: error.status, rate: error.rate } }, { retry: startScan });
  } finally {
    if (thisRun === runId) {
      active = null;
      $('scan-state').hidden = true;
      $('scan-button').disabled = false;
      $('gron-example').disabled = false;
      $('results').removeAttribute('aria-busy');
    }
  }
}

$('scan-form').addEventListener('submit', event => { event.preventDefault(); startScan(); });
$('gron-example').addEventListener('click', () => { $('repo-url').value = 'https://github.com/tomnomnom/gron'; startScan(); });
$('cancel-button').addEventListener('click', () => active?.abort());
$('filter').addEventListener('input', filterResults);
$('show-unchanged').addEventListener('change', filterResults);
export function cancelScan() { active?.abort(); }
let accessId = 'unavailable', statusRequest;
export function getAccessId() { return accessId; }
export function refreshAccess() {
  if (statusRequest) return statusRequest;
  statusRequest = fetch('/api/status').then(async response => {
    if (!response.ok) throw new Error('status');
    const data = await response.json(), previous = accessId;
    accessId = data.accessId;
    $('connection').textContent = data.authenticated ? 'GitHub · Jeton configuré' : 'GitHub · Accès public';
    if (previous !== 'unavailable' && previous !== accessId) window.dispatchEvent(new Event('repoatlas:access-change'));
    return data;
  }).catch(() => { $('connection').textContent = 'Connexion GitHub à vérifier'; }).finally(() => { statusRequest = null; });
  return statusRequest;
}
window.addEventListener('focus', refreshAccess);
$('github-dialog').addEventListener('close', refreshAccess);
