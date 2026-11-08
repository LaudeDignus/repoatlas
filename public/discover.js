import { node, link, startScan, cancelScan, refreshAccess, getAccessId } from './app.js';
import { setFeedbackView, reportFeedback, clearFeedback } from './feedback.js';
import { visibleMetrics, requestKey, readResultCache, writeResultCache } from './ui-state.js';
import { attachLocationSuggestions } from './locations.js';

const $ = id => document.getElementById(id);
const languages = ['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C', 'C++', 'C#', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'HTML', 'CSS', 'Shell'];
const lastInputs = {}, lastResults = {}, viewOperations = {}, timers = {};
let pending = null, operation = 0, activeView;
const number = value => new Intl.NumberFormat('fr-FR').format(value);
const time = value => new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const storage = () => { try { return window.sessionStorage; } catch { return null; } };
const currentInput = kind => ({ ...Object.fromEntries(new FormData($(`${kind}-form`))), page: 1 });

for (const select of document.querySelectorAll('.language-options')) for (const language of languages) {
  const option = node('option', '', language); option.value = language; select.append(option);
}
function switchView(view, load = true) {
  if (!['projects', 'people', 'forks'].includes(view)) view = 'projects';
  if (activeView !== view) {
    for (const timer of Object.values(timers)) clearTimeout(timer);
    pending?.abort(); cancelScan(); activeView = view;
  }
  for (const name of ['projects', 'people', 'forks']) $(`view-${name}`).hidden = name !== view;
  for (const item of document.querySelectorAll('[data-view]')) {
    if (item.dataset.view === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  setFeedbackView(view);
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (load && view !== 'forks' && !lastResults[view]) runDiscovery(view);
}
function analyze(repo) { switchView('forks'); $('repo-url').value = repo.url; startScan(); }
function author(login) {
  switchView('people', false);
  const form = $('people-form');
  for (const name of ['location', 'language']) form.elements.namedItem(name).value = '';
  form.elements.namedItem('mode').value = 'followers'; form.elements.namedItem('query').value = login;
  $('people-advanced').open = true; updateFilters('people'); runDiscovery('people');
}
function projectCard(repo, index) {
  const card = node('article', 'project-card'), top = node('div', 'project-card-top');
  top.append(node('span', 'project-rank', String(index + 1).padStart(2, '0')), node('span', 'star-count', `★ ${number(repo.stars)}`));
  const heading = node('h4'); heading.append(link(repo.fullName, repo.url));
  card.append(top, heading, node('p', 'project-description', repo.description || 'Découvrez le projet sur GitHub.'));
  if (repo.topics?.length) { const topics = node('div', 'topics'); for (const topic of repo.topics.slice(0, 3)) topics.append(node('span', '', topic)); card.append(topics); }
  const metadata = node('p', 'project-metadata');
  for (const value of [repo.language, repo.license, repo.forks != null ? `${number(repo.forks)} forks` : null]) if (value) metadata.append(node('span', '', value));
  const actions = node('div', 'project-actions');
  const owner = repo.ownerType === 'User' ? node('button', 'text-button', `◎ ${repo.owner}`) : link(`◎ ${repo.owner} ↗`, `https://github.com/${repo.owner}`, 'text-button');
  if (repo.ownerType === 'User') { owner.type = 'button'; owner.addEventListener('click', () => author(repo.owner)); }
  const forks = node('button', 'small-button', 'Explorer les forks'); forks.type = 'button'; forks.addEventListener('click', () => analyze(repo));
  actions.append(owner, forks); card.append(metadata, actions); return card;
}
function peopleCard(person, data) {
  const card = node('article', 'person-card'), header = node('div', 'person-header'), name = node('div'), heading = node('h4');
  heading.append(link(person.name || person.login, person.url)); name.append(heading);
  if (person.name && person.name !== person.login) name.append(node('p', 'person-login', `@${person.login}`));
  header.append(node('span', 'person-avatar', person.login.slice(0, 2).toUpperCase()), name); card.append(header);
  if (person.location) card.append(node('p', 'person-location', `⌖ ${person.location}`));
  if (person.bio) card.append(node('p', 'person-bio', person.bio));
  const available = visibleMetrics(person, data.options.mode, data.options.days);
  if (available.length) {
    const metrics = node('div', 'person-metrics');
    for (const item of available) { const metric = node('div', item.featured ? 'featured-metric' : ''); metric.append(node('strong', '', `${number(item.value)}${item.incomplete ? ' ≈' : ''}`), node('span', '', item.label)); metrics.append(metric); }
    card.append(metrics);
  } else card.append(node('p', 'profile-unavailable', 'Statistiques indisponibles pour ce profil.'));
  if (person.projects?.length) {
    const details = node('details', 'person-projects'); details.append(node('summary', '', 'Projets étoilés'));
    for (const project of person.projects) { const row = node('div'); row.append(link(project.fullName, project.url), node('span', '', `★ ${number(project.stars)}`)); details.append(row); } card.append(details);
  }
  const actions = node('div', 'person-actions'); actions.append(link('Voir le profil ↗', person.url));
  if (person.metricUrl) actions.append(link('Vérifier la mesure ↗', person.metricUrl)); card.append(actions); return card;
}
function feedbackActions(kind) { return { retry: () => runDiscovery(kind, 1, true), filters: () => { $(`${kind}-advanced`).open = true; $(`${kind}-form`).querySelector('input[type="search"]').focus(); } }; }
function pagerState(kind) {
  const data = lastResults[kind]; if (!data) return;
  const unchanged = requestKey(kind, { ...currentInput(kind), page: data.page }) === requestKey(kind, lastInputs[kind]);
  const pager = $(`${kind}-results`).querySelector('.pagination');
  pager.querySelector('[data-direction="-1"]').disabled = !unchanged || data.page <= 1;
  pager.querySelector('[data-direction="1"]').disabled = !unchanged || !data.hasNext;
}
function render(kind, data, cached = false) {
  lastResults[kind] = data;
  const container = $(`${kind}-results`); container.hidden = false; $(`${kind}-welcome`).hidden = true;
  container.querySelector('.discovery-result-heading h3').textContent = `${number(data.items.length)} ${kind === 'projects' ? 'projet' : 'profil'}${data.items.length > 1 ? 's' : ''} à explorer · ${data.incomplete ? '≈ ' : ''}${number(data.total)} résultats`;
  container.querySelector('.discovery-result-heading a').href = data.sourceUrl;
  container.querySelector('.result-scope').textContent = data.scope;
  if (kind === 'people') container.querySelector('.location-note').textContent = data.locationNote;
  container.querySelector('.discovery-grid').replaceChildren(...data.items.map((item, index) => kind === 'projects' ? projectCard(item, (data.page - 1) * 30 + index) : peopleCard(item, data)));
  container.querySelector('.discovery-no-results').hidden = data.items.length > 0;
  container.querySelector('.pagination span').textContent = `Page ${data.page} · ${cached || data.requests === 0 ? 'Résultats en cache' : `${data.requests} appel${data.requests > 1 ? 's' : ''} API`}`;
  $(`${kind}-freshness`).textContent = `Sélection de ${time(data.fetchedAt)}${cached ? ' · en mémoire' : ''}`;
  reportFeedback(kind, data, feedbackActions(kind)); pagerState(kind);
}
function setBusy(kind, busy) {
  $(`${kind}-loading`).hidden = !busy;
  $(`${kind}-skeleton`).hidden = !busy || !!lastResults[kind];
  $(`${kind}-results`).toggleAttribute('aria-busy', busy);
  if (busy) for (const button of $(`${kind}-results`).querySelectorAll('.pagination button')) button.disabled = true;
  else pagerState(kind);
}
async function request(kind, input, controller, retry = true) {
  const response = await fetch(`/api/discover/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
  // L’annulation précédente peut encore se terminer côté serveur local.
  if (response.status === 409 && retry) { await response.text(); await new Promise(resolve => setTimeout(resolve, 150)); controller.signal.throwIfAborted(); return request(kind, input, controller, false); }
  if (!response.ok) { const body = await response.json(); throw Object.assign(new Error(body.error || 'La recherche a échoué.'), { status: response.status, rate: body.rate }); }
  return response;
}
async function runDiscovery(kind, page = 1, force = false) {
  clearTimeout(timers[kind]); if (kind !== activeView) return;
  const form = $(`${kind}-form`); if (!form.reportValidity()) return;
  pending?.abort(); const controller = new AbortController(); pending = controller;
  const id = ++operation; viewOperations[kind] = id;
  const input = page === 1 ? currentInput(kind) : { ...lastInputs[kind], page };
  const key = `${getAccessId()}:${requestKey(kind, input)}`; clearFeedback(kind);
  const cached = !force && readResultCache(storage(), key);
  if (cached) { lastInputs[kind] = input; render(kind, cached, true); setBusy(kind, false); pending = null; return; }
  setBusy(kind, true); $(`${kind}-welcome`).hidden = true;
  const loading = $(`${kind}-loading`); loading.querySelector('p').textContent = 'Recherche sur GitHub…';
  try {
    const response = await request(kind, input, controller), reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', completed = false;
    const consume = line => {
      if (!line.trim() || id !== operation || controller.signal.aborted) return;
      const event = JSON.parse(line);
      if (event.type === 'progress') loading.querySelector('p').textContent = event.message;
      if (event.type === 'error') throw Object.assign(new Error(event.message), { status: event.status, rate: event.rate });
      if (event.type === 'result') { completed = true; lastInputs[kind] = input; writeResultCache(storage(), key, event.data); render(kind, event.data); }
    };
    for (;;) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); consume(line); }
      if (done) { if (buffer.trim()) consume(buffer); break; }
    }
    if (!completed && !controller.signal.aborted && id === operation) throw new Error('La connexion a été interrompue. Relancez la recherche.');
  } catch (error) {
    if (id !== operation || controller.signal.aborted) return;
    reportFeedback(kind, { error: { message: error instanceof TypeError ? 'Le serveur local ne répond pas. Vérifiez que npm start est lancé.' : error.message, status: error.status, rate: error.rate } }, feedbackActions(kind));
    $(`${kind}-welcome`).hidden = !!lastResults[kind];
  } finally {
    if (viewOperations[kind] === id) { setBusy(kind, false); if (!lastResults[kind]) $(`${kind}-welcome`).hidden = false; }
    if (id === operation) pending = null;
  }
}
function updateFilters(kind) {
  const form = $(`${kind}-form`), value = name => form.elements.namedItem(name).value;
  const days = form.elements.namedItem('days'); days.disabled = kind === 'projects' ? value('mode') === 'stars' : value('mode') !== 'commits';
  const count = kind === 'projects' ? Number(!days.disabled && value('days') !== '30') + Number(value('minStars') !== '10') + Number(!!value('license')) : Number(!!value('query')) + Number(!!value('language')) + Number(!days.disabled && value('days') !== '30');
  const badge = $(`${kind}-filter-count`); badge.hidden = !count; badge.textContent = count;
}
function schedule(kind, delay = kind === 'people' ? 700 : 450) {
  clearTimeout(timers[kind]); pending?.abort(); clearFeedback(kind); updateFilters(kind);
  for (const button of $(`${kind}-results`).querySelectorAll('.pagination button')) button.disabled = true;
  $(`${kind}-freshness`).textContent = 'Mise à jour de la recherche…';
  timers[kind] = setTimeout(() => runDiscovery(kind), delay);
}
for (const kind of ['projects', 'people']) {
  const form = $(`${kind}-form`);
  form.addEventListener('submit', event => { event.preventDefault(); runDiscovery(kind); });
  form.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && !event.defaultPrevented && ['text', 'search'].includes(event.target.type)) { event.preventDefault(); runDiscovery(kind); } });
  form.addEventListener('input', event => { if (!event.isComposing && !['radio', 'select-one'].includes(event.target.type)) schedule(kind); });
  form.addEventListener('compositionend', () => schedule(kind));
  form.addEventListener('change', event => {
    if (!['radio', 'select-one'].includes(event.target.type)) return;
    if (kind === 'projects' && event.target.name === 'mode' && event.target.value === 'stars' && Number(form.elements.namedItem('minStars').value) < 1000) form.elements.namedItem('minStars').value = '1000';
    schedule(kind, 180);
  });
  form.addEventListener('reset', () => { clearTimeout(timers[kind]); setTimeout(() => { updateFilters(kind); if (activeView === kind) runDiscovery(kind); }, 0); });
  $(`${kind}-refresh`).addEventListener('click', () => runDiscovery(kind, 1, true));
  $(`${kind}-loading`).querySelector('.discovery-cancel').addEventListener('click', () => { pending?.abort(); clearTimeout(timers[kind]); $(`${kind}-freshness`).textContent = 'Recherche annulée'; });
  for (const button of $(`${kind}-results`).querySelectorAll('.pagination button')) button.addEventListener('click', () => runDiscovery(kind, lastResults[kind].page + Number(button.dataset.direction)));
  updateFilters(kind);
}
const closeLocations = attachLocationSuggestions($('location-input'), $('location-suggestions'), () => runDiscovery('people'));
for (const button of document.querySelectorAll('[data-location]')) button.addEventListener('click', () => { $('location-input').value = button.dataset.location; closeLocations(); runDiscovery('people'); });
for (const item of document.querySelectorAll('[data-view]')) item.addEventListener('click', event => { event.preventDefault(); switchView(item.dataset.view); });
window.addEventListener('hashchange', () => switchView(location.hash.slice(1)));
window.addEventListener('repoatlas:access-change', () => {
  pending?.abort(); cancelScan();
  for (const kind of ['projects', 'people']) { delete lastResults[kind]; delete lastInputs[kind]; $(`${kind}-results`).hidden = true; clearFeedback(kind); }
  clearFeedback('forks');
  if (activeView !== 'forks') runDiscovery(activeView, 1, true);
});
await refreshAccess();
switchView(location.hash.slice(1));
