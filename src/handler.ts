import { analyze, type Analysis } from "./analyze.ts"
import { Client, GitHubError, Semaphore, timeout, upstream } from "./github.ts"

export const FRESH_FOR = 60 * 60
export const STALE_OK_FOR = 24 * 60 * 60
const ANALYSIS_TIMEOUT = 90_000
const QUEUE_WAIT = 20_000

export type Cached = { at: number; value: Analysis }

/** Where finished analyses live: Cache API on Workers, a Map locally. */
export interface Store {
  get(login: string): Promise<Cached | undefined>
  set(login: string, cached: Cached): Promise<void>
}

export type Options = {
  gh: Client
  store: Store
  html: string
  publicOnly: boolean
  maxAnalyses?: number
  /** Return false to refuse a fresh (uncached) analysis for this request. */
  allowFresh?: (req: Request) => Promise<boolean>
}

export class MemoryStore implements Store {
  private map = new Map<string, Cached>()
  constructor(private max = 20_000) {}
  async get(login: string) {
    const hit = this.map.get(login)
    if (hit && Date.now() / 1000 - hit.at > STALE_OK_FOR) this.map.delete(login)
    return this.map.get(login)
  }
  async set(login: string, cached: Cached) {
    if (this.map.size >= this.max) {
      for (const [k, v] of this.map) if (Date.now() / 1000 - v.at > FRESH_FOR) this.map.delete(k)
      if (this.map.size >= this.max) this.map.clear()
    }
    this.map.set(login, cached)
  }
  get size() {
    return this.map.size
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })

function errorResponse(e: unknown) {
  const err = e instanceof GitHubError ? e : upstream(e instanceof Error ? e.message : String(e))
  const status = { rate_limited: 429, not_found: 404, busy: 503, timeout: 504, upstream: 502 }[err.code]
  return json(
    { error: err.message, code: err.code, retryAfter: err.retryAfter ?? null },
    status,
    { "cache-control": "no-store", ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) },
  )
}

function okResponse(cached: Cached, stale: boolean) {
  // Fresh answers are safe for a CDN to hold: a viral username should cost GitHub quota once.
  return json({ ...cached.value, cachedAt: cached.at, stale }, 200, {
    "cache-control": stale ? "public, max-age=60" : "public, max-age=600, stale-while-revalidate=3600",
  })
}

export function createHandler(opts: Options) {
  const analyses = new Semaphore(opts.maxAnalyses ?? 8)
  const inflight = new Map<string, Promise<Cached>>()

  // One analysis per username at a time; concurrent requests for the same name share it.
  const run = (login: string, userToken?: string) => {
    const existing = inflight.get(login)
    if (existing) return existing
    const p = (async () => {
      const release = await analyses.acquire(QUEUE_WAIT)
      try {
        const gh = opts.gh.session(userToken)
        const value = await Promise.race([
          analyze(gh, login, opts.publicOnly),
          new Promise<never>((_, reject) => setTimeout(() => reject(timeout()), ANALYSIS_TIMEOUT)),
        ])
        const cached = { at: Math.floor(Date.now() / 1000), value }
        await opts.store.set(login, cached)
        return cached
      } finally {
        release()
        inflight.delete(login)
      }
    })()
    inflight.set(login, p)
    return p
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 })

    if (url.pathname === "/") {
      return new Response(opts.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } })
    }
    if (url.pathname === "/healthz") {
      return json({ ok: true, tokens: opts.gh.tokenCount, publicOnly: opts.publicOnly, inflight: inflight.size, freeSlots: analyses.free })
    }
    const m = url.pathname.match(/^\/api\/([^/]+)$/)
    if (!m) return new Response("not found", { status: 404 })

    const login = decodeURIComponent(m[1]).trim().replace(/^@/, "").toLowerCase()
    if (!/^[a-z0-9-]{1,39}$/.test(login)) return json({ error: "that's not a GitHub username", code: "bad_login" }, 400)

    const hit = await opts.store.get(login)
    const age = hit ? Date.now() / 1000 - hit.at : Infinity
    if (hit && age <= FRESH_FOR) return okResponse(hit, false)

    const userToken = req.headers.get("x-github-token")?.trim() || undefined
    // Joining an analysis someone else already started is free; only new work counts against the caller.
    if (!inflight.has(login) && !userToken && opts.allowFresh && !(await opts.allowFresh(req))) {
      return errorResponse(new GitHubError("rate_limited", "Slow down a little. Try again in a minute, or run it locally.", 60))
    }

    try {
      return okResponse(await run(login, userToken), false)
    } catch (e) {
      // GitHub is unhappy but we remember an older answer: better than an error page.
      if (hit && age <= STALE_OK_FOR && !(e instanceof GitHubError && e.code === "not_found")) return okResponse(hit, true)
      if (!(e instanceof GitHubError)) console.error(e)
      return errorResponse(e)
    }
  }
}
