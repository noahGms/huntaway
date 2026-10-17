//! Read-only access to an agent's project: file search for `@` mentions,
//! `git status` / `git diff`, and attachments uploaded by the app.

use std::path::{Path, PathBuf};
use std::process::Command;

use huntaway_api::{FileMatch, GitFileStatus, GitStatus};

use crate::auth::now_secs;
use crate::config::state_dir;

/// Directories never worth listing, even outside a git repository.
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "build", "dist", ".next", ".dart_tool", ".venv", "__pycache__"];
const MAX_SCANNED: usize = 20_000;

/// Files of `root` (respecting `.gitignore` in git repositories) matching
/// `query` as a case-insensitive subsequence; best matches first.
pub fn search(root: &Path, query: &str, limit: usize) -> Vec<FileMatch> {
    let paths = git_files(root).unwrap_or_else(|| walk(root));
    let q: Vec<char> = query.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let mut scored: Vec<(i64, String)> = paths
        .into_iter()
        .filter_map(|p| score(&p, &q).map(|s| (s, p)))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, path)| FileMatch { path, is_dir: false }).collect()
}

/// Subsequence match score: consecutive characters and matches in the file
/// name count more. `None` when `q` is not a subsequence of `path`.
fn score(path: &str, q: &[char]) -> Option<i64> {
    if q.is_empty() {
        return Some(0);
    }
    let lower: Vec<char> = path.to_lowercase().chars().collect();
    let name_start = path.rfind('/').map_or(0, |i| path[..=i].chars().count());
    let mut qi = 0;
    let mut score = 0i64;
    let mut prev: Option<usize> = None;
    for (i, c) in lower.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            score += 1;
            if prev == Some(i.wrapping_sub(1)) {
                score += 5;
            }
            if i >= name_start {
                score += 3;
            }
            prev = Some(i);
            qi += 1;
        }
    }
    (qi == q.len()).then_some(score)
}

fn git_files(root: &Path) -> Option<Vec<String>> {
    let out = Command::new("git")
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).lines().take(MAX_SCANNED).map(str::to_string).collect())
}

fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
                if out.len() >= MAX_SCANNED {
                    return out;
                }
            }
        }
    }
    out
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").args(args).current_dir(root).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn git_status(root: &Path) -> Result<GitStatus, String> {
    let porcelain = git(root, &["status", "--porcelain=v1", "--branch", "--untracked-files=all"])?;
    let mut branch = None;
    let mut files = Vec::new();
    for line in porcelain.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let rest = rest.strip_prefix("No commits yet on ").unwrap_or(rest);
            branch = Some(rest.split("...").next().unwrap_or(rest).to_string());
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let path = line[3..].rsplit(" -> ").next().unwrap_or(&line[3..]).trim_matches('"').to_string();
        files.push(GitFileStatus { path, status: line[..2].to_string(), additions: None, deletions: None });
    }
    // Line counts against HEAD for tracked files.
    if let Ok(numstat) = git(root, &["diff", "HEAD", "--numstat"]) {
        for line in numstat.lines() {
            let mut parts = line.split('\t');
            let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
            if let Some(f) = files.iter_mut().find(|f| f.path == path) {
                f.additions = add.parse().ok();
                f.deletions = del.parse().ok();
            }
        }
    }
    Ok(GitStatus { branch, files })
}

/// Unified diff against HEAD, for one file or the whole tree. Untracked files
/// are shown as entirely added.
pub fn git_diff(root: &Path, path: Option<&str>) -> Result<String, String> {
    if let Some(p) = path {
        if p.contains("..") || p.starts_with('/') {
            return Err("chemin invalide".into());
        }
        let tracked = git(root, &["ls-files", "--error-unmatch", p]).is_ok();
        if !tracked {
            let out = Command::new("git")
                .args(["diff", "--no-index", "--", "/dev/null", p])
                .current_dir(root)
                .output()
                .map_err(|e| e.to_string())?;
            return Ok(String::from_utf8_lossy(&out.stdout).to_string());
        }
        return git(root, &["diff", "HEAD", "--", p]);
    }
    git(root, &["diff", "HEAD"])
}

/// Max attachment size.
pub const UPLOAD_MAX: usize = 25 * 1024 * 1024;

/// Saves an attachment under `<state dir>/uploads/` and returns its path.
pub fn save_upload(name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let dir = state_dir().join("uploads");
    std::fs::create_dir_all(&dir)?;
    let clean: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let clean = if clean.trim_matches('.').is_empty() { "fichier".to_string() } else { clean };
    let path = dir.join(format!("{}-{}", now_secs(), clean));
    std::fs::write(&path, bytes)?;
    prune_uploads(&dir);
    Ok(path)
}

/// Removes attachments older than a week.
fn prune_uploads(dir: &Path) {
    let week = std::time::Duration::from_secs(7 * 86_400);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > week);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_scores_prefer_file_names() {
        let q: Vec<char> = "sess".chars().collect();
        assert!(score("src/auth/session.ts", &q).unwrap() > score("s/e/s/s/x.ts", &q).unwrap());
        assert!(score("src/auth/session.ts", &"zz".chars().collect::<Vec<_>>()).is_none());
    }

    #[test]
    fn walk_skips_heavy_dirs() {
        let root = std::env::temp_dir().join(format!("huntaway-files-{}", std::process::id()));
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("node_modules/x/a.js"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        let found = search(&root, "main", 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "src/main.rs");
    }
}
