# RepoAtlas

[![CI](https://github.com/LaudeDignus/repoatlas/actions/workflows/ci.yml/badge.svg)](https://github.com/LaudeDignus/repoatlas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 22.9](https://img.shields.io/badge/Node.js-%3E%3D22.9-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

**A zero-dependency local web app for exploring public GitHub projects, discovering creators, and comparing real improvements across forks.**

<!-- Screenshot placeholder: add docs/screenshot.png and uncomment the line below
![RepoAtlas interface](docs/screenshot.png)
-->

---

## Why RepoAtlas

When an open-source repository slows down—or attracts an active community—useful fixes and features often live across unmerged pull requests and divergent forks. GitHub makes it hard to inspect those differences at a glance.

RepoAtlas runs locally on `Node.js 22.9+` with **zero runtime and zero dev dependencies**, talking directly to the GitHub REST API from your machine without cloning any repositories or relying on third-party backends.

## Features

### 1. Project Discovery (`/api/discover/projects`)
- **Four discovery modes**:
  - `popular` — recently created repositories (7, 30, or 90 days) ranked by stars.
  - `recent` — recently created repositories sorted locally per page by creation date.
  - `stars` — non-archived original public repositories ranked by cumulative stars.
  - `active` — repositories with recent pushes sorted by GitHub activity.
- **Filters**: free-text keywords (quoted automatically to prevent GitHub search qualifier injection), programming language, minimum stars, SPDX license (`MIT`, `Apache-2.0`, `GPL-3.0`, `BSD-3-Clause`), and pagination.

### 2. Creator Discovery (`/api/discover/people`)
- Search public GitHub developers by self-declared **location**, **name/login**, and **language** (20 profiles per page).
- **Four ranking modes**: `followers`, `repositories`, `starred` (non-archived original public repos with ≥ 1 star among the 20 selected profiles), and `commits` (indexed public commits over 30 or 90 days among the 20 selected profiles).
- Streams live per-profile progress while hydrating profiles and metrics.

### 3. Fork Comparison (`/api/scan`)
- Paste any public `https://github.com/<owner>/<repo>` URL to inspect forks and open pull request branches without cloning.
- **Immutable comparison references**: pins both the upstream base commit SHA and each fork head commit SHA so file and diff links remain exact even if branches advance mid-scan.
- **Fair branch selection**: inspects up to 20 newest forks, 10 most-starred forks, and 30 open non-bot PRs; selects up to 16 branches (at most 10 PR branches via round-robin per fork, then top default branches by push date and stars).
- **Actionable signals**: shows ahead/behind counts, direct GitHub compare/commit/file links, and heuristic keyword classification (`Feature`, `Fix / compatibility`, `Performance`, `Documentation`, `Maintenance`).

### 4. Streaming & Caching
- **NDJSON streaming** (`application/x-ndjson; charset=utf-8`): all POST endpoints stream real-time `{ "type": "progress", ... }` events followed by `{ "type": "result", "data": ... }` (or `{ "type": "error", ... }` on mid-stream failure).
- **Request hygiene**: per-request 42-call budget, 180-second overall abort timeout, client-disconnect cancellation (`AbortController`), single active scan guard (`409 Conflict`), and a 10-minute in-memory cache (max 150 entries) that **never caches errors or private repository responses**.

---

## Quick Start

Requires **Node.js 22.9.0 or later** (uses native `node:http`, `fetch`, `util.parseEnv`, `AbortSignal.any`, `node --env-file-if-exists`, and `node --test`). No `npm install` step is needed.

```sh
git clone https://github.com/LaudeDignus/repoatlas.git
cd repoatlas
npm start
```

Open **http://127.0.0.1:4328** in your browser.

To run on a different port:

```sh
PORT=4329 npm start
```

---

## Optional: GitHub Personal Access Token

Unauthenticated GitHub REST requests have strict hourly rate limits. To increase your read quota, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with **read-only access to public repositories** (no write scopes needed), then run:

```sh
npm run github:token
```

- Uses a muted TTY prompt so pasted characters never echo to `stdout` or terminal history.
- Validates the token against `https://api.github.com/rate_limit` before touching disk.
- Writes `.env` atomically with `0600` permissions (refusing symlinks and preserving unrelated variables).
- Reloads automatically on the running local server without restart (and resets caches/rate state whenever the token changes).

---

## Local-First Security Architecture

Because RepoAtlas can hold a local `GITHUB_TOKEN`, the server applies strict defense-in-depth protections:

| Layer | Implementation |
|---|---|
| **Loopback binding** | Server listens strictly on `127.0.0.1` (`server.mjs`). |
| **DNS-rebinding & CSRF guards** | Rejects non-`localhost` / non-`127.0.0.1` `Host` headers, mismatched `Origin` headers, and `Sec-Fetch-Site: cross-site` requests with `403`. |
| **Strict browser headers** | Sets `Content-Security-Policy` (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`. |
| **Request validation** | Enforces `application/json` content type (`415`), a 2048-byte request body cap (`413`), strict JSON parsing (`400`), and concurrency locking (`409`). |
| **API & query allowlists** | `GitHubClient.get()` allows only specific `/repos/…`, `/search/(repositories\|users\|commits)?…`, and `/users/…` paths, rejects `://`, and uses `redirect: 'error'`. Search terms are quoted to prevent GitHub qualifier injection; repo URLs must be plain `https://github.com/<owner>/<repo>`. |
| **Credential isolation** | Token stays server-side only (`/api/status` returns `{ authenticated, accessId }`, never the token). `.env` is written atomically via `open(..., 'wx', 0o600)` + `rename` after `lstat` confirms it is not a symlink. |
| **Private repo non-caching** | Public responses are cloned into memory for 10 minutes; any response flagged as private (or containing private items) is never cached. |

---

## Architecture

```text
repoatlas/
├── server.mjs               # Local HTTP server, security headers, NDJSON streaming, /api/* routes
├── lib/
│   ├── scan.mjs             # GitHubClient, URL validation, branch selection, fork diff summaries
│   ├── discover.mjs         # Project & people search query builders, allowlists, metric hydration
│   └── token-config.mjs     # Token verification, atomic 0600 .env writer, local token loader
├── scripts/
│   └── github-token.mjs     # Muted interactive CLI to configure GITHUB_TOKEN safely
├── public/                  # Vanilla HTML/CSS/ESM frontend (zero build step)
└── test/                    # Native node:test suite (zero dependencies)
```

---

## Testing

RepoAtlas uses Node.js's built-in test runner (`node --test`) with zero external dependencies:

```sh
npm test
```

You can also syntax-check all JavaScript and ESM modules directly:

```sh
find . -path ./node_modules -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print0 \
  | xargs -0 -n 1 node --check
```

Test coverage includes:
- `test/scan.test.mjs` — repository URL validation, GitHub API path allowlist, private repository non-caching, rate-limit/budget enforcement, round-robin branch selection, comparison summarization, and end-to-end `scanRepository`.
- `test/discover.test.mjs` — project/people filter allowlists, search qualifier injection quoting, pagination/sorting semantics, and `discoverProjects` / `discoverPeople` hydration and warnings.
- `test/token-config.test.mjs` — `.env` token replacement, atomic `0600` writes, symlink/directory refusal, API validation failures, and `readLocalToken` fallback behavior.
- `test/server.test.mjs` — Host/Origin/`Sec-Fetch-Site` blocking, CSP & security headers, `/api/status` token non-disclosure and hot-reload invalidation, payload/content-type/concurrency limits, and NDJSON streaming (success and mid-stream error handling).

---

## Limitations & Transparency

- **Public repositories only**: RepoAtlas rejects private upstream repositories and never caches private API payloads.
- **Sampling, not an exhaustive crawl**: fork analysis inspects at most 20 newest forks, 10 most-starred forks, and 30 open PRs, then compares up to 16 branches (max 10 PR branches) within a 42-request budget per scan.
- **Scoped developer rankings**: `starred` and `commits` modes compare only the 20 profiles on the current page (pre-selected by followers)—they are not global leaderboards. Commit counts reflect GitHub-indexed commits on default branches only.
- **Self-declared locations**: developer locations come directly from GitHub profile text without geolocation verification.
- **Heuristic classification**: commit/PR categories are derived from keyword matching; no AI model is called and no fork code is executed or verified.
- **GitHub rate limits**: standard GitHub REST and Search API quotas apply even when authenticated.
- **UI language**: the current web interface (`public/`) is written in French.

---

## License

[MIT](LICENSE)
