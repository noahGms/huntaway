//! Skills pushed by the desktop app (`PUT /v1/skills/{name}`). Each skill
//! is stored once in `<state dir>/skills/<name>/` and linked into the skill
//! folder of every agent: `~/.claude/skills/<name>` (Claude Code; opencode
//! reads it too) and `~/.agents/skills/<name>` (Codex). Only links created
//! here are ever replaced or removed: a skill of the same name installed by
//! hand is reported as a conflict and left alone.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use huntaway_api::{skill_description, skill_hash, valid_skill_name, SkillFile, SkillLink, SkillView};
use serde::{Deserialize, Serialize};

use crate::config::state_dir;
use crate::engine::{ActionError, ActionResult};

/// Size limit of one skill folder.
const MAX_SKILL_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILES: usize = 500;

#[derive(Default, Serialize, Deserialize)]
struct Manifest {
    /// name → seconds since the epoch of the last update.
    updated: BTreeMap<String, u64>,
    /// Links created by Huntaway.
    links: Vec<PathBuf>,
}

pub struct Skills {
    root: PathBuf,
    targets: Vec<(String, PathBuf)>,
    lock: Mutex<()>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Agent skill folders the skills are linked into.
pub fn default_targets() -> Vec<(String, PathBuf)> {
    vec![
        ("claude".into(), huntaway_core::claude::config_dir().join("skills")),
        ("codex".into(), herdr_client::home_dir().join(".agents").join("skills")),
    ]
}

fn bad(message: impl Into<String>) -> ActionError {
    ActionError::new(400, "invalid_skill", message)
}

/// A relative path that stays inside the skill folder.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    if path.is_empty() || p.is_absolute() {
        return None;
    }
    p.components().all(|c| matches!(c, Component::Normal(_))).then(|| p.to_path_buf())
}

