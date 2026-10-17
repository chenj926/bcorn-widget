use serde_json::Value;
use std::{fs, io::Write, path::Path};

pub const MAX_DATA_BYTES: usize = 8 * 1024 * 1024;

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

pub fn clear_cache(directory: &Path) -> Result<(), String> {
    // Remove our incomplete-write artifact first. If that fails, the last good
    // cache remains intact; never recursively remove directories or preferences.
    for name in ["cache.json.tmp", "cache.json"] {
        match fs::remove_file(directory.join(name)) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn required_text<'a>(object: &'a Value, key: &str) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 16000)
        .ok_or_else(|| format!("Expected nonempty text for {key}"))
}
fn array<'a>(object: &'a Value, key: &str, maximum: usize) -> Result<&'a Vec<Value>, String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .filter(|a| a.len() <= maximum)
        .ok_or_else(|| format!("Expected {key} array with at most {maximum} entries"))
}
fn valid_time(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && [b[0], b[1], b[3], b[4]].iter().all(u8::is_ascii_digit)
        && &value[..2] <= "23"
        && &value[3..] <= "59"
}
fn valid_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || ![b[0], b[1], b[2], b[3], b[5], b[6], b[8], b[9]]
            .iter()
            .all(u8::is_ascii_digit)
    {
        return false;
    }
    let year: u32 = value[..4].parse().unwrap_or(0);
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..].parse().unwrap_or(0);
    let maximum = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    (1900..=9998).contains(&year) && day >= 1 && day <= maximum
}
pub fn validate_data(data: &Value) -> Result<(), String> {
    if serde_json::to_vec(data).map_err(|e| e.to_string())?.len() > MAX_DATA_BYTES {
        return Err("Import exceeds the 8 MiB limit".into());
    }
    for term in array(data, "terms", 100)? {
        required_text(term, "id")?;
        required_text(term, "name")?;
        let start = required_text(term, "start")?;
        let end = required_text(term, "end")?;
        if !valid_date(start) || !valid_date(end) || start > end {
            return Err("Invalid term date range".into());
        }
        let courses = array(term, "courses", 1000)?;
        for course in courses {
            required_text(course, "code")?;
        }
        for meeting in array(term, "meetings", 3000)? {
            let code = required_text(meeting, "code")?;
            if !courses
                .iter()
                .any(|c| c.get("code").and_then(Value::as_str) == Some(code))
            {
                return Err("Meeting course is missing".into());
            }
            if !meeting
                .get("day")
                .and_then(Value::as_u64)
                .is_some_and(|d| (1..=7).contains(&d))
            {
                return Err("Invalid meeting weekday".into());
            }
            let start = required_text(meeting, "start")?;
            let end = required_text(meeting, "end")?;
            if !valid_time(start) || !valid_time(end) || start >= end {
                return Err("Invalid meeting time range".into());
            }
            for key in ["from", "until"] {
                if let Some(value) = meeting.get(key).filter(|v| !v.is_null()) {
                    if !value.as_str().is_some_and(valid_date) {
                        return Err(format!("Invalid {key} date"));
                    }
                }
            }
            if meeting.get("exdates").is_some() {
                for date in array(meeting, "exdates", 2000)? {
                    if !date.as_str().is_some_and(valid_date) {
                        return Err("Invalid excluded date".into());
                    }
                }
            }
        }
    }
    if let Some(transcript) = data.get("transcript").filter(|v| !v.is_null()) {
        for session in array(transcript, "sessions", 100)? {
            required_text(session, "name")?;
            for course in array(session, "courses", 1000)? {
                required_text(course, "code")?;
            }
            if session.get("notes").is_some() {
                array(session, "notes", 1000)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_non_timetable_cache() {
        assert!(validate_data(&json!({"credentials":"not a timetable"})).is_err());
    }
    #[test]
    fn accepts_empty_and_manual_terms() {
        assert!(validate_data(&json!({"terms":[]})).is_ok());
        assert!(validate_data(&json!({"terms":[{"id":"manual","name":"Manual","start":"2026-09-01","end":"2026-12-01","courses":[],"meetings":[]}]})).is_ok());
    }
    #[test]
    fn rejects_broken_renderer_shapes() {
        for data in [
            json!({"terms":[{"id":"x","name":"X","meetings":[]}]}),
            json!({"terms":[],"transcript":{"sessions":"invalid"}}),
        ] {
            assert!(validate_data(&data).is_err());
        }
    }
    #[test]
    fn dates_and_times_reject_invalid_values() {
        assert!(valid_date("2028-02-29"));
        assert!(!valid_date("2026-02-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-01-32"));
        assert!(!valid_date("🦀"));
        assert!(valid_time("23:59"));
        assert!(!valid_time("24:00"));
        assert!(!valid_time("9:00"));
        assert!(!valid_time("🦀:"));
    }
    #[test]
    fn validates_meeting_membership_and_time_range() {
        let mut data = json!({"terms":[{"id":"term","name":"Term","start":"2026-09-01","end":"2026-12-01","courses":[{"code":"ABC100"}],"meetings":[{"code":"ABC100","day":1,"start":"10:00","end":"11:00","exdates":["2026-10-12"]}]}]});
        assert!(validate_data(&data).is_ok());
        data["terms"][0]["meetings"][0]["code"] = json!("OTHER");
        assert!(validate_data(&data).is_err());
        data["terms"][0]["meetings"][0]["code"] = json!("ABC100");
        data["terms"][0]["meetings"][0]["end"] = json!("09:00");
        assert!(validate_data(&data).is_err());
    }
    #[test]
    fn clearing_cache_preserves_window_preferences_and_other_files() {
        let directory =
            std::env::temp_dir().join(format!("acorn-clear-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("cache.json"), br#"{"terms":[]}"#).unwrap();
        fs::write(directory.join("cache.json.tmp"), b"incomplete").unwrap();
        fs::write(directory.join("window.json"), br#"{"pinned":true}"#).unwrap();
        fs::write(directory.join("unrelated.txt"), b"keep").unwrap();
        clear_cache(&directory).unwrap();
        assert!(!directory.join("cache.json").exists());
        assert!(!directory.join("cache.json.tmp").exists());
        assert_eq!(
            fs::read(directory.join("window.json")).unwrap(),
            br#"{"pinned":true}"#
        );
        assert_eq!(fs::read(directory.join("unrelated.txt")).unwrap(), b"keep");
        clear_cache(&directory).unwrap(); // Missing cache is already cleared.
        fs::write(directory.join("cache.json"), b"last good cache").unwrap();
        fs::create_dir(directory.join("cache.json.tmp")).unwrap();
        assert!(clear_cache(&directory).is_err());
        assert_eq!(
            fs::read(directory.join("cache.json")).unwrap(),
            b"last good cache"
        );
        fs::remove_dir(directory.join("cache.json.tmp")).unwrap();
        clear_cache(&directory).unwrap();
        fs::create_dir(directory.join("cache.json")).unwrap();
        assert!(clear_cache(&directory).is_err()); // Never recursively delete.
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn atomic_cache_write_replaces_complete_content() {
        let directory =
            std::env::temp_dir().join(format!("acorn-cache-test-{}", std::process::id()));
        let path = directory.join("cache.json");
        atomic_write(&path, br#"{"terms":[]}"#).unwrap();
        assert_eq!(fs::read(&path).unwrap(), br#"{"terms":[]}"#);
        atomic_write(&path, br#"{"terms":[],"transcript":null}"#).unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            br#"{"terms":[],"transcript":null}"#
        );
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
