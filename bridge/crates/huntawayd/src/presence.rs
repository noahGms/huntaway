//! Desktop presence (PRD desktop §11): while a desktop app is in front of
//! the user, it shows notifications itself, so phones get no push.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A desktop that stopped reporting for this long counts as away.
pub const PRESENCE_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Presence {
    active: Mutex<HashMap<String, Instant>>,
}

impl Presence {
    pub fn set(&self, device_id: &str, active: bool) {
        let mut map = self.active.lock().unwrap();
        if active {
            map.insert(device_id.to_string(), Instant::now());
        } else {
            map.remove(device_id);
        }
    }

    /// A desktop app is active now.
    pub fn desktop_active(&self) -> bool {
        let mut map = self.active.lock().unwrap();
        map.retain(|_, at| at.elapsed() < PRESENCE_TTL);
        !map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_expires_and_clears() {
        let p = Presence::default();
        assert!(!p.desktop_active());
        p.set("d1", true);
        assert!(p.desktop_active());
        p.set("d1", false);
        assert!(!p.desktop_active());
        p.active.lock().unwrap().insert("d2".into(), Instant::now() - PRESENCE_TTL);
        assert!(!p.desktop_active());
    }
}
