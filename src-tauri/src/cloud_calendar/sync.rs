use super::*;
impl CloudCalendar {
    pub fn sync(
        &self,
        p: Provider,
        series: Vec<Series>,
        allow_delete: bool,
    ) -> Result<SyncResult, String> {
        let c = self.connection(p);
        let _op = c.operation.try_lock().map_err(|_| "calendar-busy")?;
        c.begin()?;
        let mut v = c.current()?;
        if !v.enabled {
            return Err("calendar-not-enabled".into());
        }
        let target = selected(&v)?.target.clone();
        let account = v.account.clone().ok_or("account-required")?;
        let wanted = desired(p, &v.owner, &account, &target.id, series)?;
        let token = self.access(c)?;
        // A refresh can replace tokens; never commit the pre-refresh vault later.
        v = c.current()?;
        let stale: Vec<_> = selected(&v)?
            .entries
            .iter()
            .filter(|(k, e)| !e.deleted && !wanted.contains_key(*k))
            .map(|(k, _)| k.clone())
            .collect();
        let mut result = SyncResult {
            pending_delete_count: stale.len(),
            ..Default::default()
        };
        for (key, item) in wanted {
            c.gate.check()?;
            let prior = selected(&v)?.entries.get(&key).cloned();
            let mut generation = prior.as_ref().map(|e| e.generation).unwrap_or(0);
            if prior.as_ref().is_some_and(|e| e.deleted) {
                generation = generation
                    .checked_add(1)
                    .ok_or("calendar-generation-limit")?;
            }
            let remote = match prior.as_ref() {
                Some(e) if e.deleted => None,
                Some(e) if e.remote.is_some() => e.remote.clone(),
                Some(e) if e.pending => self.recover_pending(c, &token, &v, &target.id, &key)?,
                _ => None,
            };
            if prior.as_ref().is_some_and(|e| e.pending) && remote.is_none() {
                return Err("calendar-write-uncertain-retry-readback".into());
            }
            if let Some(id) = remote {
                let existing = self.read_event(c, &token, &target.id, &id)?;
                if let Some(existing) = existing {
                    if !owns(p, &existing, &v.owner, &key) {
                        return Err("calendar-ownership-conflict".into());
                    }
                    let fingerprint = prior.as_ref().map(|e| e.fingerprint.as_str()).unwrap_or("");
                    if fingerprint == item.fingerprint
                        && !prior.as_ref().is_some_and(|e| e.pending)
                        && matches_desired(p, &existing, &item.body)
                    {
                        result.unchanged += 1;
                        continue;
                    }
                    let tag = etag(p, &existing)?;
                    let mut entry = Entry {
                        generation,
                        deleted: false,
                        remote: Some(id.clone()),
                        fingerprint: item.fingerprint.clone(),
                        pending: true,
                    };
                    selected_mut(&mut v)?
                        .entries
                        .insert(key.clone(), entry.clone());
                    c.commit(v.clone())?;
                    let response = self.send_conditional(
                        c,
                        "PATCH",
                        event_url(p, &target.id, Some(&id), false)?,
                        Some(&token),
                        None,
                        Some(item.body.clone()),
                        Some(tag),
                    );
                    match response {
                        Ok(r) => {
                            success(r)?;
                        }
                        Err(e) => return Err(e),
                    }
                    let checked = self
                        .read_event(c, &token, &target.id, &id)?
                        .ok_or("calendar-write-not-verified")?;
                    if !owns(p, &checked, &v.owner, &key)
                        || !matches_desired(p, &checked, &item.body)
                    {
                        return Err("calendar-write-not-verified".into());
                    }
                    entry.pending = false;
                    selected_mut(&mut v)?.entries.insert(key, entry);
                    c.commit(v.clone())?;
                    result.written += 1;
                    continue;
                }
                // A missing previously-owned event can be recreated. A pending update that
                // disappeared is not interpreted as permission to delete any other event.
                if prior.as_ref().is_some_and(|e| e.pending) {
                    if p == Provider::Microsoft {
                        return Err("calendar-write-uncertain-retry-readback".into());
                    }
                } else {
                    generation = generation
                        .checked_add(1)
                        .ok_or("calendar-generation-limit")?;
                }
            }
            // Persist intent before POST. Google uses deterministic API IDs. Graph uses
            // both transactionId and an exact ownership property for crash/readback recovery.
            let id = if p == Provider::Google {
                Some(google_id(&key, generation))
            } else {
                None
            };
            if let Some(ref id) = id {
                if let Some(found) = self.read_event(c, &token, &target.id, id)? {
                    if !owns(p, &found, &v.owner, &key) {
                        return Err("calendar-ownership-conflict".into());
                    }
                    selected_mut(&mut v)?.entries.insert(
                        key.clone(),
                        Entry {
                            generation,
                            deleted: false,
                            remote: Some(id.clone()),
                            fingerprint: String::new(),
                            pending: true,
                        },
                    );
                    c.commit(v.clone())?;
                    return Err("calendar-recovered-retry-sync".into());
                }
            }
            selected_mut(&mut v)?.entries.insert(
                key.clone(),
                Entry {
                    generation,
                    deleted: false,
                    remote: id.clone(),
                    fingerprint: item.fingerprint.clone(),
                    pending: true,
                },
            );
            c.commit(v.clone())?;
            let mut body = item.body.clone();
            if p == Provider::Google {
                body["id"] = json!(id)
            } else {
                body["transactionId"] = json!(hash(&format!("{key}:{generation}")))
            }
            let response = self.send(
                c,
                "POST",
                event_url(p, &target.id, None, false)?,
                Some(&token),
                None,
                Some(body),
            );
            let body = match response {
                Ok(r) if (200..300).contains(&r.status) => success(r)?,
                Ok(r) => {
                    if (400..500).contains(&r.status) && r.status != 409 && r.status != 408 {
                        restore_prior(&mut v, &key, prior.clone())?;
                        c.commit(v.clone())?;
                    }
                    return Err(success(r).err().unwrap_or("calendar-write-failed".into()));
                }
                Err(e) => {
                    if e == "rate-limited"
                        || e == "authorization-revoked"
                        || e == "request-not-sent-background-or-cancelled"
                    {
                        v = c.current()?;
                        restore_prior(&mut v, &key, prior.clone())?;
                        c.commit(v.clone())?;
                    }
                    return Err(e);
                }
            };
            let actual = body["id"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("calendar-write-uncertain-retry-readback")?
                .to_string();
            if id.as_ref().is_some_and(|expected| expected != &actual) {
                return Err("calendar-write-id-mismatch".into());
            }
            // Persist returned ID before the verification request can fail.
            selected_mut(&mut v)?
                .entries
                .get_mut(&key)
                .ok_or("calendar-storage-error")?
                .remote = Some(actual.clone());
            c.commit(v.clone())?;
            let checked = self
                .read_event(c, &token, &target.id, &actual)?
                .ok_or("calendar-write-not-verified")?;
            if !owns(p, &checked, &v.owner, &key) || !matches_desired(p, &checked, &item.body) {
                return Err("calendar-write-not-verified".into());
            }
            selected_mut(&mut v)?
                .entries
                .get_mut(&key)
                .ok_or("calendar-storage-error")?
                .pending = false;
            c.commit(v.clone())?;
            result.written += 1;
        }
        if allow_delete {
            for key in stale {
                c.gate.check()?;
                let entry = selected(&v)?
                    .entries
                    .get(&key)
                    .cloned()
                    .ok_or("calendar-storage-error")?;
                let remote = match entry.remote {
                    Some(id) => Some(id),
                    None => self.recover_pending(c, &token, &v, &target.id, &key)?,
                };
                let Some(id) = remote else {
                    return Err("calendar-write-uncertain-retry-readback".into());
                };
                if let Some(existing) = self.read_event(c, &token, &target.id, &id)? {
                    if !owns(p, &existing, &v.owner, &key) {
                        return Err("calendar-ownership-conflict".into());
                    }
                    let r = self.send_conditional(
                        c,
                        "DELETE",
                        event_url(p, &target.id, Some(&id), false)?,
                        Some(&token),
                        None,
                        None,
                        Some(etag(p, &existing)?),
                    )?;
                    if r.status != 404 && r.status != 410 {
                        success(r)?;
                    }
                    if self.read_event(c, &token, &target.id, &id)?.is_some() {
                        return Err("calendar-delete-not-verified".into());
                    }
                }
                let entry = selected_mut(&mut v)?
                    .entries
                    .get_mut(&key)
                    .ok_or("calendar-storage-error")?;
                entry.deleted = true;
                entry.pending = false;
                c.commit(v.clone())?;
                result.deleted += 1;
            }
            result.pending_delete_count = 0;
        }
        Ok(result)
    }
    fn read_event(
        &self,
        c: &Connection,
        token: &str,
        calendar: &str,
        id: &str,
    ) -> Result<Option<Value>, String> {
        let r = self.send(
            c,
            "GET",
            event_url(c.config.provider, calendar, Some(id), true)?,
            Some(token),
            None,
            None,
        )?;
        if r.status == 404 || r.status == 410 {
            return Ok(None);
        }
        let v = success(r)?;
        if v["status"] == "cancelled" {
            return Ok(None);
        }
        Ok(Some(v))
    }
    fn recover_pending(
        &self,
        c: &Connection,
        token: &str,
        v: &Vault,
        calendar: &str,
        key: &str,
    ) -> Result<Option<String>, String> {
        if c.config.provider == Provider::Google {
            return Ok(Some(google_id(
                key,
                selected(v)?
                    .entries
                    .get(key)
                    .map(|e| e.generation)
                    .unwrap_or(0),
            )));
        }
        let mut url = Url::parse(&event_url(Provider::Microsoft, calendar, None, false)?)
            .map_err(|_| "invalid-calendar-route")?;
        let marker = format!("{}:{key}", v.owner);
        url.query_pairs_mut().append_pair("$filter",&format!("singleValueExtendedProperties/Any(ep: ep/id eq '{EXTENSION}' and ep/value eq '{marker}')")).append_pair("$expand",&format!("singleValueExtendedProperties($filter=id eq '{EXTENSION}')")).append_pair("$top","2");
        let b = success(self.send(c, "GET", url.into(), Some(token), None, None)?)?;
        let events = b["value"].as_array().ok_or("invalid-calendar-response")?;
        if events.len() > 1 || b.get("@odata.nextLink").is_some() {
            return Err("calendar-ownership-conflict".into());
        }
        let Some(event) = events.first() else {
            return Ok(None);
        };
        if !owns(Provider::Microsoft, event, &v.owner, key) {
            return Err("calendar-ownership-conflict".into());
        }
        Ok(Some(
            event["id"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("invalid-calendar-response")?
                .into(),
        ))
    }
}
fn event_url(p: Provider, calendar: &str, id: Option<&str>, read: bool) -> Result<String, String> {
    if !valid_id(calendar) || id.is_some_and(|s| !valid_id(s)) {
        return Err("invalid-calendar-route".into());
    }
    let mut url = Url::parse(match p {
        Provider::Google => "https://www.googleapis.com/calendar/v3/calendars",
        Provider::Microsoft => "https://graph.microsoft.com/v1.0/me/calendars",
    })
    .map_err(|_| "invalid-calendar-route")?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "invalid-calendar-route")?;
        path.push(calendar).push("events");
        if let Some(id) = id {
            path.push(id);
        }
    }
    if p == Provider::Google && !read {
        url.query_pairs_mut().append_pair("sendUpdates", "none");
    } else if p == Provider::Microsoft && read {
        url.query_pairs_mut().append_pair(
            "$expand",
            &format!("singleValueExtendedProperties($filter=id eq '{EXTENSION}')"),
        );
    }
    Ok(url.into())
}
fn etag(p: Provider, b: &Value) -> Result<String, String> {
    b[if p == Provider::Google {
        "etag"
    } else {
        "@odata.etag"
    }]
    .as_str()
    .filter(|s| !s.is_empty() && s.len() < 512 && !s.bytes().any(|b| b < 32 || b == 127))
    .map(str::to_owned)
    .ok_or("calendar-version-required".into())
}
fn matches_desired(p: Provider, actual: &Value, wanted: &Value) -> bool {
    let fields: &[&str] = match p {
        Provider::Google => &["summary", "description", "location"],
        Provider::Microsoft => &["subject", "isReminderOn", "reminderMinutesBeforeStart"],
    };
    fields
        .iter()
        .all(|f| actual[*f] == wanted[*f] || (actual[*f].is_null() && wanted[*f] == ""))
        && match p {
            Provider::Google => {
                actual["reminders"]["useDefault"] == false
                    && actual["reminders"]["overrides"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        == wanted["reminders"]["overrides"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                    && ["start", "end"].iter().all(|k| {
                        actual[*k]["dateTime"]
                            .as_str()
                            .zip(wanted[*k]["dateTime"].as_str())
                            .is_some_and(|(a, b)| instant_equal(a, b))
                    })
            }
            Provider::Microsoft => {
                actual["body"]["content"] == wanted["body"]["content"]
                    && actual["location"]["displayName"] == wanted["location"]["displayName"]
                    && ["start", "end"].iter().all(|k| {
                        actual[*k]["timeZone"] == "UTC"
                            && actual[*k]["dateTime"]
                                .as_str()
                                .zip(wanted[*k]["dateTime"].as_str())
                                .is_some_and(|(a, b)| instant_equal(a, b))
                    })
            }
        }
}
// Provider canonicalizes fractional trailing zeros. Google is requested UTC and
// can return +00:00; non-UTC echoes are conservatively not marked verified.
fn instant_equal(a: &str, b: &str) -> bool {
    parse_instant(a)
        .zip(parse_instant(b))
        .is_some_and(|(a, b)| a == b)
}
fn parse_instant(s: &str) -> Option<i64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let y = d.next()?.parse::<i64>().ok()?;
    let m = d.next()?.parse::<i64>().ok()?;
    let day = d.next()?.parse::<i64>().ok()?;
    if d.next().is_some()
        || !(1970..=2100).contains(&y)
        || !(1..=12).contains(&m)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let time = time.strip_suffix('Z').unwrap_or(time);
    let (time, offset) = if let Some(i) = time.find(['+', '-']) {
        let off = &time[i + 1..];
        let (h, m) = off.split_once(':')?;
        let h = h.parse::<i64>().ok()?;
        let m = m.parse::<i64>().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        (
            &time[..i],
            (h * 60 + m) * 60 * if time.as_bytes()[i] == b'-' { -1 } else { 1 },
        )
    } else {
        (time, 0)
    };
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut t = clock.split(':');
    let h = t.next()?.parse::<i64>().ok()?;
    let min = t.next()?.parse::<i64>().ok()?;
    let sec = t.next()?.parse::<i64>().ok()?;
    if t.next().is_some() || h > 23 || min > 59 || sec > 59 {
        return None;
    }
    let ms = format!("{fraction:0<3}")[..3].parse::<i64>().ok()?;
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + min * 60 + sec) - offset) * 1000 + ms)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_offset_and_fractional_normalization() {
        assert!(instant_equal(
            "2026-11-02T09:00:00-05:00",
            "2026-11-02T14:00:00.000Z"
        ));
        assert!(instant_equal(
            "2026-11-02T14:00:00.0000000",
            "2026-11-02T14:00:00.000"
        ));
        assert!(!instant_equal(
            "2026-11-02T09:00:00-04:00",
            "2026-11-02T14:00:00Z"
        ));
    }
    #[test]
    fn route_ids_are_encoded_and_cannot_escape_target() {
        let u = event_url(Provider::Microsoft, "a/b?x=1", Some("c/d"), true).unwrap();
        assert!(u.contains("a%2Fb%3Fx=1/events/c%2Fd"));
        assert!(event_url(Provider::Google, "..", None, false).is_err());
        assert!(
            Url::parse(&event_url(Provider::Google, "calendar", Some("event"), true).unwrap())
                .unwrap()
                .query()
                .is_none()
        );
    }
}

fn google_id(key: &str, generation: u32) -> String {
    if generation == 0 {
        format!("bcorn{key}")
    } else {
        format!("bcorn{}", hash(&format!("{key}:{generation}")))
    }
}
fn restore_prior(v: &mut Vault, key: &str, prior: Option<Entry>) -> Result<(), String> {
    let entries = &mut selected_mut(v)?.entries;
    if let Some(entry) = prior {
        entries.insert(key.into(), entry);
    } else {
        entries.remove(key);
    }
    Ok(())
}
