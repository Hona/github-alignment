mod analyze;
mod github;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures::future::{BoxFuture, FutureExt, Shared};
use github::Error;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

const FRESH_FOR: Duration = Duration::from_secs(60 * 60);
const STALE_OK_FOR: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CACHE_ENTRIES: usize = 20_000;
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(90);
const QUEUE_WAIT: Duration = Duration::from_secs(20);

type Pending = Shared<BoxFuture<'static, Result<Arc<Value>, Error>>>;

struct Cached {
    at: Instant,
    unix: u64,
    value: Arc<Value>,
}

struct App {
    gh: Arc<github::Client>,
    analyses: Arc<Semaphore>,
    cache: Mutex<HashMap<String, Cached>>,
    inflight: Mutex<HashMap<String, Pending>>,
    ips: Mutex<HashMap<IpAddr, (Instant, u32)>>,
    per_ip_per_minute: u32,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn error_response(e: &Error) -> Response {
    let (status, code) = match e {
        Error::RateLimited { .. } => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
        Error::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        Error::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
        Error::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timeout"),
        Error::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream"),
    };
    let retry_after = match e {
        Error::RateLimited { retry_after } => Some(*retry_after),
        Error::Busy => Some(15),
        Error::Timeout | Error::Upstream(_) => Some(30),
        Error::NotFound(_) => None,
    };
    let mut res = (
        status,
        Json(json!({ "error": e.to_string(), "code": code, "retryAfter": retry_after })),
    )
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(secs) = retry_after {
        res.headers_mut().insert(
            header::RETRY_AFTER,
            HeaderValue::from_str(&secs.to_string()).unwrap(),
        );
    }
    res
}

fn ok_response(value: &Value, cached_unix: u64, stale: bool) -> Response {
    let mut body = value.clone();
    body["cachedAt"] = json!(cached_unix);
    body["stale"] = json!(stale);
    let mut res = Json(body).into_response();
    // Fresh answers are safe for a CDN to hold: a viral username should cost GitHub quota once.
    let cc = if stale {
        "public, max-age=60"
    } else {
        "public, max-age=600, stale-while-revalidate=3600"
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
    res
}

fn client_ip(headers: &HeaderMap, addr: SocketAddr) -> IpAddr {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(addr.ip())
}

impl App {
    fn cached(&self, login: &str) -> Option<(Arc<Value>, u64, bool)> {
        let cache = self.cache.lock().unwrap();
        let hit = cache.get(login)?;
        let age = hit.at.elapsed();
        if age > STALE_OK_FOR {
            return None;
        }
        Some((hit.value.clone(), hit.unix, age > FRESH_FOR))
    }

    fn store(&self, login: String, value: Arc<Value>) {
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.retain(|_, c| c.at.elapsed() < FRESH_FOR);
            if cache.len() >= MAX_CACHE_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(
            login,
            Cached {
                at: Instant::now(),
                unix: now_unix(),
                value,
            },
        );
    }

    /// Fixed one-minute window per IP. Only uncached lookups count.
    fn allow_ip(&self, ip: IpAddr) -> bool {
        let mut ips = self.ips.lock().unwrap();
        if ips.len() > 50_000 {
            ips.retain(|_, (start, _)| start.elapsed() < Duration::from_secs(60));
        }
        let entry = ips.entry(ip).or_insert((Instant::now(), 0));
        if entry.0.elapsed() >= Duration::from_secs(60) {
            *entry = (Instant::now(), 0);
        }
        entry.1 += 1;
        entry.1 <= self.per_ip_per_minute
    }

    /// One analysis per username at a time; concurrent requests for the same name share it.
    fn analysis(self: &Arc<Self>, login: String, user_token: Option<String>) -> Pending {
        let mut inflight = self.inflight.lock().unwrap();
        if let Some(pending) = inflight.get(&login) {
            return pending.clone();
        }
        let app = self.clone();
        let key = login.clone();
        let fut = async move {
            let _slot = tokio::time::timeout(QUEUE_WAIT, app.analyses.clone().acquire_owned())
                .await
                .map_err(|_| Error::Busy)?
                .map_err(|_| Error::Busy)?;
            let gh = app.gh.session(user_token);
            let result = tokio::time::timeout(ANALYSIS_TIMEOUT, analyze::analyze(&gh, &login))
                .await
                .unwrap_or(Err(Error::Timeout))
                .map(Arc::new);
            if let Ok(v) = &result {
                app.store(login.clone(), v.clone());
            }
            app.inflight.lock().unwrap().remove(&login);
            result
        }
        .boxed()
        .shared();
        inflight.insert(key, fut.clone());
        fut
    }
}

async fn api(
    State(app): State<Arc<App>>,
    Path(login): Path<String>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let login = login.trim().trim_start_matches('@').to_lowercase();
    if login.is_empty()
        || login.len() > 39
        || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "that's not a GitHub username", "code": "bad_login" })),
        )
            .into_response();
    }

    if let Some((value, unix, false)) = app.cached(&login) {
        return ok_response(&value, unix, false);
    }

    let user_token = headers
        .get("x-github-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Joining an analysis someone else already started is free; only new work counts against the IP.
    let joining = app.inflight.lock().unwrap().contains_key(&login);
    if !joining && user_token.is_none() && !app.allow_ip(client_ip(&headers, addr)) {
        return error_response(&Error::RateLimited { retry_after: 60 });
    }

    match app.analysis(login.clone(), user_token).await {
        Ok(value) => ok_response(&value, now_unix(), false),
        // GitHub is unhappy but we remember an older answer: better than an error page.
        Err(e) => match app.cached(&login) {
            Some((value, unix, _)) if !matches!(e, Error::NotFound(_)) => {
                ok_response(&value, unix, true)
            }
            _ => error_response(&e),
        },
    }
}

async fn index() -> Response {
    let mut res = Html(include_str!("../public/index.html")).into_response();
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    res
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "tokens": app.gh.token_count(),
        "cached": app.cache.lock().unwrap().len(),
        "inflight": app.inflight.lock().unwrap().len(),
        "freeSlots": app.analyses.available_permits(),
    }))
}

#[tokio::main]
async fn main() {
    // Auth: GITHUB_TOKENS (comma-separated pool) or GITHUB_TOKEN, else whatever `gh auth login` has.
    let tokens: Vec<String> = std::env::var("GITHUB_TOKENS")
        .or_else(|_| std::env::var("GITHUB_TOKEN"))
        .ok()
        .map(|v| {
            v.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::process::Command::new("gh")
                .args(["auth", "token"])
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|t| !t.is_empty())
                .map(|t| vec![t])
        })
        .unwrap_or_default();
    let env_num = |k: &str, d: usize| {
        std::env::var(k)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(d)
    };
    let note = match tokens.len() {
        0 => "  (no token: search limits are tight)".to_string(),
        n => format!("  ({n} token{})", if n == 1 { "" } else { "s" }),
    };

    let app = Arc::new(App {
        gh: Arc::new(github::Client::new(tokens, env_num("MAX_OUTBOUND", 24))),
        analyses: Arc::new(Semaphore::new(env_num("MAX_ANALYSES", 8))),
        cache: Default::default(),
        inflight: Default::default(),
        ips: Default::default(),
        per_ip_per_minute: env_num("PER_IP_PER_MINUTE", 6) as u32,
    });

    let router = Router::new()
        .route("/", get(index))
        .route("/healthz", get(health))
        .route("/api/{login}", get(api))
        .with_state(app);
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind");
    println!("github-alignment → http://localhost:{port}/{note}");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .expect("serve");
}
