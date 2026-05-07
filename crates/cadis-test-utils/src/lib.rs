//! Shared test utilities and fixture factories for the C.A.D.I.S. workspace.
//!
//! This crate provides common helpers used across multiple test suites,
//! reducing duplication and ensuring consistent test fixtures.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use cadis_protocol::{
    CadisEvent, EmptyPayload, EventEnvelope, EventId, SessionEventPayload, SessionId, Timestamp,
};

/// Create a unique temporary directory suitable for use as a test workspace.
///
/// Each invocation produces a directory whose name is derived from `prefix`,
/// the current PID, and the system clock to prevent collisions across tests
/// running in parallel.
pub fn test_workspace(prefix: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "cadis-{prefix}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos()
    ));
    fs::create_dir_all(&path).expect("test workspace should be created");
    path
}

/// Build a minimal [`EventEnvelope`] with no session association.
///
/// Useful for unit tests that exercise event buses, replay buffers, and
/// serialisation round-trips without needing session context.
pub fn event(event_id: &str) -> EventEnvelope {
    EventEnvelope::new(
        EventId::from(event_id),
        Timestamp::new_utc("2026-04-26T00:00:00Z").expect("timestamp should parse"),
        "cadis-test",
        None,
        CadisEvent::DaemonStarted(EmptyPayload::default()),
    )
}

/// Build a minimal [`EventEnvelope`] tied to a specific session.
///
/// Useful for tests that exercise session-scoped event filtering and replay.
pub fn session_event(event_id: &str, session_id: &str) -> EventEnvelope {
    let session_id = SessionId::from(session_id);
    EventEnvelope::new(
        EventId::from(event_id),
        Timestamp::new_utc("2026-04-26T00:00:00Z").expect("timestamp should parse"),
        "cadis-test",
        Some(session_id.clone()),
        CadisEvent::SessionStarted(SessionEventPayload {
            session_id,
            title: None,
        }),
    )
}
