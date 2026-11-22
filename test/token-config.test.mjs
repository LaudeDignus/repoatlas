import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceEnvToken, configureToken, readLocalToken } from '../lib/token-config.mjs';

const VALID_TOKEN = 'github_pat_11ABCDEFG_1234567890abcdef';

function mockRateLimitFetch(status = 200, payload = { resources: { core: { limit: 5000, remaining: 4999 }, search: { limit: 30, remaining: 30 } } }) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  });
}

test('replaceEnvToken validates token format, preserves unrelated keys, and deduplicates GITHUB_TOKEN', () => {
  const updated = replaceEnvToken(
    'PORT=4328\nexport GITHUB_TOKEN=old_value_123456789012345\nFOO=bar\nGITHUB_TOKEN=dup_value_123456789012345\n',
    VALID_TOKEN
  );
  assert.equal(updated, `PORT=4328\nGITHUB_TOKEN=${VALID_TOKEN}\nFOO=bar\n`);

  const appended = replaceEnvToken('PORT=4328\n', VALID_TOKEN);
  assert.equal(appended, `PORT=4328\nGITHUB_TOKEN=${VALID_TOKEN}\n`);

  for (const invalid of ['', 'short', 'has space 123456789012345', '"quoted_12345678901234567890"', 'line\nbreak_123456789012345']) {
    assert.throws(() => replaceEnvToken('', invalid), /jeton semble invalide/i);
  }
});

test('configureToken writes .env atomically with 0600 permissions and leaves no leftover temp files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repoatlas-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const envPath = join(dir, '.env');
  await writeFile(envPath, 'PORT=4329\n', 'utf8');

  const rates = await configureToken(VALID_TOKEN, {
    envPath,
    fetchImpl: mockRateLimitFetch(),
  });

  assert.equal(rates.core.limit, 5000);
  const content = await readFile(envPath, 'utf8');
  assert.equal(content, `PORT=4329\nGITHUB_TOKEN=${VALID_TOKEN}\n`);

  if (process.platform !== 'win32') {
    const info = await stat(envPath);
    assert.equal(info.mode & 0o777, 0o600);
  }

  const files = await readdir(dir);
  assert.deepEqual(files, ['.env']);
});

test('configureToken refuses symlinks and directories without modifying target files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repoatlas-symlink-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const target = join(dir, 'outside.txt');
  const linkPath = join(dir, '.env');
  await writeFile(target, 'DO_NOT_TOUCH=1\n', 'utf8');
  await symlink(target, linkPath);

  await assert.rejects(
    () => configureToken(VALID_TOKEN, { envPath: linkPath, fetchImpl: mockRateLimitFetch() }),
    /fichier local ordinaire/i
  );
  assert.equal(await readFile(target, 'utf8'), 'DO_NOT_TOUCH=1\n');

  const subdir = join(dir, 'env-dir');
  await mkdir(subdir);
  await assert.rejects(
    () => configureToken(VALID_TOKEN, { envPath: subdir, fetchImpl: mockRateLimitFetch() }),
    /fichier local ordinaire/i
  );
});

test('configureToken does not write .env when GitHub rejects or returns malformed rate_limit response', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repoatlas-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');

  await assert.rejects(
    () => configureToken(VALID_TOKEN, { envPath, fetchImpl: mockRateLimitFetch(401, {}) }),
    /refuse ce jeton/i
  );

  await assert.rejects(
    () => configureToken(VALID_TOKEN, { envPath, fetchImpl: mockRateLimitFetch(200, { resources: {} }) }),
    /inattendue/i
  );

  const files = await readdir(dir);
  assert.deepEqual(files, []);
});

test('readLocalToken reads GITHUB_TOKEN from .env and falls back cleanly on ENOENT', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'repoatlas-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const missingPath = join(dir, 'missing.env');
  assert.equal(await readLocalToken(missingPath, 'fallback_tok'), 'fallback_tok');

  const envPath = join(dir, '.env');
  await writeFile(envPath, `PORT=4328\nGITHUB_TOKEN=${VALID_TOKEN}\n`, 'utf8');
  assert.equal(await readLocalToken(envPath, 'fallback_tok'), VALID_TOKEN);
});
