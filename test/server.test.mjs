import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

function startServer(t, options = {}) {
  return new Promise((resolve, reject) => {
    const server = createApp(options);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => server.close(done)));
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function rawRequest(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeFetchResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async json() {
      return body;
    },
  };
}

test('server enforces Host, Origin, and Sec-Fetch-Site guards and sets strict CSP & security headers', async t => {
  const { port } = await startServer(t, { token: '' });

  const ok = await rawRequest(port, { path: '/api/status' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.ok(ok.headers['content-security-policy'].includes("default-src 'self'"));
  assert.ok(ok.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  assert.ok(ok.headers['content-security-policy'].includes("base-uri 'none'"));

  // DNS-rebinding Host rejection
  const badHost = await rawRequest(port, { path: '/api/status', headers: { Host: 'evil.example:4328' } });
  assert.equal(badHost.status, 403);

  // Cross-origin Origin rejection
  const badOrigin = await rawRequest(port, {
    path: '/api/status',
    headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' },
  });
  assert.equal(badOrigin.status, 403);

  // Cross-site Sec-Fetch-Site rejection
  const crossSite = await rawRequest(port, {
    path: '/api/status',
    headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('/api/status never leaks token values and rotates accessId when tokenProvider changes', async t => {
  let currentToken = '';
  const { port } = await startServer(t, { tokenProvider: async () => currentToken });

  const first = await rawRequest(port, { path: '/api/status' });
  const firstBody = JSON.parse(first.body);
  assert.equal(first.status, 200);
  assert.equal(firstBody.authenticated, false);
  assert.equal(typeof firstBody.accessId, 'string');

  currentToken = 'ghp_secret_token_never_leaked_123456';
  const second = await rawRequest(port, { path: '/api/status' });
  const secondBody = JSON.parse(second.body);
  assert.equal(second.status, 200);
  assert.equal(secondBody.authenticated, true);
  assert.notEqual(secondBody.accessId, firstBody.accessId);
  assert.equal(second.body.includes(currentToken), false);
  assert.deepEqual(Object.keys(secondBody).sort(), ['accessId', 'authenticated']);
});

test('POST endpoints enforce content-type (415), payload size limit (413), and JSON syntax (400)', async t => {
  const { port } = await startServer(t, { token: '' });

  const wrongType = await rawRequest(port, {
    method: 'POST',
    path: '/api/scan',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const tooLarge = await rawRequest(port, {
    method: 'POST',
    path: '/api/scan',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'a'.repeat(2100) }),
  });
  assert.equal(tooLarge.status, 413);

  const badJson = await rawRequest(port, {
    method: 'POST',
    path: '/api/scan',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(badJson.status, 400);
});

test('/api/scan streams application/x-ndjson progress + result and rejects concurrent scans with 409', async t => {
  const baseSha = 'c'.repeat(40);
  let releaseUpstream;
  const upstreamGate = new Promise(resolve => {
    releaseUpstream = resolve;
  });

  const fetchImpl = async url => {
    const path = url.replace('https://api.github.com', '');
    if (path === '/repos/acme/stream') {
      await upstreamGate;
      return makeFetchResponse({ full_name: 'acme/stream', default_branch: 'main', private: false, forks_count: 0 });
    }
    if (path === '/repos/acme/stream/commits/main') return makeFetchResponse({ sha: baseSha });
    if (path.startsWith('/repos/acme/stream/forks') || path.startsWith('/repos/acme/stream/pulls')) {
      return makeFetchResponse([]);
    }
    return makeFetchResponse({}, { status: 404 });
  };

  const { port } = await startServer(t, { token: '', fetchImpl });

  const firstPromise = rawRequest(port, {
    method: 'POST',
    path: '/api/scan',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/acme/stream' }),
  });

  // Give the first request a tick to acquire the busy lock
  await new Promise(resolve => setTimeout(resolve, 30));

  const concurrent = await rawRequest(port, {
    method: 'POST',
    path: '/api/scan',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/acme/stream' }),
  });
  assert.equal(concurrent.status, 409);

  releaseUpstream();
  const res = await firstPromise;
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].startsWith('application/x-ndjson'));

  const lines = res.body
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.ok(lines.some(entry => entry.type === 'progress' && entry.phase === 'repository'));
  const finalEvent = lines.at(-1);
  assert.equal(finalEvent.type, 'result');
  assert.equal(finalEvent.data.repository.fullName, 'acme/stream');
  assert.equal(finalEvent.data.repository.sha, baseSha);
});

test('POST endpoints stream an NDJSON error record when validation fails after headers are sent', async t => {
  const { port } = await startServer(t, { token: '' });

  const res = await rawRequest(port, {
    method: 'POST',
    path: '/api/scan',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://evil.example/not-github' }),
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].startsWith('application/x-ndjson'));
  const lines = res.body
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'error');
  assert.equal(lines[0].status, 400);
});
