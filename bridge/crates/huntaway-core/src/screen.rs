//! Agent-agnostic helpers over the visible screen (fallback level of PRD §5.7).
//!
//! Only meaningful while Herdr reports the agent as `blocked`: the screen then
//! shows a menu (permission prompt, question, trust dialog…).

pub use huntaway_api::ScreenOption;

const CURSORS: [char; 3] = ['❯', '›', '>'];
const MENU_HINTS: [&str; 4] = ["Enter to", "to navigate", "Esc to cancel", "to select"];

struct Line<'a> {
    indent: usize,
    text: &'a str,
    selected: bool,
}

fn split_line(raw: &str) -> Line<'_> {
    let inner = raw.trim_start_matches(|c: char| "│┃|".contains(c)).trim_end_matches(|c: char| c.is_whitespace() || "│┃|".contains(c));
    let after_ws = inner.trim_start();
    let selected = after_ws.starts_with(CURSORS);
    let text = after_ws.trim_start_matches(CURSORS).trim_start();
    Line { indent: inner.chars().count() - text.chars().count(), text, selected }
}

fn is_rule(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| "─━╌╍-═╭╮╰╯".contains(c))
}

/// `"2. Bleu"` → `(2, "Bleu")`.
fn numbered_prefix(text: &str) -> Option<(u32, &str)> {
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &text[digits..];
    let label = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?.trim();
    (!label.is_empty()).then(|| Some((text[..digits].parse().ok()?, label))).flatten()
}

/// Extracts the last menu shown on screen: numbered (`❯ 1. Yes`) or, when
/// the screen carries a menu hint ("Enter to confirm"…), cursor-only.
pub fn numbered_options(screen: &str) -> Vec<ScreenOption> {
    let lines: Vec<Line> = screen.lines().map(split_line).collect();
    let numbered = numbered_menu(&lines);
    if !numbered.is_empty() {
        return numbered;
    }
    if MENU_HINTS.iter().any(|h| screen.contains(h)) {
        return cursor_menu(&lines);
    }
    Vec::new()
}

