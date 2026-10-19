//! Skills library: a local folder (`~/huntaway-skills` by default) whose
//! subfolders with a `SKILL.md` are pushed to the daemons
//! (`PUT /v1/skills/{name}`), by hand from the Skills page or on their own
//! (auto-sync: when the library changes and when a machine comes online).
//! Auto-sync never deletes anything on a machine.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine as _;
use huntaway_api::{skill_description, skill_hash, valid_skill_name, SkillFile, SkillView, SkillsResponse};
use huntaway_client::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::machines::{error_value, now_secs, Shared};
use crate::storage::Settings;

/// Folder depth explored inside a skill (symlink loops stop there).
const MAX_DEPTH: usize = 8;
/// How often the library is checked for changes.
const POLL: Duration = Duration::from_secs(5);
/// A failed auto-sync is retried after this delay.
const RETRY_SECS: u64 = 60;

type CmdResult<T> = Result<T, Value>;

fn err(message: impl Into<String>) -> Value {
    json!({ "status": 0, "code": "app_error", "message": message.into() })
}

/// A skill of the local library.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LibrarySkill {
    pub name: String,
    pub description: Option<String>,
    /// [`skill_hash`] of its files: equal to the daemon's when in sync.
    pub hash: String,
    pub files: u32,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryView {
    pub path: String,
    pub exists: bool,
    pub skills: Vec<LibrarySkill>,
}

/// Last sync of one machine (`skills-sync` event).
#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncStatus {
    /// `syncing`, `ok` or `error`.
    pub state: String,
    pub error: Option<String>,
    /// Seconds since the epoch.
    pub at: u64,
    pub pushed: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncReport {
    pub pushed: Vec<String>,
    pub removed: Vec<String>,
    /// `name: message` for each skill that failed.
    pub errors: Vec<String>,
}

#[derive(Default)]
pub struct SkillSync {
    status: Mutex<HashMap<String, SyncStatus>>,
    /// One sync at a time (auto-sync, Sync all, Push).
    lock: tokio::sync::Mutex<()>,
}

pub type SharedSync = Arc<SkillSync>;

fn home() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
}

fn expand(path: &str) -> PathBuf {
    if path == "~" {
        home()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home().join(rest)
    } else {
        PathBuf::from(path)
    }
}

pub fn library_dir(settings: &Settings) -> PathBuf {
    match settings.skills_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => expand(dir),
        None => home().join("huntaway-skills"),
    }
}

/// Visits the files of `dir` (symlinks followed), hidden files and folders
/// skipped; `rel` is `/`-separated.
fn visit(base: &Path, dir: &Path, depth: usize, f: &mut dyn FnMut(String, &Path, &std::fs::Metadata)) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.is_dir() {
            visit(base, &path, depth + 1, f);
        } else if meta.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                f(rel, &path, &meta);
            }
        }
    }
}

/// Files of a skill folder, sorted by path.
pub fn read_files(dir: &Path) -> std::io::Result<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut failed = None;
    visit(dir, dir, 0, &mut |rel, path, _| match std::fs::read(path) {
        Ok(bytes) => out.push((rel, bytes)),
        Err(e) => failed = Some(e),
    });
    if let Some(e) = failed {
        return Err(e);
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Skill folders of the library: valid name, not hidden, with a `SKILL.md`.
fn skill_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            (valid_skill_name(&name) && path.is_dir() && path.join("SKILL.md").is_file()).then_some((name, path))
        })
        .collect();
    dirs.sort();
    dirs
}

pub fn scan(root: &Path) -> Vec<LibrarySkill> {
    skill_dirs(root)
        .into_iter()
        .filter_map(|(name, path)| {
            let files = read_files(&path).ok()?;
            let description = files.iter().find(|(p, _)| p == "SKILL.md").and_then(|(_, b)| skill_description(&String::from_utf8_lossy(b)));
            Some(LibrarySkill {
                hash: skill_hash(files.iter().map(|(p, b)| (p.as_str(), b.as_slice()))),
                files: files.len() as u32,
                description,
                path: path.display().to_string(),
                name,
            })
        })
        .collect()
}

