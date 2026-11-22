import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  ScanError,
  parseRepository,
  GitHubClient,
  selectBranches,
  summarizeComparison,
  scanRepository,
} from '../lib/scan.mjs';

function makeResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return body;
    },
  };
}

test('parseRepository accepts valid GitHub repository URLs and normalizes trailing slash and .git', () => {
  assert.equal(parseRepository('https://github.com/tomnomnom/gron'), 'tomnomnom/gron');
  assert.equal(parseRepository('  https://github.com/tomnomnom/gron/  '), 'tomnomnom/gron');
  assert.equal(parseRepository('https://github.com/owner-1/repo.name.git'), 'owner-1/repo.name');
});

test('parseRepository rejects non-GitHub, non-HTTPS, credentialed, subpath, query, hash, traversal, and oversized URLs', () => {
  const invalid = [
    '',
    null,
    42,
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com:8443/owner/repo',
    'https://user:pass@github.com/owner/repo',
    'https://github.com/owner/repo?tab=readme',
    'https://github.com/owner/repo#readme',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/issues/1',
    'https://github.com/-badowner/repo',
    'https://github.com/owner/..',
    'https://github.com/owner/.',
    'https://github.com/owner/.git',
    `https://github.com/owner/${'a'.repeat(300)}`,
  ];

  for (const input of invalid) {
    assert.throws(
      () => parseRepository(input),
      err => err instanceof ScanError && err.status === 400,
      `Expected 400 ScanError for ${String(input)}`
    );
  }
});

test('GitHubClient.get enforces strict API path allowlist and blocks scheme injection', async () => {
  let called = false;
  const client = new GitHubClient({
    fetchImpl: async () => {
      called = true;
      return makeResponse({});
    },
  });

  const disallowed = [
    '/user',
    '/rate_limit',
    '/orgs/github/repos',
    '/search/code?q=secret',
    '/repos/owner/repo?url=https://evil.test',
    'https://evil.test/repos/a/b',
    '/users/bad/extra',
    '/users/user?foo=bar',
  ];

  for (const path of disallowed) {
    await assert.rejects(
      () => client.get(path),
      err => err instanceof ScanError && err.status === 400,
      `Expected disallowed path to fail: ${path}`
    );
  }
  assert.equal(called, false);
});

test('GitHubClient.get sends safe headers, redirect:error, caches public responses as clones, and never caches private payloads', async () => {
  let calls = 0;
  const seenRequests = [];
  const fetchImpl = async (url, init) => {
    calls++;
    seenRequests.push({ url, init });
    if (url.endsWith('/repos/acme/public')) {
      return makeResponse(
        { full_name: 'acme/public', private: false, nested: { count: 1 } },
        {
          headers: {
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
            'x-ratelimit-resource': 'core',
          },
        }
      );
    }
    if (url.endsWith('/repos/acme/secret')) {
      return makeResponse({ full_name: 'acme/secret', private: true });
    }
    if (url.endsWith('/repos/acme/pr-private')) {
      return makeResponse({ head: { repo: { private: true } } });
    }
    if (url.includes('/search/repositories?')) {
      return makeResponse({
        total_count: 1,
        items: [{ full_name: 'acme/hidden', private: true }],
      });
    }
    if (url.includes('/search/commits?')) {
      return makeResponse({
        total_count: 1,
        items: [{ repository: { private: true } }],
      });
    }
    return makeResponse({}, { status: 404 });
  };

  const cache = new Map();
  const client = new GitHubClient({ token: 'ghp_testtoken1234567890', fetchImpl, cache });

  // Public response is cached and returned as a structured clone
  const first = await client.get('/repos/acme/public');
  first.nested.count = 999;
  const second = await client.get('/repos/acme/public');
  assert.equal(calls, 1);
  assert.equal(second.nested.count, 1);
  assert.equal(seenRequests[0].init.redirect, 'error');
  assert.equal(seenRequests[0].init.headers.Authorization, 'Bearer ghp_testtoken1234567890');
  assert.equal(cache.has('/repos/acme/public'), true);

  // Private repository, private PR head repo, and search results containing private items must NEVER be cached
  await client.get('/repos/acme/secret');
  await client.get('/repos/acme/pr-private');
  await client.get('/search/repositories?q=test');
  await client.get('/search/commits?q=test');

  assert.equal(cache.has('/repos/acme/secret'), false);
  assert.equal(cache.has('/repos/acme/pr-private'), false);
  assert.equal(cache.has('/search/repositories?q=test'), false);
  assert.equal(cache.has('/search/commits?q=test'), false);
});

