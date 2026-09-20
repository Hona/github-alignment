import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import html from "./ui/index.html"
import { Client } from "./github.ts"
import { createHandler, MemoryStore } from "./handler.ts"

const args = process.argv.slice(2)
if (args.includes("-h") || args.includes("--help")) {
  console.log(`github-alignment [username] [--port 3000] [--public] [--no-open]

Runs the github-alignment UI on your machine using your own GitHub login
(GITHUB_TOKEN, or whatever \`gh auth login\` set up). Private repos count.

  --public    behave like the public site: public data only
  --no-open   don't open the browser
`)
  process.exit(0)
}
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args.splice(i, 1), true) : false
}
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const port = Number(opt("--port") ?? process.env.PORT ?? 3000)
const publicOnly = flag("--public")
const noOpen = flag("--no-open")
const username = args.find((a: string) => !a.startsWith("-"))

const token =
  process.env.GITHUB_TOKEN?.trim() ||
  (() => {
    try {
      return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
      return ""
    }
  })()
if (!token) {
  console.error("No GitHub login found. Run `gh auth login` (https://cli.github.com) or set GITHUB_TOKEN.")
  process.exit(1)
}

const gh = new Client([token])
const login =
  username ??
  (await gh
    .session()
    .get("/user")
    .then((u) => u.login as string)
    .catch(() => undefined))

const handler = createHandler({ gh, store: new MemoryStore(), html, publicOnly })

const server = createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])) as [string, string][],
  })
  const response = await handler(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
})

server.listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}/${login ? `?u=${encodeURIComponent(login)}` : ""}`
  console.log(`github-alignment → ${url}  (${publicOnly ? "public data only" : "including your private repos"}, your own rate limit)`)
  if (noOpen) return
  const [cmd, ...pre] = process.platform === "win32" ? ["cmd", "/c", "start", ""] : process.platform === "darwin" ? ["open"] : ["xdg-open"]
  spawn(cmd, [...pre, url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
})