/// Cheap fingerprint of the library (paths, sizes, modification times):
/// changes when a skill is added, removed or edited.
pub fn signature(root: &Path) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut h);
    for (name, path) in skill_dirs(root) {
        name.hash(&mut h);
        visit(&path, &path, 0, &mut |rel, _, meta| {
            rel.hash(&mut h);
            meta.len().hash(&mut h);
            meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).hash(&mut h);
        });
    }
    h.finish()
}

fn skill_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_skill_name(name) {
        return Err("invalid skill name: lowercase letters, digits, `.`, `_` and `-` only".into());
    }
    Ok(root.join(name))
}

fn template(name: &str, description: &str) -> String {
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
    let description = if description.is_empty() { "Describe what this skill does and when to use it.".to_string() } else { description };
    let title: String = name
        .split(['-', '_', '.'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n\n# {title}\n\nWrite the instructions the agent follows when this skill applies:\n\n1. When to use it.\n2. The steps to follow.\n3. What to check before finishing.\n"
    )
}

pub fn create(root: &Path, name: &str, description: &str) -> Result<LibrarySkill, String> {
    let dir = skill_path(root, name)?;
    if dir.exists() {
        return Err(format!("{name} already exists in the library"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), template(name, description)).map_err(|e| e.to_string())?;
    scan(root).into_iter().find(|s| s.name == name).ok_or_else(|| "skill not created".to_string())
}

pub fn delete(root: &Path, name: &str) -> Result<(), String> {
    let dir = skill_path(root, name)?;
    if !dir.is_dir() {
        return Err(format!("{name} is not in the library"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// Files of a library skill, base64, ready for `PUT /v1/skills/{name}`.
pub fn skill_files(root: &Path, name: &str) -> Result<Vec<SkillFile>, String> {
    let dir = skill_path(root, name)?;
    if !dir.join("SKILL.md").is_file() {
        return Err(format!("{name} has no SKILL.md"));
    }
    let files = read_files(&dir).map_err(|e| e.to_string())?;
    Ok(files
        .into_iter()
        .map(|(path, bytes)| SkillFile { path, content: base64::engine::general_purpose::STANDARD.encode(bytes) })
        .collect())
}

fn skill_url(name: &str) -> String {
    format!("/v1/skills/{}", Client::segment(name))
}

async fn remote(client: &Client) -> Result<Vec<SkillView>, huntaway_client::Error> {
    Ok(client.get_typed::<SkillsResponse>("/v1/skills").await?.skills)
}

async fn push(client: &Client, root: &Path, name: &str) -> Result<SkillView, Value> {
    let (root, owned) = (root.to_path_buf(), name.to_string());
    let files = tokio::task::spawn_blocking(move || skill_files(&root, &owned)).await.map_err(|e| err(e.to_string()))?.map_err(err)?;
    let v = client.put(&skill_url(name), json!({ "files": files })).await.map_err(|e| error_value(&e))?;
    serde_json::from_value(v["skill"].clone()).map_err(|e| err(e.to_string()))
}

fn message(v: &Value) -> String {
    v["message"].as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

/// Pushes the skills missing or different on the machine; with
/// `remove_extra`, deletes its skills that are not in the library.
async fn sync_machine(client: &Client, root: &Path, remove_extra: bool) -> Result<SyncReport, Value> {
    let dir = root.to_path_buf();
    let library = tokio::task::spawn_blocking(move || scan(&dir)).await.map_err(|e| err(e.to_string()))?;
    let remote = remote(client).await.map_err(|e| error_value(&e))?;
    let mut report = SyncReport::default();
    for skill in &library {
        if remote.iter().any(|r| r.name == skill.name && r.hash == skill.hash) {
            continue;
        }
        match push(client, root, &skill.name).await {
            Ok(_) => report.pushed.push(skill.name.clone()),
            Err(e) => report.errors.push(format!("{}: {}", skill.name, message(&e))),
        }
    }
    if remove_extra {
        for r in remote.iter().filter(|r| !library.iter().any(|s| s.name == r.name)) {
            match client.delete(&skill_url(&r.name)).await {
                Ok(_) => report.removed.push(r.name.clone()),
                Err(e) => report.errors.push(format!("{}: {}", r.name, e)),
            }
        }
    }
    Ok(report)
}

impl SkillSync {
    fn set_status(&self, app: &AppHandle, machine_id: &str, status: SyncStatus) {
        self.status.lock().unwrap().insert(machine_id.to_string(), status.clone());
        app.emit("skills-sync", json!({ "machine_id": machine_id, "status": status })).ok();
    }

    /// A failed sync is due for a retry.
    fn retry_due(&self, machine_id: &str) -> bool {
        self.status.lock().unwrap().get(machine_id).is_some_and(|s| s.state == "error" && now_secs().saturating_sub(s.at) >= RETRY_SECS)
    }

    /// Syncs one machine and records its status.
    pub async fn run(&self, app: &AppHandle, machine_id: &str, client: &Client, root: &Path, remove_extra: bool) -> Result<SyncReport, Value> {
        let _guard = self.lock.lock().await;
        self.set_status(app, machine_id, SyncStatus { state: "syncing".into(), at: now_secs(), ..Default::default() });
        let result = sync_machine(client, root, remove_extra).await;
        let status = match &result {
            Ok(r) => SyncStatus {
                state: if r.errors.is_empty() { "ok" } else { "error" }.into(),
                error: (!r.errors.is_empty()).then(|| r.errors.join("\n")),
                at: now_secs(),
                pushed: r.pushed.clone(),
                removed: r.removed.clone(),
            },
            Err(e) => SyncStatus { state: "error".into(), error: Some(message(e)), at: now_secs(), ..Default::default() },
        };
        self.set_status(app, machine_id, status);
        result
    }
}

/// Background loop: watches the library and syncs the online machines
/// that may push skills (`skills.edit`) when it changes or when they
/// (re)connect, while "Sync skills automatically" is on.
pub fn start(app: AppHandle, machines: Shared, sync: SharedSync) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<u64> = None;
        // Connection number of each machine at its last sync.
        let mut seen: HashMap<String, u64> = HashMap::new();
        loop {
            tokio::time::sleep(POLL).await;
            let settings = machines.settings.lock().unwrap().clone();
            let root = library_dir(&settings);
            let dir = root.clone();
            let Ok(sig) = tokio::task::spawn_blocking(move || signature(&dir)).await else { continue };
            let changed = last != Some(sig);
            if changed && last.is_some() {
                app.emit("skills-library", ()).ok();
            }
            last = Some(sig);
            if !settings.skills_auto_sync {
                // Turned back on: every machine is synced again.
                seen.clear();
                continue;
            }
            for m in machines.online() {
                if !m.permissions.iter().any(|p| p == "skills.edit") {
                    continue;
                }
                let due = changed || seen.get(&m.machine_id) != Some(&m.connects) || sync.retry_due(&m.machine_id);
                seen.insert(m.machine_id.clone(), m.connects);
                if !due {
                    continue;
                }
                let (app, sync, root) = (app.clone(), sync.clone(), root.clone());
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sync.run(&app, &m.machine_id, &m.client, &root, false).await {
                        tracing::debug!(machine_id = %m.machine_id, error = %message(&e), "skills sync failed");
                    }
                });
            }
        }
    });
}

fn root_of(machines: &Shared) -> PathBuf {
    library_dir(&machines.settings.lock().unwrap())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| err(e.to_string()))?.map_err(err)
}

// ----------------------------------------------------------- commands

#[tauri::command]
pub async fn skills_library(machines: State<'_, Shared>) -> CmdResult<LibraryView> {
    let root = root_of(&machines);
    blocking(move || Ok(LibraryView { path: root.display().to_string(), exists: root.is_dir(), skills: scan(&root) })).await
}

#[tauri::command]
pub async fn skills_create(machines: State<'_, Shared>, name: String, description: String) -> CmdResult<LibrarySkill> {
    let root = root_of(&machines);
    blocking(move || create(&root, name.trim(), &description)).await
}

#[tauri::command]
pub async fn skills_delete_local(machines: State<'_, Shared>, name: String) -> CmdResult<()> {
    let root = root_of(&machines);
    blocking(move || delete(&root, &name)).await
}

#[tauri::command]
pub async fn skills_files(machines: State<'_, Shared>, name: String) -> CmdResult<Vec<SkillFile>> {
    let root = root_of(&machines);
    blocking(move || skill_files(&root, &name)).await
}

/// Opens the library folder (created if missing), or one skill's folder.
#[tauri::command]
pub async fn skills_open_folder(app: AppHandle, machines: State<'_, Shared>, name: Option<String>) -> CmdResult<()> {
    let root = root_of(&machines);
    let path = blocking(move || {
        let path = match name {
            Some(name) => skill_path(&root, &name)?,
            None => {
                std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
                root
            }
        };
        Ok(path)
    })
    .await?;
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| err(e.to_string()))
}

