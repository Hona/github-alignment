export type ErrorCode = "rate_limited" | "not_found" | "busy" | "timeout" | "upstream"

export class GitHubError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryAfter?: number,
  ) {
    super(message)
  }
}

export const rateLimited = (retryAfter: number) =>
  new GitHubError("rate_limited", `GitHub rate limit hit. Try again in ${retryAfter}s, or run it locally with your own login.`, retryAfter)
export const notFound = (what: string) => new GitHubError("not_found", `${what} not found on GitHub`)
export const busy = () => new GitHubError("busy", "Too many people right now. Try again in a moment.", 15)
export const timeout = () => new GitHubError("timeout", "GitHub took too long. Try again.", 30)
export const upstream = (msg: string) => new GitHubError("upstream", msg, 30)

/** Async counting semaphore. */
export class Semaphore {
  private waiters: Array<() => void> = []
  constructor(public free: number) {}
  acquire(ms?: number): Promise<() => void> {
    const release = () => {
      const next = this.waiters.shift()
      if (next) next()
      else this.free++
    }
    if (this.free > 0) {
      this.free--
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve(release)
      }
      const timer = ms === undefined ? undefined : setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== grant)
        reject(busy())
      }, ms)
      this.waiters.push(grant)
    })
  }
}

const DEPENDENCY_GRAPH_PREVIEW = "application/vnd.github.hawkgirl-preview+json"

/** How long GitHub wants us to wait, if this response says we're limited. */
function limitWait(status: number, headers: Headers, body: string) {
  const retryAfter = Number(headers.get("retry-after"))
  if (retryAfter > 0) return retryAfter
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset")) || Math.floor(Date.now() / 1000) + 60
    return Math.max(1, reset - Math.floor(Date.now() / 1000))
  }
  if (status === 429) return 60
  // Secondary (abuse) limits sometimes arrive as a bare 403 with the hint only in the body.
  if (body.includes("rate limit")) return 60
  return undefined
}

/**
 * Shared GitHub client: a round-robin token pool that remembers which tokens are rate-limited
 * and until when, plus a cap on in-flight requests so a spike doesn't trip GitHub's secondary limits.
 */
export class Client {
  private blockedUntil: number[]
  private next = 0
  private outbound: Semaphore

  constructor(
    private tokens: string[],
    maxOutbound = 24,
  ) {
    this.blockedUntil = tokens.map(() => 0)
    this.outbound = new Semaphore(maxOutbound)
  }

  get tokenCount() {
    return this.tokens.length
  }

  /** A visitor can bring their own token: used instead of the pool, never parks the pool. */
  session(userToken?: string) {
    return new Session(this, userToken?.trim() || undefined)
  }

  /** Next usable pool token index, or -1 when unauthenticated. Throws rate_limited if all are parked. */
  pick() {
    if (!this.tokens.length) return -1
    const now = Date.now()
    const n = this.tokens.length
    const start = this.next++
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n
      if (this.blockedUntil[i] <= now) return i
    }
    const soonest = Math.min(...this.blockedUntil)
    throw rateLimited(Math.max(1, Math.ceil((soonest - now) / 1000)))
  }

  token(i: number) {
    return this.tokens[i]
  }

  block(i: number, seconds: number) {
    this.blockedUntil[i] = Date.now() + seconds * 1000
  }

  async send(session: Session, make: () => Request, what: string): Promise<any> {
    const release = await this.outbound.acquire()
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const poolIdx = session.userToken ? -1 : this.pick()
        const token = session.userToken ?? (poolIdx >= 0 ? this.tokens[poolIdx] : undefined)
        const req = make()
        if (token) req.headers.set("authorization", `Bearer ${token}`)
        req.headers.set("user-agent", "github-alignment")

        const res = await fetch(req, { signal: AbortSignal.timeout(25_000) }).catch((e: Error) => e)
        if (res instanceof Error) {
          if (res.name === "TimeoutError" || res.name === "AbortError") throw timeout()
          if (attempt < 2) {
            await sleep(300 * (attempt + 1))
            continue
          }
          throw upstream(`GitHub unreachable: ${res.message}`)
        }

        if (res.status === 403 || res.status === 429) {
          const body = await res.text()
          const wait = limitWait(res.status, res.headers, body)
          if (wait !== undefined) {
            if (poolIdx >= 0) {
              // A pool token ran dry: park it and let the loop try the next one.
              this.block(poolIdx, wait)
              continue
            }
            throw rateLimited(wait)
          }
          throw upstream(`GitHub ${res.status} for ${what}: ${body.slice(0, 200)}`)
        }
        if (res.status === 404) {
          throw notFound(what.replace(/^\/?(users\/)?/, "").split(/[/?]/)[0] || what)
        }
        if (res.status >= 500 && attempt < 2) {
          await sleep(500 * (attempt + 1))
          continue
        }
        if (!res.ok) throw upstream(`GitHub ${res.status} for ${what}: ${(await res.text()).slice(0, 200)}`)

        const json: any = await res.json().catch(() => {
          throw upstream(`bad JSON from GitHub for ${what}`)
        })
        // GraphQL reports rate limits inside a 200.
        if (Array.isArray(json.errors)) {
          if (json.errors.some((e: any) => e.type === "RATE_LIMITED")) {
            const wait = limitWait(res.status, res.headers, "") ?? 60
            if (poolIdx >= 0) {
              this.block(poolIdx, wait)
              continue
            }
            throw rateLimited(wait)
          }
          const messages = json.errors.map((e: any) => e.message).join("; ")
          // Aliased batch queries come back with partial data plus errors for the failed aliases. Keep what worked.
          if (json.data && Object.values(json.data).some((v) => v !== null)) {
            console.warn("graphql partial:", messages.slice(0, 300))
            return json
          }
          if (json.errors.some((e: any) => e.type === "NOT_FOUND")) throw notFound(what)
          throw upstream(messages)
        }
        return json
      }
      // Out of attempts: if every pool token is parked, say so; otherwise it was GitHub flaking.
      this.pick()
      throw upstream(`GitHub kept failing for ${what}`)
    } finally {
      release()
    }
  }
}

export class Session {
  constructor(
    private client: Client,
    public userToken?: string,
  ) {}

  get authenticated() {
    return !!this.userToken || this.client.tokenCount > 0
  }

  get(path: string): Promise<any> {
    return this.client.send(
      this,
      () => new Request(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json" } }),
      path,
    )
  }

  async graphql(query: string, variables: Record<string, unknown> = {}, dependencyGraphPreview = false): Promise<any> {
    const json = await this.client.send(
      this,
      () =>
        new Request("https://api.github.com/graphql", {
          method: "POST",
          headers: { accept: dependencyGraphPreview ? DEPENDENCY_GRAPH_PREVIEW : "application/json", "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
        }),
      "graphql",
    )
    return json.data
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
