import { Session } from "./github.ts"

export type Kind = "pr" | "issue" | "commit" | "sponsor"
export type Item = { kind: Kind; repo: string; title: string; url: string; at: string }
export type RepoInfo = { name: string; stars: number; forks: number; owned: boolean; dependency: boolean; sponsor: boolean }
export type Analysis = {
  login: string
  avatar: string
  orgs: string[]
  items: Item[]
  repos: Record<string, RepoInfo>
  publicOnly: boolean
  window: { days: number; since: string }
  sampled: {
    prs: { total: number; fetched: number }
    issues: { total: number; fetched: number }
    commits: { total: number; fetched: number }
    sponsoring: number
  }
}

type Meta = { stars: number; forks: number; parent?: string }

// Quota budget per analysis, roughly: 3–9 search calls (the scarce one: 30/min/token),
// ~5 REST calls, ~15 GraphQL calls. Everything fan-out shaped goes through aliased GraphQL batches.
export const WINDOW_DAYS = 90
const SEARCH_MAX_PAGES = 3
const DEPENDENCY_SOURCE_REPOS = 12
const DEPENDENCY_CONCURRENCY = 2
const REPO_META_LOOKUPS = 60
const REPO_META_BATCH = 30

const lower = (s: unknown) => String(s ?? "").toLowerCase()
const repoAlias = (i: number, full: string, body: string) => {
  const [owner, name = ""] = full.split("/")
  return `r${i}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) { ${body} }`
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>) {
  const out: R[] = []
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) out.push(await fn(it))
    }),
  )
  return out
}

// GitHub's own dependency graph (Insights → Dependency graph), every ecosystem it knows
// (npm, NuGet, Actions, pip, cargo, go, ...), already resolved to source repos.
// This preview endpoint is slow: aliasing several repos into one query gets 502s, so it's one
// repo per query with low concurrency, and only a handful of repos.
async function dependencyRepos(gh: Session, repos: string[]) {
  if (!gh.authenticated) return new Set<string>()
  const body = "dependencyGraphManifests(first: 10) { nodes { dependencies(first: 60) { nodes { repository { nameWithOwner } } } } }"
  const results = await mapLimit(repos, DEPENDENCY_CONCURRENCY, async (full) => {
    const data = await gh.graphql(`{ ${repoAlias(0, full, body)} }`, {}, true).catch((e: Error) => {
      console.warn(`dependency graph ${full}: ${e.message}`)
      return null
    })
    const manifests: any[] = data?.r0?.dependencyGraphManifests?.nodes ?? []
    return manifests.flatMap((m) => (m.dependencies?.nodes ?? []).map((d: any) => d.repository?.nameWithOwner).filter(Boolean).map(lower))
  })
  return new Set(results.flat() as string[])
}

/** Stars, forks and fork-parent for many repos in one query per 30. */
async function repoMeta(gh: Session, repos: string[], publicOnly: boolean) {
  const out = new Map<string, Meta>()
  if (!gh.authenticated) return out
  const body = "nameWithOwner stargazerCount forkCount isFork isPrivate parent { nameWithOwner stargazerCount forkCount isPrivate }"
  for (let i = 0; i < repos.length; i += REPO_META_BATCH) {
    const chunk = repos.slice(i, i + REPO_META_BATCH)
    const data = await gh.graphql(`{ ${chunk.map((full, j) => repoAlias(j, full, body)).join(" ")} }`).catch((e: Error) => {
      console.warn(`repo meta: ${e.message}`)
      return null
    })
    for (const r of Object.values<any>(data ?? {})) {
      if (!r || (publicOnly && r.isPrivate)) continue
      const parent = r.isFork && r.parent && !(publicOnly && r.parent.isPrivate) ? lower(r.parent.nameWithOwner) : undefined
      if (parent && !out.has(parent)) out.set(parent, { stars: r.parent.stargazerCount ?? 0, forks: r.parent.forkCount ?? 0 })
      out.set(lower(r.nameWithOwner), { stars: r.stargazerCount ?? 0, forks: r.forkCount ?? 0, parent })
    }
  }
  return out
}

