import html from "./ui/index.html"
import { Client } from "./github.ts"
import { createHandler, STALE_OK_FOR, type Cached, type Store } from "./handler.ts"

type Env = {
  GITHUB_TOKENS?: string
  IP_LIMIT?: RateLimit
}

/** Results live in Cloudflare's edge cache for a day; the handler decides fresh vs stale by `at`. */
class EdgeStore implements Store {
  private key = (login: string) => new Request(`https://cache.github-alignment.internal/${login}`)
  async get(login: string) {
    const res = await caches.default.match(this.key(login))
    return res ? ((await res.json()) as Cached) : undefined
  }
  async set(login: string, cached: Cached) {
    await caches.default.put(
      this.key(login),
      new Response(JSON.stringify(cached), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${STALE_OK_FOR}` } }),
    )
  }
}

let handler: ((req: Request) => Promise<Response>) | undefined

export default {
  async fetch(req, env) {
    handler ??= createHandler({
      gh: new Client((env.GITHUB_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean)),
      store: new EdgeStore(),
      html,
      publicOnly: true,
      allowFresh: async (r) => {
        if (!env.IP_LIMIT) return true
        const ip = r.headers.get("cf-connecting-ip") ?? "unknown"
        return (await env.IP_LIMIT.limit({ key: ip })).success
      },
    })
    return handler(req)
  },
} satisfies ExportedHandler<Env>
