use super::{hash, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub provider: Provider,
    pub state: String,
    pub account_label: String,
    pub target: Option<Target>,
    pub enabled: bool,
    pub owned_count: usize,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub written: usize,
    pub unchanged: usize,
    pub deleted: usize,
    pub pending_delete_count: usize,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Series {
    pub id: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub time_zone: String,
    pub reminders: Vec<u32>,
    pub occurrences: Vec<Occurrence>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Occurrence {
    pub key: String,
    pub start_millis: i64,
    pub end_millis: i64,
}
pub(super) const EXTENSION: &str = "String {3f3b6b9b-539b-4fe1-965e-9fd4078abfe5} Name bcornOwner";
pub(super) struct Desired {
    pub body: Value,
    pub fingerprint: String,
}
// Store absolute UTC instants, not provider recurrence rules. The canonical
// builder already resolves civil time, DST, exclusion dates and make-up dates.
pub(super) fn desired(
    provider: Provider,
    owner: &str,
    account: &str,
    calendar: &str,
    series: Vec<Series>,
) -> Result<BTreeMap<String, Desired>, String> {
    if series.len() > 1000 {
        return Err("calendar-series-limit".into());
    }
    let mut out = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for s in series {
        if s.id.is_empty()
            || s.id.len() > 512
            || !ids.insert(s.id.clone())
            || s.title.len() > 1024
            || s.description.len() > 8192
            || s.location.len() > 2048
            || s.time_zone.is_empty()
            || s.time_zone.len() > 128
            || s.reminders.len() > 1
            || s.reminders.iter().any(|m| *m > 40320)
        {
            return Err("invalid-calendar-series".into());
        }
        let mut dates = BTreeSet::new();
        for o in &s.occurrences {
            if o.key.len() != 10
                || !o.key.bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
                || !dates.insert(o.key.clone())
                || o.start_millis < 0
                || o.end_millis <= o.start_millis
                || o.end_millis - o.start_millis > 172800000
                || o.end_millis > 4102444800000
            {
                return Err("invalid-calendar-occurrence".into());
            }
            let key = hash(
                &serde_json::to_string(&(provider, owner, account, calendar, &s.id, &o.key))
                    .map_err(|_| "invalid-calendar-series")?,
            );
            let marker = format!("{owner}:{key}");
            let start = utc(o.start_millis);
            let end = utc(o.end_millis);
            let body = match provider {
                Provider::Google => {
                    json!({"summary":s.title,"description":s.description,"location":s.location,"start":{"dateTime":start,"timeZone":s.time_zone},"end":{"dateTime":end,"timeZone":s.time_zone},"reminders":{"useDefault":false,"overrides":s.reminders.iter().map(|m|json!({"method":"popup","minutes":m})).collect::<Vec<_>>()},"extendedProperties":{"private":{"bcornOwner":marker}}})
                }
                Provider::Microsoft => {
                    json!({"subject":s.title,"body":{"contentType":"text","content":s.description},"location":{"displayName":s.location},"start":{"dateTime":start.trim_end_matches('Z'),"timeZone":"UTC"},"end":{"dateTime":end.trim_end_matches('Z'),"timeZone":"UTC"},"isReminderOn":!s.reminders.is_empty(),"reminderMinutesBeforeStart":s.reminders.first().copied().unwrap_or(0),"singleValueExtendedProperties":[{"id":EXTENSION,"value":marker}]})
                }
            };
            let fingerprint = hash(&body.to_string());
            out.insert(key, Desired { body, fingerprint });
            // Bound encrypted journal and one foreground operation, without silently truncating.
            if out.len() > 1000 {
                return Err("calendar-occurrence-limit-1000".into());
            }
        }
    }
    Ok(out)
}
// Gregorian conversion (civil_from_days), UTC and millisecond precision.
pub(super) fn utc(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    let s = seconds.rem_euclid(86400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        s / 3600,
        (s % 3600) / 60,
        s % 60,
        ms.rem_euclid(1000)
    )
}
pub(super) fn owns(p: Provider, b: &Value, owner: &str, key: &str) -> bool {
    let expected = format!("{owner}:{key}");
    match p {
        Provider::Google => {
            b["extendedProperties"]["private"]["bcornOwner"].as_str() == Some(expected.as_str())
        }
        Provider::Microsoft => b["singleValueExtendedProperties"]
            .as_array()
            .is_some_and(|a| {
                a.iter()
                    .any(|x| x["id"] == EXTENSION && x["value"] == expected)
            }),
    }
}
