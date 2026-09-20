# github-alignment

Are you selfish or selfless on GitHub? One line, one dot. **https://github-alignment.hona.dev**

```sh
npx github-alignment            # you, with your own `gh` login — private repos count, no shared rate limit
npx github-alignment torvalds   # someone else
```

The public site only sees public data and shares one GitHub quota with everyone. The npx command
runs the *same* UI on `localhost:3000` against your own `gh auth login` (or `GITHUB_TOKEN`).

## The algorithm

Every PR, issue and commit you authored in the **last 90 days** (up to 300 of each on the site, 1000 via npx), plus everyone
you sponsor, gets a **selflessness** score from 0 to 1 based on *who it was for*:

| target | selflessness |
| --- | --- |
| sponsoring someone | 1 |
| a repo your code depends on (upstreaming) | 1 |
| anyone else's repo | max(0.8, audience) |
| your repo or your org's repo | audience × 0.8 |

`audience = log10(stars + 2·forks + 1) / log10(5000)` clamped to 0..1.

So a hobby repo of yours nobody uses is pure selfish, but if your personal project *is* a widely
used package, working on it counts as (mostly) selfless. Same for working at Electron.

Alignment = weighted mean, with PR 1 · issue 0.5 · commit 0.25 · sponsor 2. Commits on your fork
of X count as X. All weights are sliders in the UI. The sparkline is a 14-day rolling mean.

- **Yours** = you, orgs you're a public member of, and any `@org` in your profile company/bio.
- **Upstream** = GitHub's own dependency graph (npm, NuGet, Actions, pip, cargo, go…) for a dozen of
  your repos: half most-starred, half most recently pushed.

## Layout

```
src/analyze.ts   the algorithm            (shared)
src/github.ts    token pool, rate limits  (shared)
src/handler.ts   HTTP: cache, dedupe, backpressure (shared, Request → Response)
src/ui/          the page
src/worker.ts    Cloudflare Worker  → github-alignment.hona.dev   (public data only)
src/cli.ts       npx github-alignment → localhost                 (your login, private included)
```

```sh
npm run dev      # wrangler dev, reads GITHUB_TOKENS from .dev.vars
npm run cli      # run the CLI from source
npm run build    # dist/cli.js
```

## Surviving a spike

GitHub search is 30 requests/min per token and each analysis needs 3–9, so ~5 fresh analyses a
minute per token is the public site's hard ceiling. Everything is built around that:

- **Token pool** (`GITHUB_TOKENS`, comma-separated), round-robin; a token that hits a limit is parked
  until GitHub's reset. Honors `Retry-After`, `X-RateLimit-Reset`, GraphQL `RATE_LIMITED`, and
  secondary-limit 403s that only say so in the body.
- **Public data only** on the site, enforced in queries (`is:public`, `type=public`, `isPrivate`),
  so the server token can't leak anything. Use tokens with no permissions anyway.
- **Edge cache** 1h fresh / 24h stale-on-error, shared across the Cloudflare location.
- **In-flight dedupe**: a viral username is analysed once per isolate; everyone waiting shares it.
- **Bounded**: 8 concurrent analyses, 24 outbound requests, 6 fresh lookups/min/IP, 90s per analysis.
- Errors are JSON `{ error, code, retryAfter }` with `429/404/503/504/502` and `Retry-After`; the UI
  counts down, retries, and points at the npx command.
- The real scale lever is `npx github-alignment`: every person brings their own quota.

## Ship

```sh
npm version patch && git push --follow-tags   # → npm publish + wrangler deploy (see .github/workflows/release.yml)
```
