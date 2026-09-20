use crate::github::{Error, Session};
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(serde::Serialize)]
struct Item {
    kind: &'static str,
    repo: String,
    title: String,
    url: String,
    at: String,
}

#[derive(Clone, Default)]
struct Meta {
    stars: u64,
    forks: u64,
    parent: Option<String>,
}

// Quota budget per analysis, roughly: 3–9 search calls (the scarce one: 30/min/token),
// ~5 REST calls, ~15 GraphQL calls. Everything fan-out shaped goes through aliased GraphQL batches.
pub const WINDOW_DAYS: i64 = 90;
const SEARCH_MAX_PAGES: usize = 3;
const DEPENDENCY_SOURCE_REPOS: usize = 12;
const DEPENDENCY_CONCURRENCY: usize = 2;
const REPO_META_LOOKUPS: usize = 60;
const REPO_META_BATCH: usize = 30;

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn lower(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_lowercase()
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn gql_str(v: &str) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into())
}

fn repo_alias(i: usize, full: &str, body: &str) -> String {
    let (owner, name) = full.split_once('/').unwrap_or((full, ""));
    format!(
        "r{i}: repository(owner:{}, name:{}) {{ {body} }}",
        gql_str(owner),
        gql_str(name)
    )
}

// GitHub's own dependency graph (Insights → Dependency graph), every ecosystem it knows
// (npm, NuGet, Actions, pip, cargo, go, ...), already resolved to source repos.
// This preview endpoint is slow: aliasing several repos into one query gets 502s, so it's one
// repo per query with low concurrency, and only a handful of repos.
async fn dependency_repos(gh: &Session, repos: &[String]) -> HashSet<String> {
    if !gh.authenticated() {
        return HashSet::new();
    }
    let body = "dependencyGraphManifests(first: 10) { nodes { dependencies(first: 60) { nodes { repository { nameWithOwner } } } } }";
    stream::iter(repos.to_vec())
        .map(|full: String| async move {
            match gh
                .graphql(
                    &format!("{{ {} }}", repo_alias(0, &full, body)),
                    json!({}),
                    true,
                )
                .await
            {
                Err(e) => {
                    eprintln!("dependency graph {full}: {e}");
                    vec![]
                }
                Ok(data) => arr(&data["r0"]["dependencyGraphManifests"]["nodes"])
                    .iter()
                    .flat_map(|m| arr(&m["dependencies"]["nodes"]))
                    .filter_map(|d| {
                        d["repository"]["nameWithOwner"]
                            .as_str()
                            .map(|s| s.to_lowercase())
                    })
                    .collect::<Vec<_>>(),
            }
        })
        .buffer_unordered(DEPENDENCY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// Stars, forks and fork-parent for many repos in one query per 30.
async fn repo_meta(gh: &Session, repos: &[String]) -> HashMap<String, Meta> {
    let mut out = HashMap::new();
    if !gh.authenticated() {
        return out;
    }
    let body = "nameWithOwner stargazerCount forkCount isFork parent { nameWithOwner stargazerCount forkCount }";
    for chunk in repos.chunks(REPO_META_BATCH) {
        let fields = chunk
            .iter()
            .enumerate()
            .map(|(i, full)| repo_alias(i, full, body))
            .collect::<Vec<_>>()
            .join(" ");
        let Ok(data) = gh
            .graphql(&format!("{{ {fields} }}"), json!({}), false)
            .await
            .inspect_err(|e| eprintln!("repo meta: {e}"))
        else {
            continue;
        };
        for r in data
            .as_object()
            .into_iter()
            .flat_map(|d| d.values())
            .filter(|r| !r.is_null())
        {
            let parent = r["parent"]
                .as_object()
                .map(|_| lower(&r["parent"], "nameWithOwner"))
                .filter(|_| r["isFork"].as_bool().unwrap_or(false));
            if let Some(p) = &parent {
                out.entry(p.clone()).or_insert(Meta {
                    stars: r["parent"]["stargazerCount"].as_u64().unwrap_or(0),
                    forks: r["parent"]["forkCount"].as_u64().unwrap_or(0),
                    parent: None,
                });
            }
            out.insert(
                lower(r, "nameWithOwner"),
                Meta {
                    stars: r["stargazerCount"].as_u64().unwrap_or(0),
                    forks: r["forkCount"].as_u64().unwrap_or(0),
                    parent,
                },
            );
        }
    }
    out
}

/// Everything matching within the window, newest first, up to SEARCH_MAX_PAGES × 100.
/// Returns the items and GitHub's total so the UI can say when we hit the cap.
async fn search(gh: &Session, query: String, sort: &str) -> Result<(Vec<Value>, u64), Error> {
    let mut items = Vec::new();
    let mut total = 0;
    for page in 1..=SEARCH_MAX_PAGES {
        let v = gh
            .get(format!(
                "/search/{query}&sort={sort}&order=desc&per_page=100&page={page}"
            ))
            .await?;
        total = v["total_count"].as_u64().unwrap_or(0);
        let batch = arr(&v["items"]);
        let full_page = batch.len() == 100;
        items.extend(batch);
        if !full_page || items.len() as u64 >= total {
            break;
        }
    }
    Ok((items, total))
}

async fn sponsoring(gh: &Session, login: &str) -> Result<Value, Error> {
    if !gh.authenticated() {
        return Ok(json!({ "totalCount": 0, "nodes": [] }));
    }
    let query = "query($login:String!){ user(login:$login){ sponsoring(first:100){ totalCount nodes{ ... on User{login} ... on Organization{login} } } } }";
    let data = gh.graphql(query, json!({ "login": login }), false).await?;
    Ok(data["user"]["sponsoring"].clone())
}

pub async fn analyze(gh: &Session, login: &str) -> Result<Value, Error> {
    let (user, own_repos, orgs) = tokio::try_join!(
        gh.get(format!("/users/{login}")),
        gh.get(format!(
            "/users/{login}/repos?per_page=100&type=owner&sort=pushed"
        )),
        gh.get(format!("/users/{login}/orgs?per_page=100")),
    )?;
    let login = lower(&user, "login");
    let own_repos = arr(&own_repos);

    // "yours" = you + orgs you're a public member of + any @org in your profile company/bio.
    let mentioned = format!("{} {}", s(&user["company"]), s(&user["bio"]));
    let owners: HashSet<String> = std::iter::once(login.clone())
        .chain(arr(&orgs).iter().map(|o| lower(o, "login")))
        .chain(
            mentioned
                .split_whitespace()
                .filter_map(|w| w.strip_prefix('@'))
                .map(|w| {
                    w.trim_matches(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
                        .to_lowercase()
                })
                .filter(|w| !w.is_empty()),
        )
        .collect();

    // Upstream = every repo that your own or work repos depend on, per GitHub's dependency graph.
    // A person's stack repeats across their repos, so a dozen well-chosen ones cover most of it:
    // half the most-starred (real projects), half the most recently pushed (current stack).
    let work_repos: Vec<Value> = futures::future::join_all(
        owners
            .iter()
            .filter(|o| **o != login)
            .take(4)
            .map(|o| gh.get(format!("/orgs/{o}/repos?per_page=20&sort=pushed"))),
    )
    .await
    .into_iter()
    .flat_map(|r| arr(&r.unwrap_or(Value::Null)))
    .collect();
    let candidates: Vec<&Value> = own_repos
        .iter()
        .chain(work_repos.iter())
        .filter(|r| !r["fork"].as_bool().unwrap_or(false) && r["size"].as_u64().unwrap_or(0) > 0)
        .collect();
    let mut by_stars = candidates.clone();
    by_stars.sort_by_key(|r| std::cmp::Reverse(r["stargazers_count"].as_u64().unwrap_or(0)));
    let mut dep_sources: Vec<String> = Vec::new();
    for r in by_stars
        .iter()
        .take(DEPENDENCY_SOURCE_REPOS / 2)
        .chain(candidates.iter())
    {
        let name = s(&r["full_name"]);
        if dep_sources.len() >= DEPENDENCY_SOURCE_REPOS {
            break;
        }
        if !dep_sources.contains(&name) {
            dep_sources.push(name);
        }
    }

    let since = (chrono::Utc::now() - chrono::Duration::days(WINDOW_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let (prs, issues, commits, sponsoring, deps) = tokio::join!(
        search(
            gh,
            format!("issues?q=type:pr+author:{login}+created:>={since}&advanced_search=true"),
            "created"
        ),
        search(
            gh,
            format!("issues?q=type:issue+author:{login}+created:>={since}&advanced_search=true"),
            "created"
        ),
        search(
            gh,
            format!("commits?q=author:{login}+author-date:>={since}"),
            "author-date"
        ),
        sponsoring(gh, &login),
        dependency_repos(gh, &dep_sources),
    );
    let ((prs, prs_total), (issues, issues_total), (commits, commits_total), sponsoring) =
        (prs?, issues?, commits?, sponsoring?);

    let search_items = |v: &[Value], kind: &'static str| -> Vec<Item> {
        v.iter()
            .map(|i| Item {
                kind,
                repo: s(&i["repository_url"])
                    .split("/repos/")
                    .nth(1)
                    .unwrap_or("")
                    .to_lowercase(),
                title: s(&i["title"]),
                url: s(&i["html_url"]),
                at: s(&i["created_at"]),
            })
            .collect()
    };
    let mut items = search_items(&prs, "pr");
    items.extend(search_items(&issues, "issue"));
    items.extend(commits.iter().map(|c| {
        Item {
            kind: "commit",
            repo: lower(&c["repository"], "full_name"),
            title: s(&c["commit"]["message"])
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
            url: s(&c["html_url"]),
            at: s(&c["commit"]["author"]["date"]),
        }
    }));
    items.extend(arr(&sponsoring["nodes"]).iter().map(|n| {
        let l = s(&n["login"]);
        Item {
            kind: "sponsor",
            repo: format!("@{l}"),
            title: format!("sponsoring {l}"),
            url: format!("https://github.com/sponsors/{l}"),
            at: String::new(),
        }
    }));

    // Repo metadata for every touched repo, most-touched first. Forks resolve to their parent,
    // so commits on your fork of X count as work on X.
    let mut known: HashMap<String, Meta> = own_repos
        .iter()
        .filter(|r| !r["fork"].as_bool().unwrap_or(false))
        .map(|r| {
            (
                lower(r, "full_name"),
                Meta {
                    stars: r["stargazers_count"].as_u64().unwrap_or(0),
                    forks: r["forks_count"].as_u64().unwrap_or(0),
                    parent: None,
                },
            )
        })
        .collect();
    let mut touches: HashMap<String, usize> = HashMap::new();
    for i in items
        .iter()
        .filter(|i| i.kind != "sponsor" && !known.contains_key(&i.repo))
    {
        *touches.entry(i.repo.clone()).or_default() += 1;
    }
    let mut lookup: Vec<(String, usize)> = touches.into_iter().collect();
    lookup.sort_by(|a, b| b.1.cmp(&a.1));
    let lookup: Vec<String> = lookup
        .into_iter()
        .take(REPO_META_LOOKUPS)
        .map(|(n, _)| n)
        .collect();
    known.extend(repo_meta(gh, &lookup).await);
    for i in items.iter_mut().filter(|i| i.kind != "sponsor") {
        if let Some(parent) = known.get(&i.repo).and_then(|m| m.parent.clone()) {
            i.repo = parent;
        }
    }

    let repos: serde_json::Map<String, Value> = items
        .iter()
        .map(|i| &i.repo)
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|name| {
            let m = known.get(name).cloned().unwrap_or_default();
            (
                name.clone(),
                json!({
                    "name": name,
                    "stars": m.stars,
                    "forks": m.forks,
                    "owned": name.split('/').next().is_some_and(|o| owners.contains(o)),
                    "dependency": deps.contains(name),
                    "sponsor": name.starts_with('@'),
                }),
            )
        })
        .collect();

    Ok(json!({
        "login": user["login"],
        "avatar": user["avatar_url"],
        "orgs": owners,
        "dependencies": deps,
        "items": items,
        "repos": repos,
        "window": { "days": WINDOW_DAYS, "since": since },
        "sampled": {
            "prs": { "total": prs_total, "fetched": prs.len() },
            "issues": { "total": issues_total, "fetched": issues.len() },
            "commits": { "total": commits_total, "fetched": commits.len() },
            "sponsoring": sponsoring["totalCount"],
        },
    }))
}