/**
 * Everything matching within the window, newest first, up to SEARCH_MAX_PAGES × 100.
 * Returns the items and GitHub's total so the UI can say when we hit the cap.
 */
async function search(gh: Session, query: string, sort: string) {
  const items: any[] = []
  let total = 0
  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    const v = await gh.get(`/search/${query}&sort=${sort}&order=desc&per_page=100&page=${page}`)
    total = v.total_count ?? 0
    const batch: any[] = v.items ?? []
    items.push(...batch)
    if (batch.length < 100 || items.length >= total) break
  }
  return { items, total }
}

// Sponsorships are a bonus signal: any failure here (scopes, limits) degrades to "none" rather
// than failing the analysis. `privacyLevel` needs the read:user scope; without it we fall back to
// the plain list, which can only ever include the *token owner's* own private sponsorships —
// hence the public site should run on a throwaway token that sponsors nobody.
async function sponsoring(gh: Session, login: string, publicOnly: boolean) {
  const none = { totalCount: 0, nodes: [] as { login: string }[] }
  if (!gh.authenticated) return none
  const sponsorable = "sponsorable{ ... on User{login} ... on Organization{login} }"
  const detailed = await gh
    .graphql(`query($login:String!){ user(login:$login){ sponsorshipsAsSponsor(first:100, activeOnly:true){ nodes{ privacyLevel ${sponsorable} } } } }`, { login })
    .then((d) => (d?.user?.sponsorshipsAsSponsor?.nodes ?? []) as any[])
    .catch(() => null)
  const plain =
    detailed ??
    (await gh
      .graphql(`query($login:String!){ user(login:$login){ sponsoring(first:100){ nodes{ ... on User{login} ... on Organization{login} } } } }`, { login })
      .then((d) => ((d?.user?.sponsoring?.nodes ?? []) as any[]).map((n) => ({ privacyLevel: "PUBLIC", sponsorable: n })))
      .catch(() => [] as any[]))
  const nodes = plain
    .filter((n) => !publicOnly || n.privacyLevel === "PUBLIC")
    .map((n) => ({ login: String(n.sponsorable?.login ?? "") }))
    .filter((n) => n.login)
  return { totalCount: nodes.length, nodes }
}

/**
 * `publicOnly` is the deployed-server mode: never let the server's token surface private
 * PRs, issues, commits, org repos or dependency graphs it happens to have access to.
 */