test('GitHubClient.get enforces per-scan 42-request budget and short-circuits exhausted rate limits', async () => {
  const rateStates = new Map([
    ['search', { remaining: 0, reset: Date.now() + 60_000, resource: 'search' }],
  ]);
  const client = new GitHubClient({
    rateStates,
    fetchImpl: async () => makeResponse({ items: [], total_count: 0 }),
  });

  await assert.rejects(
    () => client.get('/search/repositories?q=node'),
    err => err instanceof ScanError && err.status === 429 && err.stop === true
  );

  const budgetClient = new GitHubClient({
    fetchImpl: async () => makeResponse({ private: true }), // uncached so every call hits fetchImpl
  });
  for (let i = 0; i < 42; i++) {
    await budgetClient.get(`/repos/owner/repo-${i}`);
  }
  await assert.rejects(
    () => budgetClient.get('/repos/owner/repo-42'),
    err => err instanceof ScanError && err.status === 429
  );
});

test('selectBranches filters bots/private/upstream, applies round-robin PR fairness, and respects LIMITS', () => {
  const makeFork = (name, pushedAt, stars = 0, isPrivate = false) => ({
    full_name: name,
    owner: { login: name.split('/')[0] },
    default_branch: 'main',
    stargazers_count: stars,
    pushed_at: pushedAt,
    private: isPrivate,
  });

  const makePr = (number, repoName, ref, { bot = false, isPrivate = false } = {}) => ({
    number,
    title: `PR #${number}`,
    body: 'Details',
    user: { type: bot ? 'Bot' : 'User' },
    head: {
      ref,
      sha: String(number).padStart(40, 'a'),
      repo: makeFork(repoName, '2026-10-01T00:00:00Z', 5, isPrivate),
    },
  });

  const pulls = [
    makePr(1, 'alice/repo', 'feat-1'),
    makePr(2, 'alice/repo', 'feat-2'),
    makePr(3, 'bob/repo', 'fix-1'),
    makePr(4, 'dependabot/repo', 'deps', { bot: true }),
    makePr(5, 'secret/repo', 'private-branch', { isPrivate: true }),
    makePr(6, 'upstream/repo', 'same-repo'),
  ];

  const recent = [
    makeFork('carol/repo', '2026-11-01T00:00:00Z', 2),
    makeFork('upstream/repo', '2026-11-02T00:00:00Z', 100),
    makeFork('hidden/repo', '2026-11-03T00:00:00Z', 50, true),
  ];

  const { candidates, discoveredForks, pullBranches } = selectBranches('upstream/repo', recent, [], pulls);

  assert.equal(discoveredForks, 3); // alice, bob, carol
  assert.equal(pullBranches, 3); // alice feat-1, alice feat-2, bob fix-1
  // Round-robin: first branch from alice, then first branch from bob, then second branch from alice
  assert.equal(candidates[0].key, 'alice/repo:feat-1');
  assert.equal(candidates[1].key, 'bob/repo:fix-1');
  assert.equal(candidates[2].key, 'alice/repo:feat-2');
  assert.equal(candidates.some(c => c.fullName === 'carol/repo' && c.origin === 'default-branch'), true);
  assert.equal(candidates.some(c => c.owner === 'dependabot'), false);
  assert.equal(candidates.some(c => c.owner === 'secret'), false);
  assert.ok(candidates.length <= LIMITS.branches);
});

