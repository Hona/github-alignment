use reqwest::header::{HeaderMap, ACCEPT, RETRY_AFTER};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

#[derive(Debug, Clone)]
pub enum Error {
    RateLimited { retry_after: u64 },
    NotFound(String),
    Busy,
    Timeout,
    Upstream(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::RateLimited { retry_after } => write!(
                f,
                "GitHub rate limit hit. Try again in {}s, or paste your own token.",
                retry_after
            ),
            Error::NotFound(what) => write!(f, "{what} not found on GitHub"),
            Error::Busy => write!(f, "Too many people right now. Try again in a moment."),
            Error::Timeout => write!(f, "GitHub took too long. Try again."),
            Error::Upstream(msg) => write!(f, "{msg}"),
        }
    }
}

/// Shared GitHub client: a round-robin token pool that remembers which tokens are
/// rate-limited and until when, plus a global cap on in-flight requests so a traffic
/// spike doesn't trip GitHub's secondary (abuse) limits.
pub struct Client {
    http: reqwest::Client,
    tokens: Vec<String>,
    blocked_until: Mutex<Vec<Option<Instant>>>,
    next: AtomicUsize,
    outbound: Semaphore,
}

/// One user's view of the client. A visitor can bring their own token, which is used
/// instead of the pool and never blocks the pool when it runs out.
pub struct Session {
    client: Arc<Client>,
    user_token: Option<String>,
}

const PREVIEW_DEPENDENCY_GRAPH: &str = "application/vnd.github.hawkgirl-preview+json";

impl Client {
    pub fn new(tokens: Vec<String>, max_outbound: usize) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("github-alignment")
            .timeout(Duration::from_secs(25))
            .pool_max_idle_per_host(32)
            .build()
            .expect("reqwest client");
        Self {
            blocked_until: Mutex::new(vec![None; tokens.len()]),
            tokens,
            http,
            next: AtomicUsize::new(0),
            outbound: Semaphore::new(max_outbound),
        }
    }

    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }

    pub fn session(self: &Arc<Self>, user_token: Option<String>) -> Session {
        Session {
            client: self.clone(),
            user_token: user_token.filter(|t| !t.trim().is_empty()),
        }
    }

    /// Next usable pool token. `Ok(None)` when running unauthenticated.
    fn pick(&self) -> Result<Option<(usize, String)>, Error> {
        if self.tokens.is_empty() {
            return Ok(None);
        }
        let now = Instant::now();
        let mut blocked = self.blocked_until.lock().unwrap();
        let n = self.tokens.len();
        let start = self.next.fetch_add(1, Ordering::Relaxed);
        for k in 0..n {
            let i = (start + k) % n;
            if blocked[i].is_some_and(|until| until > now) {
                continue;
            }
            blocked[i] = None;
            return Ok(Some((i, self.tokens[i].clone())));
        }
        let soonest = blocked.iter().flatten().min().copied().unwrap_or(now);
        Err(Error::RateLimited {
            retry_after: soonest.saturating_duration_since(now).as_secs().max(1),
        })
    }

    fn block(&self, idx: usize, wait: Duration) {
        let mut blocked = self.blocked_until.lock().unwrap();
        blocked[idx] = Some(Instant::now() + wait);
    }
}

/// How long GitHub wants us to wait, if this response says we're limited.
fn limit_wait(status: StatusCode, headers: &HeaderMap) -> Option<Duration> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
    };
    if let Some(secs) = headers
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Some(Duration::from_secs(secs.max(1)));
    }
    if header("x-ratelimit-remaining") == Some(0) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        return Some(Duration::from_secs(
            header("x-ratelimit-reset")
                .unwrap_or(now + 60)
                .saturating_sub(now)
                .max(1),
        ));
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Some(Duration::from_secs(60));
    }
    None
}

impl Session {
    pub fn authenticated(&self) -> bool {
        self.user_token.is_some() || !self.client.tokens.is_empty()
    }

    pub async fn get(&self, path: String) -> Result<Value, Error> {
        let url = format!("https://api.github.com{path}");
        self.send(
            |http| http.get(&url).header(ACCEPT, "application/vnd.github+json"),
            &path,
        )
        .await
    }

    pub async fn graphql(
        &self,
        query: &str,
        variables: Value,
        dependency_graph_preview: bool,
    ) -> Result<Value, Error> {
        let body = json!({ "query": query, "variables": variables });
        let accept = if dependency_graph_preview {
            PREVIEW_DEPENDENCY_GRAPH
        } else {
            "application/json"
        };
        let json = self
            .send(
                |http| {
                    http.post("https://api.github.com/graphql")
                        .header(ACCEPT, accept)
                        .json(&body)
                },
                "graphql",
            )
            .await?;
        Ok(json["data"].clone())
    }