fn numbered_menu(lines: &[Line]) -> Vec<ScreenOption> {
    let mut blocks: Vec<Vec<ScreenOption>> = Vec::new();
    let mut current: Vec<ScreenOption> = Vec::new();
    let mut label_indent = 0;

    for line in lines {
        match numbered_prefix(line.text) {
            Some((n, label)) if n == current.len() as u32 + 1 || n == 1 => {
                if n == 1 && !current.is_empty() {
                    blocks.push(std::mem::take(&mut current));
                }
                label_indent = line.indent + line.text.len() - label.len();
                current.push(ScreenOption { number: n, label: label.into(), detail: None, selected: line.selected, numbered: true });
            }
            _ if current.is_empty() => {}
            // Continuation: indented at least as far as the option label.
            None if !line.text.is_empty() && !is_rule(line.text) && line.indent >= label_indent.saturating_sub(1) => {
                let last = current.last_mut().expect("non-empty");
                let detail = last.detail.get_or_insert_with(String::new);
                if !detail.is_empty() {
                    detail.push(' ');
                }
                detail.push_str(line.text);
            }
            // Blank lines and separators may sit between options.
            None if line.text.is_empty() || is_rule(line.text) => {}
            _ => blocks.push(std::mem::take(&mut current)),
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks.into_iter().rev().find(|b| b.len() >= 2).unwrap_or_default()
}

/// Cursor-only menu: the selected line plus siblings at the same indentation.
fn cursor_menu(lines: &[Line]) -> Vec<ScreenOption> {
    let Some(sel) = lines.iter().rposition(|l| l.selected && !l.text.is_empty()) else {
        return Vec::new();
    };
    let indent = lines[sel].indent;
    let sibling = |l: &Line| l.indent == indent && !l.text.is_empty() && !is_rule(l.text);
    let start = (0..sel).rev().take_while(|&i| sibling(&lines[i])).last().unwrap_or(sel);
    let end = (sel + 1..lines.len()).take_while(|&i| sibling(&lines[i])).last().unwrap_or(sel);
    if end == start {
        return Vec::new();
    }
    lines[start..=end]
        .iter()
        .enumerate()
        .map(|(i, l)| ScreenOption {
            number: i as u32 + 1,
            label: l.text.to_string(),
            detail: None,
            selected: l.selected,
            numbered: false,
        })
        .collect()
}

/// Keys that pick `number` in `options`: the digit for numbered menus,
/// arrows then Enter for cursor menus.
pub fn keys_for_choice(options: &[ScreenOption], number: u32) -> Option<Vec<String>> {
    let target = options.iter().find(|o| o.number == number)?;
    if target.numbered {
        return Some(vec![number.to_string()]);
    }
    let current = options.iter().find(|o| o.selected).map_or(1, |o| o.number) as i64;
    let delta = number as i64 - current;
    let arrow = if delta > 0 { "down" } else { "up" };
    let mut keys = vec![arrow.to_string(); delta.unsigned_abs() as usize];
    keys.push("enter".into());
    Some(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(opts: &[ScreenOption]) -> Vec<&str> {
        opts.iter().map(|o| o.label.as_str()).collect()
    }

    #[test]
    fn parses_permission_prompt_with_wrapped_options() {
        // Captured from Claude Code 2.1 in a Herdr pane.
        let screen = "\
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /private/tmp/spike-project from this
      project
   3. Yes, and switch to auto mode · auto mode handles these prompts for
      you
   4. No
 Esc to cancel · Tab to amend";
        let opts = numbered_options(screen);
        assert_eq!(labels(&opts), ["Yes", "Yes, and always allow access to", "Yes, and switch to auto mode · auto mode handles these prompts for", "No"]);
        assert!(opts[0].selected && opts[0].numbered);
        assert_eq!(opts[1].detail.as_deref(), Some("/private/tmp/spike-project from this project"));
        assert_eq!(keys_for_choice(&opts, 4), Some(vec!["4".to_string()]));
    }

    #[test]
    fn parses_boxed_prompt() {
        let screen = "\
╭──────────────────────────────╮
│ Bash command                 │
│ ❯ 1. Yes                     │
│   2. No                      │
╰──────────────────────────────╯";
        assert_eq!(labels(&numbered_options(screen)), ["Yes", "No"]);
    }

    #[test]
    fn parses_question_with_descriptions_across_separator() {
        let screen = "\
Quelle couleur préfères-tu ?
❯ 1. Rouge
     La couleur rouge
  2. Bleu
     La couleur bleue
  3. Type something.
─────────────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel";
        let opts = numbered_options(screen);
        assert_eq!(labels(&opts), ["Rouge", "Bleu", "Type something.", "Chat about this"]);
        assert_eq!(opts[0].detail.as_deref(), Some("La couleur rouge"));
    }

    #[test]
    fn parses_cursor_menu_and_computes_arrows() {
        // Claude Code trust dialog.
        let screen = "\
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel";
        let opts = numbered_options(screen);
        assert_eq!(labels(&opts), ["No, exit", "Yes, I trust this folder"]);
        assert!(!opts[0].numbered);
        assert_eq!(keys_for_choice(&opts, 2), Some(vec!["down".to_string(), "enter".to_string()]));
        assert_eq!(keys_for_choice(&opts, 1), Some(vec!["enter".to_string()]));
    }

    #[test]
    fn input_box_is_not_a_menu() {
        let screen = "\
──────────────────────────
❯ Écris un très long texte sur l'histoire des chiens de
  berger, directement dans ta réponse.
──────────────────────────
  ⏸ manual mode on";
        assert!(numbered_options(screen).is_empty());
    }

    #[test]
    fn keeps_last_block_and_ignores_lists_of_one() {
        let screen = "1. old\n2. old two\n\nsome text\n1. only one\nfoo\n❯ 1. A\n  2. B";
        assert_eq!(labels(&numbered_options(screen)), ["A", "B"]);
    }
}
