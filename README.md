# github-alignment

Type a GitHub username. See where you sit on the selfish ↔ selfless line.

```sh
bun install
bun dev        # http://localhost:3000
```

Uses `GITHUB_TOKEN`, else `gh auth token`. Works without either, but search rate limits bite fast.

## The algorithm

Every contribution in your last ~100 PRs, ~100 issues, ~100 commits, plus everyone you sponsor,
gets a **selflessness** score from 0 to 1 based on *who it was for*:

| target | selflessness |
| --- | --- |
| sponsoring someone | 1 |
| a repo your own code depends on (upstreaming) | 1 |
| anyone else's repo | max(0.8, audience) |
| your repo or your org's repo | audience × 0.8 |

`audience = log10(stars + 2·forks + 1) / log10(5000)` clamped to 0..1.

So a private-ish hobby repo of yours is pure selfish, but if your personal project *is*
a widely used package, working on it counts as (mostly) selfless. Same for working at Electron.

Alignment = weighted mean, with PR 1 · issue 0.5 · commit 0.25 · sponsor 2.
Commits on your fork of X count as X. All weights are sliders in the UI.

"Yours" = you plus orgs you're a public member of. Dependencies are read from `package.json`
in your 20 most recent repos and resolved through the npm registry (npm only for now).
