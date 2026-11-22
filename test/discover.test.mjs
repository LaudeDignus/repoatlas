import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, ScanError } from '../lib/scan.mjs';
import {
  DISCOVERY_LIMITS,
  projectQuery,
  peopleQuery,
  discoverProjects,
  discoverPeople,
} from '../lib/discover.mjs';

function makeResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async json() {
      return body;
    },
  };
}

test('projectQuery quotes search terms to prevent qualifier injection and enforces allowlists', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const q = projectQuery(
    {
      mode: 'popular',
      query: 'cli org:evil "quoted\\term"',
      language: 'Go',
      license: 'mit',
      days: 30,
      minStars: 50,
      page: 2,
    },
    now
  );

  assert.equal(q.sort, 'stars');
  assert.equal(q.page, 2);
  // Every user keyword token must be quoted so qualifiers like org:evil cannot be injected
  assert.ok(q.q.includes('"cli" "org:evil" "quoted term"'));
  assert.ok(q.q.includes('is:public fork:false archived:false stars:>=50'));
  assert.ok(q.q.includes('language:"Go"'));
  assert.ok(q.q.includes('license:mit'));
  assert.ok(q.q.includes('created:>=2026-10-22'));

  const invalidInputs = [
    null,
    [],
    { mode: 'trending' },
    { language: 'Brainfuck' },
    { license: 'unlicense' },
    { days: 14 },
    { minStars: -1 },
    { page: 0 },
    { page: 35 },
    { query: 'bad\x00char' },
    { query: 'x'.repeat(101) },
  ];

  for (const bad of invalidInputs) {
    assert.throws(
      () => projectQuery(bad, now),
      err => err instanceof ScanError && err.status === 400,
      `Expected 400 ScanError for ${JSON.stringify(bad)}`
    );
  }
});

test('peopleQuery validates allowlists and quotes location and name tokens', () => {
  const q = peopleQuery({
    mode: 'commits',
    query: 'mouhamed type:org',
    location: 'Dakar "Senegal"',
    language: 'TypeScript',
    days: 90,
    page: 1,
  });

  assert.equal(q.sort, 'followers');
  assert.ok(q.q.includes('type:user repos:>0'));
  assert.ok(q.q.includes('"mouhamed" "type:org" in:login,name'));
  assert.ok(q.q.includes('location:"Dakar  Senegal"'));
  assert.ok(q.q.includes('language:"TypeScript"'));

  for (const bad of [
    [],
    { mode: 'stars' },
    { language: 'UnknownLang' },
    { days: 7 },
    { page: 51 },
    { location: 'a'.repeat(81) },
    { query: 'bad\nline' },
  ]) {
    assert.throws(
      () => peopleQuery(bad),
      err => err instanceof ScanError && err.status === 400
    );
  }
});

test('discoverProjects filters out private/fork/archived repos and sorts locally by createdAt in recent mode', async () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const client = new GitHubClient({
    fetchImpl: async () =>
      makeResponse({
        total_count: 60,
        incomplete_results: false,
        items: [
          {
            full_name: 'alice/older',
            owner: { login: 'alice', type: 'User' },
            private: false,
            fork: false,
            archived: false,
            stargazers_count: 20,
            forks_count: 2,
            language: 'Go',
            license: { spdx_id: 'MIT' },
            topics: ['a', 'b', 'c', 'd', 'e', 'f'],
            created_at: '2026-11-01T00:00:00Z',
            pushed_at: '2026-11-15T00:00:00Z',
          },
          {
            full_name: 'bob/newer',
            owner: { login: 'bob', type: 'User' },
            private: false,
            fork: false,
            archived: false,
            stargazers_count: 5,
            forks_count: 0,
            language: 'Go',
            license: { spdx_id: 'NOASSERTION' },
            created_at: '2026-11-18T00:00:00Z',
            pushed_at: '2026-11-19T00:00:00Z',
          },
          {
            full_name: 'eve/private',
            private: true,
            fork: false,
            archived: false,
          },
          {
            full_name: 'eve/forked',
            private: false,
            fork: true,
            archived: false,
          },
          {
            full_name: 'eve/archived',
            private: false,
            fork: false,
            archived: true,
          },
        ],
      }),
  });

  const result = await discoverProjects({ mode: 'recent', language: 'Go', days: 30 }, { client, now });
  assert.equal(result.kind, 'projects');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].fullName, 'bob/newer');
  assert.equal(result.items[0].license, null); // NOASSERTION stripped
  assert.equal(result.items[1].fullName, 'alice/older');
  assert.equal(result.items[1].topics.length, 5); // capped at 5
  assert.equal(result.hasNext, DISCOVERY_LIMITS.projects < 60);
});

test('discoverPeople hydrates profiles, ranks starred projects mode, and emits progress updates', async () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const progressMessages = [];

  const client = new GitHubClient({
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/search/users') {
        return makeResponse({
          total_count: 2,
          items: [
            { login: 'alice', type: 'User' },
            { login: 'bob', type: 'User' },
            { login: 'org-account', type: 'Organization' },
          ],
        });
      }
      if (parsed.pathname === '/users/alice') {
        return makeResponse({ name: 'Alice', location: 'Dakar', bio: 'Systems', followers: 100, public_repos: 12 });
      }
      if (parsed.pathname === '/users/bob') {
        return makeResponse({ name: 'Bob', location: 'Dakar', bio: 'Go', followers: 50, public_repos: 8 });
      }
      if (parsed.pathname === '/search/repositories') {
        const q = parsed.searchParams.get('q') || '';
        if (q.startsWith('user:alice ')) {
          return makeResponse({ total_count: 2, items: [] });
        }
        if (q.startsWith('user:bob ')) {
          return makeResponse({
            total_count: 9,
            items: [
              {
                full_name: 'bob/star',
                owner: { login: 'bob', type: 'User' },
                private: false,
                fork: false,
                archived: false,
                stargazers_count: 42,
              },
            ],
          });
        }
      }
      return makeResponse({}, { status: 404 });
    },
  });

  const result = await discoverPeople(
    { mode: 'starred', location: 'Dakar' },
    { client, now, onProgress: p => progressMessages.push(p.message) }
  );

  assert.equal(result.kind, 'people');
  assert.equal(result.items.length, 2); // Organization excluded
  assert.equal(result.items[0].login, 'bob'); // 9 starred > 2 starred
  assert.equal(result.items[0].starredProjects, 9);
  assert.equal(result.items[0].projects[0].fullName, 'bob/star');
  assert.equal(result.items[1].login, 'alice');
  assert.equal(result.items[1].starredProjects, 2);
  assert.ok(progressMessages.length >= 5);
});
