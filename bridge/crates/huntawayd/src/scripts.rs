//! Project scripts: the `[scripts]` table of `.huntaway.toml` at the project
//! root (versioned with the project) merged with scripts added from the app
//! (stored per project in `scripts.json` of the state dir). The file wins on
//! name conflicts. Also finds suggestions in the project files
//! (`package.json` scripts, Makefile targets, Compose file, Cargo binary).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;
use huntaway_api::ScriptSuggestion;
use serde::{Deserialize, Serialize};

pub const PROJECT_FILE: &str = ".huntaway.toml";
const MAX_SUGGESTIONS: usize = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptDef {
    pub cmd: String,
    /// Relative to the project root, or absolute.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// `name = "cmd"` or `name = { cmd = "…", cwd = "…" }`.
#[derive(Deserialize)]
#[serde(untagged)]
enum FileEntry {
    Cmd(String),
    Full(ScriptDef),
}

#[derive(Deserialize, Default)]
struct ProjectFile {
    #[serde(default)]
    scripts: BTreeMap<String, FileEntry>,
}

/// Parses the text of a `.huntaway.toml`.
pub fn parse_project_file(text: &str) -> Result<BTreeMap<String, ScriptDef>, String> {
    let file: ProjectFile = toml::from_str(text).map_err(|e| e.message().to_string())?;
    let mut scripts = BTreeMap::new();
    for (name, entry) in file.scripts {
        let def = match entry {
            FileEntry::Cmd(cmd) => ScriptDef { cmd, cwd: None },
            FileEntry::Full(def) => def,
        };
        check_name(&name)?;
        if def.cmd.trim().is_empty() {
            return Err(format!("script `{name}` has an empty command"));
        }
        scripts.insert(name, def);
    }
    Ok(scripts)
}

/// Scripts of the project's `.huntaway.toml`; none when the file is missing.
pub fn read_project_file(dir: &Path) -> Result<BTreeMap<String, ScriptDef>, String> {
    match std::fs::read_to_string(dir.join(PROJECT_FILE)) {
        Ok(text) => parse_project_file(&text).map_err(|e| format!("{PROJECT_FILE}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("{PROJECT_FILE}: {e}")),
    }
}

/// Script names: short, printable, used in tab labels.
pub fn check_name(name: &str) -> Result<(), String> {
    let ok = !name.trim().is_empty()
        && name.chars().count() <= 40
        && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | ' ' | '/'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid script name `{name}`: letters, digits, spaces and - _ . : / only, 40 characters at most"))
    }
}

/// A script with where it comes from (`file` or `app`).
#[derive(Debug, Clone, PartialEq)]
pub struct Defined {
    pub name: String,
    pub def: ScriptDef,
    pub source: &'static str,
}

/// File scripts and app scripts, by name; the file wins on conflicts.
pub fn merge(file: &BTreeMap<String, ScriptDef>, app: &BTreeMap<String, ScriptDef>) -> Vec<Defined> {
    let mut all: BTreeMap<&str, Defined> = BTreeMap::new();
    for (name, def) in app {
        all.insert(name, Defined { name: name.clone(), def: def.clone(), source: "app" });
    }
    for (name, def) in file {
        all.insert(name, Defined { name: name.clone(), def: def.clone(), source: "file" });
    }
    all.into_values().collect()
}

// --------------------------------------------------------------- app store

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    /// Canonical project path → scripts by name.
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<String, ScriptDef>>,
}

/// Scripts added from the app, in `scripts.json` of the state dir.
pub struct ScriptStore {
    path: PathBuf,
    data: Mutex<StoreFile>,
}

impl ScriptStore {
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("scripts.json");
        let data = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    pub fn get(&self, project: &str) -> BTreeMap<String, ScriptDef> {
        self.data.lock().unwrap().projects.get(project).cloned().unwrap_or_default()
    }

    /// Adds or replaces `name`; `rename_from` is removed in the same write.
    pub fn save(&self, project: &str, name: &str, def: ScriptDef, rename_from: Option<&str>) -> Result<()> {
        let mut data = self.data.lock().unwrap();
        let scripts = data.projects.entry(project.to_string()).or_default();
        if let Some(old) = rename_from.filter(|old| *old != name) {
            scripts.remove(old);
        }
        scripts.insert(name.to_string(), def);
        self.write(&data)
    }

    /// Returns whether the script existed.
    pub fn delete(&self, project: &str, name: &str) -> Result<bool> {
        let mut data = self.data.lock().unwrap();
        let Some(scripts) = data.projects.get_mut(project) else { return Ok(false) };
        let found = scripts.remove(name).is_some();
        if scripts.is_empty() {
            data.projects.remove(project);
        }
        if found {
            self.write(&data)?;
        }
        Ok(found)
    }

    fn write(&self, data: &StoreFile) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(data)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

// ------------------------------------------------------------- suggestions

/// Scripts found in the project files, minus those already defined (same
/// name or same command).
pub fn suggestions(dir: &Path, defined: &[Defined]) -> Vec<ScriptSuggestion> {
    let mut found = Vec::new();
    found.extend(package_json(dir));
    found.extend(makefile(dir));
    found.extend(compose(dir));
    found.extend(cargo(dir));
    let mut names: Vec<String> = defined.iter().map(|d| d.name.clone()).collect();
    let cmds: Vec<&str> = defined.iter().map(|d| d.def.cmd.trim()).collect();
    found.retain(|s| {
        let keep = !names.contains(&s.name) && !cmds.contains(&s.cmd.as_str());
        if keep {
            names.push(s.name.clone());
        }
        keep
    });
    found.truncate(MAX_SUGGESTIONS);
    found
}

fn suggestion(name: &str, cmd: String, origin: &str) -> ScriptSuggestion {
    ScriptSuggestion { name: name.to_string(), cmd, cwd: None, origin: origin.to_string() }
}

/// Package manager of a JavaScript project, from its lock file.
fn package_manager(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn package_json(dir: &Path) -> Vec<ScriptSuggestion> {
    let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    let Some(scripts) = json["scripts"].as_object() else { return Vec::new() };
    let pm = package_manager(dir);
    // Lifecycle hooks run by the package manager itself.
    let hook = |name: &str| {
        matches!(name, "prepare" | "preinstall" | "install" | "postinstall" | "prepublishOnly")
            || ["pre", "post"].iter().any(|p| name.strip_prefix(p).is_some_and(|rest| scripts.contains_key(rest)))
    };
    scripts
        .keys()
        .filter(|name| !hook(name) && check_name(name).is_ok())
        .map(|name| suggestion(name, format!("{pm} run {name}"), "package.json"))
        .collect()
}

/// Targets of a Makefile (`name:` at the start of a line), not special or
/// pattern targets nor variable assignments (`X := 1`).
pub fn make_targets(text: &str) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with(|c: char| c.is_whitespace() || c == '#' || c == '.') {
            continue;
        }
        let Some((target, rest)) = line.split_once(':') else { continue };
        let target = target.trim();
        let valid = !target.is_empty() && target.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
        if !valid || rest.starts_with('=') || rest.starts_with(':') || targets.iter().any(|t| t == target) {
            continue;
        }
        targets.push(target.to_string());
    }
    targets
}

fn makefile(dir: &Path) -> Vec<ScriptSuggestion> {
    let text = ["Makefile", "makefile", "GNUmakefile"].iter().find_map(|f| std::fs::read_to_string(dir.join(f)).ok());
    let Some(text) = text else { return Vec::new() };
    make_targets(&text).into_iter().map(|t| suggestion(&t, format!("make {t}"), "Makefile")).collect()
}

fn compose(dir: &Path) -> Vec<ScriptSuggestion> {
    let files = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
    if files.iter().any(|f| dir.join(f).exists()) {
        vec![suggestion("compose", "docker compose up".into(), "docker-compose")]
    } else {
        Vec::new()
    }
}

fn cargo(dir: &Path) -> Vec<ScriptSuggestion> {
    if dir.join("Cargo.toml").exists() && dir.join("src/main.rs").exists() {
        vec![suggestion("run", "cargo run".into(), "Cargo.toml")]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("huntaway-scripts-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn def(cmd: &str) -> ScriptDef {
        ScriptDef { cmd: cmd.into(), cwd: None }
    }

    #[test]
    fn project_file_accepts_both_forms() {
        let scripts = parse_project_file(
            r#"
            [scripts]
            dev = "npm run dev"
            db = { cmd = "docker compose up", cwd = "infra" }
            "#,
        )
        .unwrap();
        assert_eq!(scripts["dev"], def("npm run dev"));
        assert_eq!(scripts["db"], ScriptDef { cmd: "docker compose up".into(), cwd: Some("infra".into()) });
        assert!(parse_project_file("").unwrap().is_empty());
        assert!(parse_project_file("[other]\nx = 1").unwrap().is_empty());
    }

    #[test]
    fn project_file_errors_are_reported() {
        assert!(parse_project_file("[scripts]\ndev = ").is_err());
        assert!(parse_project_file("[scripts]\ndev = \"  \"").unwrap_err().contains("empty command"));
        assert!(parse_project_file("[scripts]\ndev = { cwd = \"x\" }").is_err());
        assert!(parse_project_file("[scripts]\n\"a\\nb\" = \"x\"").unwrap_err().contains("invalid script name"));
        let dir = temp_dir("missing");
        assert!(read_project_file(&dir).unwrap().is_empty());
        std::fs::write(dir.join(PROJECT_FILE), "[scripts\n").unwrap();
        assert!(read_project_file(&dir).unwrap_err().starts_with(PROJECT_FILE));
    }

    #[test]
    fn file_wins_over_app_scripts() {
        let file: BTreeMap<String, ScriptDef> = [("dev".to_string(), def("npm run dev"))].into();
        let app: BTreeMap<String, ScriptDef> = [("dev".to_string(), def("vite")), ("db".to_string(), def("pg"))].into();
        let merged = merge(&file, &app);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0], Defined { name: "db".into(), def: def("pg"), source: "app" });
        assert_eq!(merged[1], Defined { name: "dev".into(), def: def("npm run dev"), source: "file" });
    }

    #[test]
    fn store_saves_renames_and_deletes() {
        let dir = temp_dir("store");
        let store = ScriptStore::open(&dir);
        store.save("/p", "dev", def("vite"), None).unwrap();
        store.save("/p", "web", def("vite --host"), Some("dev")).unwrap();
        let reopened = ScriptStore::open(&dir);
        assert_eq!(reopened.get("/p").keys().collect::<Vec<_>>(), ["web"]);
        assert!(reopened.delete("/p", "web").unwrap());
        assert!(!reopened.delete("/p", "web").unwrap());
        assert!(ScriptStore::open(&dir).get("/p").is_empty());
    }

    #[test]
    fn make_targets_skip_special_and_assignments() {
        let text = ".PHONY: build\nbuild: deps\n\tcargo build\nX := 1\nY ::= 2\n%.o: %.c\ntest:\n# lint:\nbuild:\nrelease/linux: build\n";
        assert_eq!(make_targets(text), ["build", "test", "release/linux"]);
    }

    #[test]
    fn suggestions_from_project_files() {
        let dir = temp_dir("suggest");
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"tsc","prebuild":"rm -rf dist","postinstall":"x","lint":"eslint ."}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(dir.join("Makefile"), "build:\n\tmake\ndeploy:\n\t./deploy.sh\n").unwrap();
        std::fs::write(dir.join("compose.yaml"), "services: {}\n").unwrap();
        let defined = vec![Defined { name: "web".into(), def: def("pnpm run dev"), source: "file" }];
        let found = suggestions(&dir, &defined);
        let names: Vec<(&str, &str, &str)> = found.iter().map(|s| (s.name.as_str(), s.cmd.as_str(), s.origin.as_str())).collect();
        assert_eq!(
            names,
            [
                ("build", "pnpm run build", "package.json"),
                ("lint", "pnpm run lint", "package.json"),
                ("deploy", "make deploy", "Makefile"),
                ("compose", "docker compose up", "docker-compose"),
            ]
        );
        assert!(suggestions(&temp_dir("empty"), &[]).is_empty());
    }
}
