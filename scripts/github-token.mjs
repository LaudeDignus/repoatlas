import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { configureToken } from '../lib/token-config.mjs';

function secretPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Lancez cette commande dans votre terminal pour saisir le jeton sans l’afficher.');
  return new Promise((resolve, reject) => {
    // Aucun caractère saisi, y compris pendant un collage, ne rejoint stdout.
    const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
    process.stdout.write('Collez votre jeton GitHub (saisie masquée), puis Entrée : ');
    let settled = false;
    input.once('close', () => { if (!settled) reject(new Error('Configuration annulée.')); });
    input.once('SIGINT', () => { input.close(); process.stdout.write('\n'); reject(new Error('Configuration annulée.')); });
    input.question('', value => { settled = true; input.close(); process.stdout.write('\n'); resolve(value.trim()); });
  });
}
try {
  console.log('RepoAtlas · connexion GitHub locale. Le jeton sera enregistré dans .env, exclu de Git.');
  const token = await secretPrompt();
  const rates = await configureToken(token, { envPath: fileURLToPath(new URL('../.env', import.meta.url)) });
  console.log(`Jeton vérifié et enregistré. Quota de lecture observé : ${rates.core.remaining}/${rates.core.limit}.`);
  if (rates.search) console.log(`Quota de recherche observé : ${rates.search.remaining}/${rates.search.limit} (quota distinct).`);
  console.log('Revenez dans RepoAtlas et rechargez la page. Le jeton est pris en compte sans redémarrage : « GitHub · Jeton configuré ».');
} catch (error) { console.error(error.message); process.exitCode = 1; }
