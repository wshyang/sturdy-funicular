//! Test-clock seam (legacy harness F6 / setTestNow).
//! Freezes the harness clock for deterministic artifacts; does not mutate the
//! real server process clock.

use chrono::{SecondsFormat, Utc};
use std::sync::Mutex;

static TEST_NOW: Mutex<Option<String>> = Mutex::new(None);

pub fn set_test_now(value: Option<&str>) {
    *TEST_NOW.lock().unwrap() = value.map(str::to_string);
}

pub fn now() -> String {
    if let Some(frozen) = TEST_NOW.lock().unwrap().as_ref() {
        return frozen.clone();
    }
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