#[tauri::command]
pub async fn skills_remote(machines: State<'_, Shared>, machine_id: String) -> CmdResult<Vec<SkillView>> {
    let client = machines.client(&machine_id).map_err(err)?;
    remote(&client).await.map_err(|e| error_value(&e))
}

#[tauri::command]
pub async fn skills_push(machines: State<'_, Shared>, sync: State<'_, SharedSync>, machine_id: String, name: String) -> CmdResult<SkillView> {
    let client = machines.client(&machine_id).map_err(err)?;
    let root = root_of(&machines);
    let _guard = sync.lock.lock().await;
    push(&client, &root, &name).await
}

/// Pushes every skill that differs; `remove_extra` also deletes the
/// machine's skills that are not in the library.
#[tauri::command]
pub async fn skills_sync(
    app: AppHandle,
    machines: State<'_, Shared>,
    sync: State<'_, SharedSync>,
    machine_id: String,
    remove_extra: bool,
) -> CmdResult<SyncReport> {
    let client = machines.client(&machine_id).map_err(err)?;
    let root = root_of(&machines);
    sync.run(&app, &machine_id, &client, &root, remove_extra).await
}

#[tauri::command]
pub async fn skills_delete_remote(machines: State<'_, Shared>, machine_id: String, name: String) -> CmdResult<()> {
    let client = machines.client(&machine_id).map_err(err)?;
    client.delete(&skill_url(&name)).await.map(|_| ()).map_err(|e| error_value(&e))
}