test('summarizeComparison pins SHAs, builds compare/blob URLs, and classifies & deduplicates signals', () => {
  const baseSha = '1'.repeat(40);
  const headSha = '2'.repeat(40);
  const candidate = {
    fullName: 'alice/tool',
    owner: 'alice',
    branch: 'feat/yaml',
    headSha,
    origin: 'pull-request',
    pulls: [{ number: 12, title: 'Add YAML output mode', body: 'Supports YAML', url: 'https://github.com/acme/tool/pull/12' }],
  };
  const comparison = {
    ahead_by: 2,
    behind_by: 1,
    status: 'diverged',
    total_commits: 2,
    commits: [
      { sha: '3'.repeat(40), commit: { message: 'Merge branch main into feat/yaml' } },
      { sha: headSha, commit: { message: 'Add YAML output mode\n\nExtra body' } },
      { sha: '4'.repeat(40), commit: { message: 'docs: document YAML flag' } },
    ],
    files: [{ filename: 'src/yaml parser.js', status: 'added', additions: 40, deletions: 0 }],
  };

  const summary = summarizeComparison(candidate, comparison, 'acme/tool', baseSha);
  assert.equal(summary.ahead, 2);
  assert.equal(summary.behind, 1);
  assert.equal(summary.headSha, headSha);
  assert.equal(
    summary.compareUrl,
    `https://github.com/acme/tool/compare/${baseSha}...${encodeURIComponent(`alice:tool:${headSha}`)}`
  );
  assert.equal(
    summary.files[0].codeUrl,
    `https://github.com/alice/tool/blob/${headSha}/src/yaml%20parser.js`
  );
  // Deduplicated "Add YAML output mode", merge commit excluded, Feature ranked ahead of Documentation
  assert.equal(summary.signals.length, 2);
  assert.equal(summary.signals[0].kind, 'Fonctionnalité');
  assert.equal(summary.signals[1].kind, 'Documentation');
});

test('scanRepository rejects private upstream repositories and compares public forks with immutable SHAs', async () => {
  const baseSha = 'a'.repeat(40);
  const forkSha = 'b'.repeat(40);

  const routes = new Map([
    ['/repos/acme/private-repo', { full_name: 'acme/private-repo', default_branch: 'main', private: true }],
    ['/repos/acme/demo', { full_name: 'acme/demo', default_branch: 'main', private: false, description: 'Demo repo', forks_count: 1 }],
    ['/repos/acme/demo/commits/main', { sha: baseSha }],
    [
      `/repos/acme/demo/forks?sort=newest&per_page=${LIMITS.recentForks}`,
      [{ full_name: 'forker/demo', owner: { login: 'forker' }, default_branch: 'main', stargazers_count: 3, pushed_at: '2026-11-01T00:00:00Z', private: false }],
    ],
    [`/repos/acme/demo/forks?sort=stargazers&per_page=${LIMITS.starredForks}`, []],
    [`/repos/acme/demo/pulls?state=open&sort=updated&direction=desc&per_page=${LIMITS.pullRequests}`, []],
    ['/repos/forker/demo/commits/main', { sha: forkSha }],
    [
      `/repos/acme/demo/compare/${baseSha}...${encodeURIComponent(`forker:${forkSha}`)}?per_page=${LIMITS.commits}`,
      {
        ahead_by: 1,
        behind_by: 0,
        status: 'ahead',
        total_commits: 1,
        commits: [{ sha: forkSha, commit: { message: 'Fix crash on empty input' } }],
        files: [{ filename: 'index.js', status: 'modified', additions: 5, deletions: 1 }],
      },
    ],
  ]);

  const fetchImpl = async url => {
    const path = url.replace('https://api.github.com', '');
    if (!routes.has(path)) return makeResponse({}, { status: 404 });
    return makeResponse(routes.get(path));
  };

  const privateClient = new GitHubClient({ fetchImpl });
  await assert.rejects(
    () => scanRepository('https://github.com/acme/private-repo', { client: privateClient }),
    err => err instanceof ScanError && err.status === 400
  );

  const phases = [];
  const publicClient = new GitHubClient({ fetchImpl });
  const scan = await scanRepository('https://github.com/acme/demo', {
    client: publicClient,
    onProgress: event => phases.push(event.phase),
  });

  assert.equal(scan.repository.fullName, 'acme/demo');
  assert.equal(scan.repository.sha, baseSha);
  assert.equal(scan.results.length, 1);
  assert.equal(scan.results[0].fullName, 'forker/demo');
  assert.equal(scan.results[0].headSha, forkSha);
  assert.equal(scan.results[0].ahead, 1);
  assert.deepEqual(phases, ['repository', 'discovery', 'compare']);
});
