// Auth: GITHUB_TOKEN, else whatever `gh auth login` has. Unauthenticated works but hits search limits fast.
const token = process.env.GITHUB_TOKEN || Bun.spawnSync(["gh", "auth", "token"]).stdout.toString().trim()

const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "github-alignment",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

async function gh(path: string) {
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function graphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch("https://api.github.com/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) })
  const json = await res.json()
  if (json.errors) throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "))
  return json.data
}

// npm package name -> "owner/repo" on GitHub, or null
async function npmRepo(name: string) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`).catch(() => null)
  if (!res?.ok) return null
  const json = await res.json().catch(() => null)
  const m = String(json?.repository?.url ?? "").match(/github\.com[/:]([^/]+)\/([^/#.]+)/i)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

type Item = { kind: "pr" | "issue" | "commit" | "sponsor"; repo: string; title: string; url: string; at: string }

async function analyze(login: string) {
  const [user, ownRepos, orgs] = await Promise.all([
    gh(`/users/${login}`),
    gh(`/users/${login}/repos?per_page=100&type=owner&sort=pushed`),
    gh(`/users/${login}/orgs?per_page=100`),
  ])
  // "yours" = you + orgs you're a public member of. This is the "work repos" heuristic.
  const owners = new Set<string>([user.login.toLowerCase(), ...orgs.map((o: { login: string }) => o.login.toLowerCase())])

  // Dependencies of your own code (npm only for the PoC): package.json of your 20 most recently pushed non-fork repos.
  const manifests = await Promise.all(
    ownRepos
      .filter((r: { fork: boolean }) => !r.fork)
      .slice(0, 20)
      .map((r: { full_name: string; default_branch: string }) =>
        fetch(`https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/package.json`)
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null),
      ),
  )
  const pkgs = [...new Set(manifests.filter(Boolean).flatMap((m) => Object.keys({ ...m.dependencies, ...m.devDependencies })))]
  const deps = new Set((await Promise.all(pkgs.slice(0, 120).map(npmRepo))).filter((x): x is string => !!x))

  const q = (extra: string) => `/search/${extra}&per_page=100&advanced_search=true`
  const [prs, issues, commits, sponsoring] = await Promise.all([
    gh(q(`issues?q=type:pr+author:${login}&sort=created&order=desc`)),
    gh(q(`issues?q=type:issue+author:${login}&sort=created&order=desc`)),
    gh(`/search/commits?q=author:${login}&per_page=100&sort=author-date&order=desc`),
    token
      ? graphql(
          `query($login:String!){ user(login:$login){ sponsoring(first:100){ totalCount nodes{ ... on User{login} ... on Organization{login} } } } }`,
          { login },
        ).then((d) => d.user.sponsoring)
      : { totalCount: 0, nodes: [] },
  ])

  const items: Item[] = [
    ...prs.items.map((i: any) => ({ kind: "pr", repo: i.repository_url.split("/repos/")[1].toLowerCase(), title: i.title, url: i.html_url, at: i.created_at })),
    ...issues.items.map((i: any) => ({ kind: "issue", repo: i.repository_url.split("/repos/")[1].toLowerCase(), title: i.title, url: i.html_url, at: i.created_at })),
    ...commits.items.map((c: any) => ({ kind: "commit", repo: c.repository.full_name.toLowerCase(), title: c.commit.message.split("\n")[0], url: c.html_url, at: c.commit.author.date })),
    ...sponsoring.nodes.map((n: any) => ({ kind: "sponsor", repo: `@${n.login}`, title: `sponsoring ${n.login}`, url: `https://github.com/sponsors/${n.login}`, at: "" })),
  ]

  // Repo metadata for every touched repo. Forks are re-fetched to learn their parent, so
  // commits on your fork of X count as work on X.
  const known = new Map<string, any>(ownRepos.map((r: any) => [r.full_name.toLowerCase(), r]))
  const names = [...new Set(items.filter((i) => i.kind !== "sponsor").map((i) => i.repo))]
  const fetched = await Promise.all(
    names
      .filter((n) => !known.has(n) || known.get(n).fork)
      .slice(0, 80)
      .map((n) => gh(`/repos/${n}`).catch(() => null)),
  )
  fetched.filter(Boolean).forEach((r) => {
    known.set(r.full_name.toLowerCase(), r)
    if (r.parent) known.set(r.parent.full_name.toLowerCase(), r.parent)
  })
  const canonical = (name: string) => {
    const r = known.get(name)
    return r?.fork && r.parent ? r.parent.full_name.toLowerCase() : name
  }
  items.forEach((i) => {
    if (i.kind !== "sponsor") i.repo = canonical(i.repo)
  })

  const repos = Object.fromEntries(
    [...new Set(items.map((i) => i.repo))].map((name) => {
      const r = known.get(name)
      return [
        name,
        {
          name,
          stars: r?.stargazers_count ?? 0,
          forks: r?.forks_count ?? 0,
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
    dependencies: [...deps],
    items,
    repos,
    sampled: { prs: prs.total_count, issues: issues.total_count, commits: commits.total_count, sponsoring: sponsoring.totalCount },
  }
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>()

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 120,
  routes: {
    "/": () => new Response(Bun.file(new URL("./public/index.html", import.meta.url))),
    "/api/:login": async (req) => {
      const login = req.params.login.toLowerCase()
      const hit = cache.get(login)
      const entry = hit && Date.now() - hit.at < 10 * 60_000 ? hit : { at: Date.now(), value: analyze(login) }
      cache.set(login, entry)
      return entry.value.then(
        (v) => Response.json(v),
        (e) => {
          cache.delete(login)
          return Response.json({ error: String(e.message ?? e) }, { status: 500 })
        },
      )
    },
  },
})

console.log(`github-alignment → ${server.url}${token ? "" : "  (no token: search limits are tight)"}`)