#[tauri::command]
pub fn skills_sync_status(sync: State<'_, SharedSync>) -> HashMap<String, SyncStatus> {
    sync.status.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("huntaway-skills-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_valid_skills_and_skips_hidden_files() {
        let root = temp_dir("scan");
        create(&root, "deploy-app", "Deploys the app").unwrap();
        std::fs::create_dir_all(root.join("deploy-app/scripts")).unwrap();
        std::fs::write(root.join("deploy-app/scripts/run.sh"), "echo hi\n").unwrap();
        std::fs::write(root.join("deploy-app/.DS_Store"), "x").unwrap();
        std::fs::create_dir_all(root.join("deploy-app/.git")).unwrap();
        std::fs::write(root.join("deploy-app/.git/HEAD"), "ref").unwrap();
        // Not skills: no SKILL.md, invalid name, hidden folder.
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::create_dir_all(root.join("Bad Name")).unwrap();
        std::fs::write(root.join("Bad Name/SKILL.md"), "---\n---\n").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();

        let skills = scan(&root);
        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "deploy-app");
        assert_eq!(s.description.as_deref(), Some("Deploys the app"));
        assert_eq!(s.files, 2);
        let files = read_files(&root.join("deploy-app")).unwrap();
        assert_eq!(files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["SKILL.md", "scripts/run.sh"]);
        // Same hash as the daemon computes over the pushed files.
        assert_eq!(s.hash, skill_hash(files.iter().map(|(p, b)| (p.as_str(), b.as_slice()))));

        let before = signature(&root);
        std::fs::write(root.join("deploy-app/scripts/run.sh"), "echo changed\n").unwrap();
        assert_ne!(signature(&root), before);
        assert_ne!(scan(&root)[0].hash, s.hash);

        assert!(create(&root, "deploy-app", "").is_err());
        assert!(create(&root, "../evil", "").is_err());
        delete(&root, "deploy-app").unwrap();
        assert!(scan(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn template_has_front_matter() {
        let md = template("review-pr", "Reviews\na pull request");
        assert!(md.starts_with("---\nname: review-pr\ndescription: Reviews a pull request\n---\n"));
        assert!(md.contains("# Review Pr"));
        assert_eq!(skill_description(&md).as_deref(), Some("Reviews a pull request"));
    }
}
