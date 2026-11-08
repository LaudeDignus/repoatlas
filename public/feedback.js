import { feedbackSummary } from './ui-state.js';

const notices = new Map();
let activeView = 'projects';
const box = document.getElementById('app-notice');
const dialog = document.getElementById('github-dialog');
const primary = document.getElementById('notice-primary');
const secondary = document.getElementById('notice-retry');

export function openGitHubConfig() {
  if (!dialog.open) dialog.showModal();
}

function render() {
  const current = notices.get(activeView);
  const summary = current && feedbackSummary(current.data);
  box.hidden = !summary;
  if (!summary) return;
  box.dataset.kind = summary.kind;
  document.getElementById('notice-title').textContent = summary.title;
  document.getElementById('notice-body').textContent = summary.body;
  document.getElementById('notice-time').textContent = summary.reset ? `Réinitialisation annoncée : ${new Date(summary.reset).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : '';
  primary.textContent = summary.action === 'configure' ? 'Configurer GitHub' : summary.action === 'filters' ? 'Affiner les filtres' : 'Réessayer';
  primary.onclick = summary.action === 'configure' ? openGitHubConfig : summary.action === 'filters' ? current.actions.filters || current.actions.retry : current.actions.retry;
  secondary.hidden = summary.action !== 'configure' || !current.actions.retry;
  secondary.onclick = current.actions.retry;
}

export function setFeedbackView(view) { activeView = view; render(); }
export function reportFeedback(view, data, actions = {}) { notices.set(view, { data, actions }); render(); }
export function clearFeedback(view) { notices.delete(view); render(); }

document.getElementById('github-settings').addEventListener('click', openGitHubConfig);
document.getElementById('github-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
document.getElementById('copy-env').addEventListener('click', async () => {
  const status = document.getElementById('copy-status');
  try { await navigator.clipboard.writeText('npm run github:token'); status.textContent = 'Commande copiée. Lancez-la dans le terminal du projet.'; }
  catch { status.textContent = 'Copiez la commande ci-dessus dans le terminal du projet.'; }
});
