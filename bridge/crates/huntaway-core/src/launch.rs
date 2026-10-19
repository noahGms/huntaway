//! Recognizes shell commands that start or prompt another Herdr agent
//! (`herdr agent start reviewer --kind codex --pane w1:p4`, `herdr agent
//! prompt reviewer "…"`, `huntawayd dispatch …`), so the agent that ran them
//! can be shown as the parent of the agents it started.

use crate::model::AgentLaunch;

/// The agent launch named by `command`, if it starts or prompts a Herdr
/// agent on this machine. Several commands for the same agent (start, then
/// prompt) are merged.
pub fn agent_launch(command: &str) -> Option<AgentLaunch> {
    let mut found: Option<AgentLaunch> = None;
    for words in split_commands(command) {
        let Some(launch) = parse(&words) else { continue };
        match &mut found {
            Some(f) if f.name.is_none() || launch.name.is_none() || f.name == launch.name => {
                f.start |= launch.start;
                f.name = f.name.take().or(launch.name);
                f.pane_id = f.pane_id.take().or(launch.pane_id);
                f.kind = f.kind.take().or(launch.kind);
                f.prompt = f.prompt.take().or(launch.prompt);
            }
            Some(_) => {}
            None => found = Some(launch),
        }
    }
    found
}

/// A value usable as-is: not a shell variable or substitution.
fn literal(word: &str) -> Option<String> {
    (!word.is_empty() && !word.contains('$') && !word.contains('`')).then(|| word.to_string())
}

fn parse(words: &[String]) -> Option<AgentLaunch> {
    let pos = words.iter().position(|w| {
        let base = w.rsplit('/').next().unwrap_or(w);
        base == "herdr" || base == "huntawayd"
    })?;
    let program = words[pos].rsplit('/').next().unwrap_or(&words[pos]).to_string();
    let mut rest = words[pos + 1..].iter().map(String::as_str).peekable();
    // Global options before the command. Another machine's agents are not ours.
    while let Some(w) = rest.peek().copied() {
        match w {
            "--machine" | "--remote" => return None,
            "--session" => {
                rest.next();
                rest.next();
            }
            w if w.starts_with("--machine=") || w.starts_with("--remote=") => return None,
            w if w.starts_with("--") => {
                rest.next();
            }
            _ => break,
        }
    }
    let args: Vec<&str> = rest.collect();
    let mut launch = AgentLaunch::default();
    let options = if program == "huntawayd" {
        if args.first() != Some(&"dispatch") {
            return None;
        }
        launch.start = true;
        &args[1..]
    } else {
        match args.as_slice() {
            ["agent", "start", name, ..] => {
                launch.start = true;
                launch.name = literal(name);
                &args[3..]
            }
            ["agent", "prompt", name, ..] => {
                launch.name = literal(name);
                &args[3..]
            }
            _ => return None,
        }
    };
    let mut positional = Vec::new();
    let mut it = options.iter();
    while let Some(&w) = it.next() {
        match w {
            "--" => break,
            "--kind" | "--role" => {
                let value = it.next().and_then(|v| literal(v));
                if w == "--kind" || launch.kind.is_none() {
                    launch.kind = value;
                }
            }
            "--pane" => launch.pane_id = it.next().and_then(|v| literal(v)),
            "--name" => launch.name = it.next().and_then(|v| literal(v)),
            "--timeout" | "--cwd" | "--until" | "--model" | "--source" | "--lines" => {
                it.next();
            }
            w if w.starts_with("--") => {}
            w => positional.push(w),
        }
    }
    if let Some(text) = positional.first() {
        launch.prompt = literal(text).or_else(|| Some(text.to_string()).filter(|t| !t.starts_with('$')));
    }
    Some(launch)
}

/// Splits a shell command line into simple commands (on `;`, `&&`, `||`,
/// `|`, newlines), honoring quotes. Good enough for the commands agents write.
fn split_commands(line: &str) -> Vec<Vec<String>> {
    let mut commands = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    let end_word = |words: &mut Vec<String>, word: &mut String, in_word: &mut bool| {
        if *in_word {
            words.push(std::mem::take(word));
            *in_word = false;
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                in_word = true;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => {
                            if let Some(&n) = chars.peek() {
                                if matches!(n, '"' | '\\' | '$' | '`') {
                                    word.push(n);
                                    chars.next();
                                    continue;
                                }
                            }
                            word.push('\\');
                        }
                        c => word.push(c),
                    }
                }
            }
            '\\' => {
                match chars.next() {
                    Some('\n') | None => {}
                    Some(n) => {
                        in_word = true;
                        word.push(n);
                    }
                }
            }
            ';' | '|' | '&' | '\n' | '(' | ')' => {
                end_word(&mut words, &mut word, &mut in_word);
                if !words.is_empty() {
                    commands.push(std::mem::take(&mut words));
                }
            }
            c if c.is_whitespace() => end_word(&mut words, &mut word, &mut in_word),
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    end_word(&mut words, &mut word, &mut in_word);
    if !words.is_empty() {
        commands.push(words);
    }
    commands
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_then_prompt_are_merged() {
        let l = agent_launch(
            r#"herdr agent start reviewer --kind codex --pane w1:p4 && herdr agent prompt reviewer "Review the diff, report \"bugs\"" --wait --timeout 120000"#,
        )
        .unwrap();
        assert!(l.start);
        assert_eq!(l.name.as_deref(), Some("reviewer"));
        assert_eq!(l.pane_id.as_deref(), Some("w1:p4"));
        assert_eq!(l.kind.as_deref(), Some("codex"));
        assert_eq!(l.prompt.as_deref(), Some(r#"Review the diff, report "bugs""#));
    }

    #[test]
    fn prompt_only_and_variables() {
        let l = agent_launch("herdr agent prompt tests 'run the suite'").unwrap();
        assert!(!l.start);
        assert_eq!(l.prompt.as_deref(), Some("run the suite"));
        let l = agent_launch(r#"PANE=$(herdr pane split --current --direction right | jq -r .result.pane.pane_id); herdr agent start docs --kind claude --pane "$PANE""#).unwrap();
        assert_eq!(l.name.as_deref(), Some("docs"));
        assert_eq!(l.pane_id, None);
    }

    #[test]
    fn dispatch_and_other_machines() {
        let l = agent_launch(r#"huntawayd dispatch --role review --name rev1 "check auth.rs""#).unwrap();
        assert!(l.start);
        assert_eq!(l.name.as_deref(), Some("rev1"));
        assert_eq!(l.kind.as_deref(), Some("review"));
        assert_eq!(l.prompt.as_deref(), Some("check auth.rs"));
        assert!(agent_launch("herdr --machine prod agent start x --kind codex").is_none());
        assert!(agent_launch("herdr agent list").is_none());
        assert!(agent_launch("cargo test").is_none());
    }
}