export async function analyze(gh: Session, rawLogin: string, publicOnly: boolean): Promise<Analysis> {
  const vis = publicOnly ? "+is:public" : ""
  const orgType = publicOnly ? "&type=public" : "&type=all"
  // /users/{x}/repos is public-only even for yourself; local mode wants your private repos too.
  const me = publicOnly ? null : await gh.get("/user").catch(() => null)
  const ownReposPath =
    me && lower(me.login) === lower(rawLogin)
      ? "/user/repos?per_page=100&type=owner&sort=pushed"
      : `/users/${rawLogin}/repos?per_page=100&type=owner&sort=pushed`

  const [user, ownRepos, orgs] = await Promise.all([gh.get(`/users/${rawLogin}`), gh.get(ownReposPath), gh.get(`/users/${rawLogin}/orgs?per_page=100`)])
  const login = lower(user.login)

  // "yours" = you + orgs you're a public member of + any @org in your profile company/bio.
  const mentioned = `${user.company ?? ""} ${user.bio ?? ""}`.match(/@[\w-]+/g)?.map((m) => m.slice(1).toLowerCase()) ?? []
  const owners = new Set<string>([login, ...(orgs as any[]).map((o) => lower(o.login)), ...mentioned])

  // Upstream = every repo that your own or work repos depend on, per GitHub's dependency graph.
  // A person's stack repeats across their repos, so a dozen well-chosen ones cover most of it:
  // half the most-starred (real projects), half the most recently pushed (current stack).
  const workRepos = (
    await Promise.all(
      [...owners]
        .filter((o) => o !== login)
        .slice(0, 4)
        .map((o) => gh.get(`/orgs/${o}/repos?per_page=20&sort=pushed${orgType}`).catch(() => [])),
    )
  ).flat() as any[]
  const candidates = [...(ownRepos as any[]), ...workRepos].filter((r) => !r.fork && r.size > 0)
  const byStars = [...candidates].sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0))
  const depSources: string[] = []
  for (const r of [...byStars.slice(0, DEPENDENCY_SOURCE_REPOS / 2), ...candidates]) {
    if (depSources.length >= DEPENDENCY_SOURCE_REPOS) break
    if (!depSources.includes(r.full_name)) depSources.push(r.full_name)
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10)
  const [prs, issues, commits, sponsors, deps] = await Promise.all([
    search(gh, `issues?q=type:pr+author:${login}${vis}+created:>=${since}&advanced_search=true`, "created"),
    search(gh, `issues?q=type:issue+author:${login}${vis}+created:>=${since}&advanced_search=true`, "created"),
    search(gh, `commits?q=author:${login}${vis}+author-date:>=${since}`, "author-date"),
    sponsoring(gh, login, publicOnly),
    dependencyRepos(gh, depSources),
  ])

  const searchItems = (v: any[], kind: Kind): Item[] =>
    v.map((i) => ({ kind, repo: lower(i.repository_url?.split("/repos/")[1]), title: i.title ?? "", url: i.html_url ?? "", at: i.created_at ?? "" }))
  const items: Item[] = [
    ...searchItems(prs.items, "pr"),
    ...searchItems(issues.items, "issue"),
    ...commits.items.map((c: any) => ({
      kind: "commit" as const,
      repo: lower(c.repository?.full_name),
      title: String(c.commit?.message ?? "").split("\n")[0],
      url: c.html_url ?? "",
      at: c.commit?.author?.date ?? "",
    })),
    ...sponsors.nodes.map((n) => ({
      kind: "sponsor" as const,
      repo: `@${n.login}`,
      title: `sponsoring ${n.login}`,
      url: `https://github.com/sponsors/${n.login}`,
      at: "",
    })),
  ]

  // Repo metadata for every touched repo, most-touched first. Forks resolve to their parent,
  // so commits on your fork of X count as work on X.
  const known = new Map<string, Meta>(
    (ownRepos as any[]).filter((r) => !r.fork).map((r) => [lower(r.full_name), { stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0 }]),
  )
  const touches = new Map<string, number>()
  for (const i of items) if (i.kind !== "sponsor" && !known.has(i.repo)) touches.set(i.repo, (touches.get(i.repo) ?? 0) + 1)
  const lookup = [...touches.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, REPO_META_LOOKUPS)
    .map(([n]) => n)
  for (const [k, v] of await repoMeta(gh, lookup, publicOnly)) known.set(k, v)
  for (const i of items) {
    const parent = i.kind !== "sponsor" ? known.get(i.repo)?.parent : undefined
    if (parent) i.repo = parent
  }

  const repos = Object.fromEntries(
    [...new Set(items.map((i) => i.repo))].map((name) => {
      const m = known.get(name)
      return [
        name,
        {
          name,
          stars: m?.stars ?? 0,
          forks: m?.forks ?? 0,
          owned: owners.has(name.split("/")[0]),
          dependency: deps.has(name),
          sponsor: name.startsWith("@"),
        },
      ]
    }),
  )

  return {
    login: user.login,
    avatar: user.avatar_url,
    orgs: [...owners],
    items,
    repos,
    publicOnly,
    window: { days: WINDOW_DAYS, since },
    sampled: {
      prs: { total: prs.total, fetched: prs.items.length },
      issues: { total: issues.total, fetched: issues.items.length },
      commits: { total: commits.total, fetched: commits.items.length },
      sponsoring: sponsors.totalCount,
    },
  }
}