/// Files of a skill folder, relative paths with `/`.
fn read_files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let path = e.path();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                walk(base, &path, out);
            } else if kind.is_file() {
                if let (Ok(rel), Ok(bytes)) = (path.strip_prefix(base), std::fs::read(&path)) {
                    let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                    out.push((rel, bytes));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

impl Skills {
    /// Store in the state dir, linked into `config.skill_dirs` (or the defaults).
    pub fn new(config: &crate::config::Config) -> Self {
        let targets = if config.skill_dirs.is_empty() {
            default_targets()
        } else {
            config.skill_dirs.iter().map(|(agent, dir)| (agent.clone(), dir.clone())).collect()
        };
        Self::with(state_dir().join("skills"), targets)
    }

    pub fn with(root: PathBuf, targets: Vec<(String, PathBuf)>) -> Self {
        Self { root, targets, lock: Mutex::new(()) }
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join(".manifest.json")
    }

    fn manifest(&self) -> Manifest {
        std::fs::read_to_string(self.manifest_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    fn save(&self, m: &Manifest) -> ActionResult<()> {
        std::fs::create_dir_all(&self.root).map_err(io)?;
        std::fs::write(self.manifest_path(), serde_json::to_string_pretty(m).unwrap()).map_err(io)
    }

    /// Whether `link` is a symlink to this skill's folder.
    fn ours(&self, link: &Path, name: &str) -> bool {
        std::fs::read_link(link).is_ok_and(|t| t == self.root.join(name))
    }

    fn links_of(&self, name: &str) -> Vec<SkillLink> {
        self.targets
            .iter()
            .map(|(agent, dir)| {
                let path = dir.join(name);
                let state = if self.ours(&path, name) { "linked" } else if path.symlink_metadata().is_ok() { "conflict" } else { "missing" };
                SkillLink { agent: agent.clone(), path: path.display().to_string(), state: state.into() }
            })
            .collect()
    }

    pub fn list(&self) -> Vec<SkillView> {
        let _guard = self.lock.lock().unwrap();
        let manifest = self.manifest();
        let Ok(entries) = std::fs::read_dir(&self.root) else { return Vec::new() };
        let mut skills: Vec<SkillView> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if !valid_skill_name(&name) {
                    return None;
                }
                let files = read_files(&e.path());
                let description = files.iter().find(|(p, _)| p == "SKILL.md").and_then(|(_, b)| skill_description(&String::from_utf8_lossy(b)));
                Some(SkillView {
                    hash: skill_hash(files.iter().map(|(p, b)| (p.as_str(), b.as_slice()))),
                    files: files.len() as u32,
                    links: self.links_of(&name),
                    updated_at: manifest.updated.get(&name).copied().unwrap_or(0),
                    description,
                    name,
                })
            })
            .collect();
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        skills
    }

    /// Replaces the skill folder with `files` and links it for every agent.
    pub fn put(&self, name: &str, files: &[SkillFile]) -> ActionResult<SkillView> {
        if !valid_skill_name(name) {
            return Err(bad("invalid skill name"));
        }
        if files.is_empty() || files.len() > MAX_FILES {
            return Err(bad("a skill needs between 1 and 500 files"));
        }
        let mut decoded = Vec::with_capacity(files.len());
        let mut total = 0;
        for f in files {
            let rel = safe_relative(&f.path).ok_or_else(|| bad(format!("invalid path: {}", f.path)))?;
            let bytes = STANDARD.decode(&f.content).map_err(|_| bad(format!("{} is not valid base64", f.path)))?;
            total += bytes.len();
            decoded.push((rel, bytes));
        }
        if total > MAX_SKILL_BYTES {
            return Err(bad("skill too large (8 MB max)"));
        }
        if !decoded.iter().any(|(p, _)| p == Path::new("SKILL.md")) {
            return Err(bad("SKILL.md is missing"));
        }
        {
            let _guard = self.lock.lock().unwrap();
            std::fs::create_dir_all(&self.root).map_err(io)?;
            let tmp = self.root.join(format!(".tmp-{name}"));
            let old = self.root.join(format!(".old-{name}"));
            let _ = std::fs::remove_dir_all(&tmp);
            let _ = std::fs::remove_dir_all(&old);
            for (rel, bytes) in &decoded {
                let path = tmp.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).map_err(io)?;
                std::fs::write(&path, bytes).map_err(io)?;
                #[cfg(unix)]
                if rel.extension().is_some_and(|e| e == "sh" || e == "py") || rel.starts_with("scripts") {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
                }
            }
            let dir = self.root.join(name);
            if dir.exists() {
                std::fs::rename(&dir, &old).map_err(io)?;
            }
            std::fs::rename(&tmp, &dir).map_err(io)?;
            let _ = std::fs::remove_dir_all(&old);
            let mut manifest = self.manifest();
            manifest.updated.insert(name.to_string(), now_secs());
            self.link(name, &mut manifest);
            self.save(&manifest)?;
        }
        self.list().into_iter().find(|s| s.name == name).ok_or_else(|| ActionError::new(500, "skill_missing", "skill not stored"))
    }

    /// Creates the missing links of `name` (never replaces what is not ours).
    fn link(&self, name: &str, manifest: &mut Manifest) {
        for (_, dir) in &self.targets {
            let path = dir.join(name);
            if self.ours(&path, name) {
                continue;
            }
            if path.symlink_metadata().is_ok() {
                // A dangling link we created earlier can be replaced.
                if manifest.links.contains(&path) && std::fs::read_link(&path).is_ok() {
                    let _ = std::fs::remove_file(&path);
                } else {
                    continue;
                }
            }
            if std::fs::create_dir_all(dir).is_err() {
                continue;
            }
            #[cfg(unix)]
            if std::os::unix::fs::symlink(self.root.join(name), &path).is_ok() && !manifest.links.contains(&path) {
                manifest.links.push(path);
            }
        }
    }

    pub fn delete(&self, name: &str) -> ActionResult<()> {
        if !valid_skill_name(name) {
            return Err(bad("invalid skill name"));
        }
        let _guard = self.lock.lock().unwrap();
        let dir = self.root.join(name);
        if !dir.exists() {
            return Err(ActionError::new(404, "not_found", "skill not found"));
        }
        let mut manifest = self.manifest();
        for (_, target) in &self.targets {
            let path = target.join(name);
            if self.ours(&path, name) {
                let _ = std::fs::remove_file(&path);
                manifest.links.retain(|l| l != &path);
            }
        }
        std::fs::remove_dir_all(&dir).map_err(io)?;
        manifest.updated.remove(name);
        self.save(&manifest)
    }
}

fn io(e: std::io::Error) -> ActionError {
    ActionError::new(500, "io_error", e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, text: &str) -> SkillFile {
        SkillFile { path: path.into(), content: STANDARD.encode(text) }
    }

    #[test]
    fn put_links_and_respects_foreign_skills() {
        let base = std::env::temp_dir().join(format!("huntaway-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let claude = base.join("claude");
        let codex = base.join("codex");
        std::fs::create_dir_all(codex.join("reviewer")).unwrap(); // installed by hand
        let skills = Skills::with(base.join("store"), vec![("claude".into(), claude.clone()), ("codex".into(), codex.clone())]);

        let md = "---\nname: reviewer\ndescription: Reviews diffs\n---\nBody";
        let view = skills.put("reviewer", &[file("SKILL.md", md), file("scripts/run.sh", "echo hi")]).unwrap();
        assert_eq!(view.description.as_deref(), Some("Reviews diffs"));
        assert_eq!(view.files, 2);
        assert_eq!(view.links[0].state, "linked");
        assert_eq!(view.links[1].state, "conflict");
        assert!(claude.join("reviewer/SKILL.md").exists());
        assert_eq!(view.hash, skill_hash([("SKILL.md", md.as_bytes()), ("scripts/run.sh", "echo hi".as_bytes())]));

        assert!(skills.put("bad/name", &[file("SKILL.md", md)]).is_err());
        assert!(skills.put("x", &[file("../evil", "x"), file("SKILL.md", md)]).is_err());
        assert!(skills.put("x", &[file("README.md", "x")]).is_err());

        skills.delete("reviewer").unwrap();
        assert!(claude.join("reviewer").symlink_metadata().is_err());
        assert!(codex.join("reviewer").exists());
        assert!(skills.list().is_empty());
    }
}
