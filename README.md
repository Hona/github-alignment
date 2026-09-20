# github-alignment

Type a GitHub username. See where you sit on the selfish ↔ selfless line.

```sh
cargo run --release        # http://localhost:3000
```

| env | default | what |
| --- | --- | --- |
| `GITHUB_TOKENS` / `GITHUB_TOKEN` | `gh auth token` | comma-separated token pool |
| `PORT` | `3000` | |
| `MAX_ANALYSES` | `8` | concurrent analyses; more wait up to 20s then get `503 busy` |
| `MAX_OUTBOUND` | `24` | concurrent requests to GitHub |
| `PER_IP_PER_MINUTE` | `6` | uncached lookups per IP |

## The algorithm

Every contribution in your last ~100 PRs, ~100 issues, ~100 commits, plus everyone you sponsor,
gets a **selflessness** score from 0 to 1 based on *who it was for*:

| target | selflessness |
| --- | --- |
| sponsoring someone | 1 |
| a repo your code depends on (upstreaming) | 1 |
| anyone else's repo | max(0.8, audience) |
| your repo or your org's repo | audience × 0.8 |

`audience = log10(stars + 2·forks + 1) / log10(5000)` clamped to 0..1.

So a hobby repo of yours nobody uses is pure selfish, but if your personal project *is*
a widely used package, working on it counts as (mostly) selfless. Same for working at Electron.

Alignment = weighted mean, with PR 1 · issue 0.5 · commit 0.25 · sponsor 2.
Commits on your fork of X count as X. All weights are sliders in the UI.

- **Yours** = you, orgs you're a public member of, and any `@org` in your profile company/bio.
- **Upstream** = GitHub's own dependency graph (every ecosystem: npm, NuGet, Actions, pip, cargo, go…)
  for a dozen of your repos: half most-starred, half most recently pushed.

## Surviving a spike

GitHub search is 30 requests/min per token and each analysis needs 3, so ~10 fresh analyses a
minute per token is the hard ceiling. Everything else is built around that:

- **Token pool**, round-robin; a token that hits a limit is parked until GitHub's reset time.
  Honors `Retry-After` and `X-RateLimit-Reset`, including GraphQL `RATE_LIMITED` inside a 200.
- **Bring your own token**: paste one in the UI, it's sent as `X-GitHub-Token`, used only for that
  request, never parks the pool, and bypasses the per-IP limit.
- **Cache** 1h fresh / 24h stale. If GitHub is failing and we have a stale answer, you get the stale answer.
- **In-flight dedupe**: a viral username analysed once, everyone waiting on it shares the result.
- **Bounded**: concurrent analyses, outbound requests, per-IP, 90s per analysis, 20k cache entries.
- **CDN-friendly**: `Cache-Control: public, max-age=600, stale-while-revalidate=3600` on fresh answers;
  put Cloudflare in front and a viral name costs GitHub quota once.
- Errors are JSON `{ error, code, retryAfter }` with proper status (`429`, `404`, `503`, `504`, `502`)
  and a `Retry-After` header. The UI counts down and retries.
- `/healthz` shows tokens, cache size, in-flight analyses, free slots.
