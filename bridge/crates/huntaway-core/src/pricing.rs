//! Indicative cost of a conversation at public API prices. Subscriptions
//! (Claude Max, ChatGPT Plus…) are billed differently: the app labels this
//! as an estimate.

use crate::model::Usage;

/// USD per million tokens: (input, output, cache read, cache write).
fn prices(model: &str) -> Option<(f64, f64, f64, f64)> {
    let m = model.to_ascii_lowercase();
    let anthropic = |input: f64, output: f64| Some((input, output, input * 0.1, input * 1.25));
    if m.contains("opus") {
        // Opus 4.5 and later are priced lower than the first Opus models.
        let legacy = ["opus-4-0", "opus-4-1", "opus-4-2", "3-opus", "opus-4-2025", "opus-4@"].iter().any(|v| m.contains(v)) || m.ends_with("opus-4");
        return if legacy { anthropic(15.0, 75.0) } else { anthropic(5.0, 25.0) };
    }
    if m.contains("sonnet") {
        return anthropic(3.0, 15.0);
    }
    if m.contains("haiku") {
        return if m.contains("3-5") || m.contains("3-haiku") { anthropic(0.8, 4.0) } else { anthropic(1.0, 5.0) };
    }
    if m.starts_with("gpt-") || m.starts_with("o3") || m.starts_with("o4") || m.contains("codex") {
        let (input, output) = if m.contains("nano") {
            (0.05, 0.4)
        } else if m.contains("mini") {
            (0.25, 2.0)
        } else {
            (1.25, 10.0)
        };
        return Some((input, output, input * 0.1, input));
    }
    None
}

pub fn estimate(usage: &Usage) -> Option<f64> {
    let (input, output, read, write) = prices(usage.model.as_deref()?)?;
    let m = 1_000_000.0;
    let cost = usage.input_tokens as f64 * input / m
        + usage.output_tokens as f64 * output / m
        + usage.cache_read_tokens as f64 * read / m
        + usage.cache_write_tokens as f64 * write / m;
    Some((cost * 10_000.0).round() / 10_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_families() {
        let usage = |model: &str| Usage { model: Some(model.into()), input_tokens: 1_000_000, ..Usage::default() };
        assert_eq!(estimate(&usage("claude-sonnet-4-5")), Some(3.0));
        assert_eq!(estimate(&usage("claude-opus-4-1-20250805")), Some(15.0));
        assert_eq!(estimate(&usage("claude-opus-5-5")), Some(5.0));
        assert_eq!(estimate(&usage("gpt-5.4")), Some(1.25));
        assert_eq!(estimate(&usage("mystery")), None);
    }
}