    async fn send(
        &self,
        make: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
        what: &str,
    ) -> Result<Value, Error> {
        let _permit = self
            .client
            .outbound
            .acquire()
            .await
            .map_err(|_| Error::Busy)?;
        for attempt in 0..3u32 {
            let pool_token = if self.user_token.is_some() {
                None
            } else {
                self.client.pick()?
            };
            let token = self
                .user_token
                .clone()
                .or_else(|| pool_token.as_ref().map(|(_, t)| t.clone()));
            let mut req = make(&self.client.http);
            if let Some(t) = &token {
                req = req.bearer_auth(t);
            }
            let res = match req.send().await {
                Ok(res) => res,
                Err(e) if e.is_timeout() => return Err(Error::Timeout),
                Err(e) if attempt < 2 => {
                    eprintln!("retrying {what}: {e}");
                    tokio::time::sleep(Duration::from_millis(300 * (attempt as u64 + 1))).await;
                    continue;
                }
                Err(e) => return Err(Error::Upstream(format!("GitHub unreachable: {e}"))),
            };
            let status = res.status();

            if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
                let from_headers = limit_wait(status, res.headers());
                let body = res.text().await.unwrap_or_default();
                // Secondary (abuse) limits sometimes arrive as a bare 403 with the hint only in the body.
                let wait = from_headers.or_else(|| {
                    body.contains("rate limit")
                        .then_some(Duration::from_secs(60))
                });
                if let Some(wait) = wait {
                    match pool_token {
                        // A pool token ran dry: park it and let the loop try the next one.
                        Some((idx, _)) => {
                            self.client.block(idx, wait);
                            continue;
                        }
                        None => {
                            return Err(Error::RateLimited {
                                retry_after: wait.as_secs(),
                            })
                        }
                    }
                }
                return Err(Error::Upstream(format!(
                    "GitHub {status} for {what}: {}",
                    body.chars().take(200).collect::<String>()
                )));
            }
            if status == StatusCode::NOT_FOUND {
                let subject = what
                    .trim_start_matches('/')
                    .trim_start_matches("users/")
                    .split(['/', '?'])
                    .next()
                    .unwrap_or(what);
                return Err(Error::NotFound(subject.to_string()));
            }
            if status.is_server_error() && attempt < 2 {
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
                continue;
            }
            if !status.is_success() {
                let body = res.text().await.unwrap_or_default();
                return Err(Error::Upstream(format!(
                    "GitHub {status} for {what}: {}",
                    body.chars().take(200).collect::<String>()
                )));
            }

            let headers = res.headers().clone();
            let json: Value = res
                .json()
                .await
                .map_err(|e| Error::Upstream(format!("bad JSON from GitHub for {what}: {e}")))?;
            // GraphQL reports rate limits inside a 200.
            if let Some(errs) = json["errors"].as_array() {
                if errs.iter().any(|e| e["type"] == "RATE_LIMITED") {
                    let wait = limit_wait(status, &headers).unwrap_or(Duration::from_secs(60));
                    match pool_token {
                        Some((idx, _)) => {
                            self.client.block(idx, wait);
                            continue;
                        }
                        None => {
                            return Err(Error::RateLimited {
                                retry_after: wait.as_secs(),
                            })
                        }
                    }
                }
                let messages = errs
                    .iter()
                    .map(|e| e["message"].as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()
                    .join("; ");
                // Aliased batch queries come back with partial data plus errors for the failed
                // aliases (timeouts, missing repos). Keep what worked.
                if json["data"].is_object()
                    && json["data"]
                        .as_object()
                        .is_some_and(|d| d.values().any(|v| !v.is_null()))
                {
                    eprintln!(
                        "graphql partial: {}",
                        messages.chars().take(300).collect::<String>()
                    );
                    return Ok(json);
                }
                if errs.iter().any(|e| e["type"] == "NOT_FOUND") {
                    return Err(Error::NotFound(what.to_string()));
                }
                return Err(Error::Upstream(messages));
            }
            return Ok(json);
        }
        // Out of attempts: if every pool token is parked, say so; otherwise it was GitHub flaking.
        Err(self
            .client
            .pick()
            .err()
            .unwrap_or(Error::Upstream(format!("GitHub kept failing for {what}"))))
    }
}
