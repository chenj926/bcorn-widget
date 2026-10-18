#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, sync::{Arc, Mutex}};

mod data;
mod grade_auth;
mod cloud_calendar;
mod grade_sync_store;
use grade_auth::{GradeAuth, GradeSyncStatus, SheetsRequest, SheetsResponse, SheetVersion, DisconnectResult};
use grade_sync_store::GradeSyncStore;
use data::{atomic_write, clear_cache, validate_data, validate_grade_book, validate_export_json, MAX_DATA_BYTES};
use tauri::{
    menu::{Menu, MenuItem},
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const UNSUPPORTED: &str =
    "轻量版尚未支持 ACORN 登录和刷新。可导入 JSON 或手动添加课程；数据只保存在本机。";

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Preferences {
    pinned: bool,
    width: Option<u32>,
    height: Option<u32>,
    x: Option<i32>,
    y: Option<i32>,
}
struct LocalState {
    preferences: Preferences,
    data: Option<Value>,
    cache_error: Option<String>,
}
struct AppState(Mutex<LocalState>);

fn capabilities() -> Value {
    json!({"login":false,"refresh":false,"import":true,"exportCalendar":true,"localCache":true,"pin":true})
}
fn snapshot(state: &LocalState) -> Value {
    let status = match &state.cache_error {
        Some(message) => json!({"state":"error","message":message}),
        None => json!({"state":"unsupported","message":UNSUPPORTED}),
    };
    json!({"data":state.data,"status":status,"pinned":state.preferences.pinned,"capabilities":capabilities()})
}

#[tauri::command]
fn get_state(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let local = state.0.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&local))
}
#[tauri::command]
fn refresh(app: tauri::AppHandle) -> Result<Value, String> {
    // Intentionally no HTTP request, session ping, refresh timer or hidden WebView.
    let payload = json!({"status":{"state":"unsupported","message":UNSUPPORTED},"capabilities":capabilities()});
    app.emit("acorn:update", &payload)
        .map_err(|e| e.to_string())?;
    Ok(payload)
}
#[tauri::command]
fn login(app: tauri::AppHandle) -> Result<Value, String> {
    refresh(app)
}

#[tauri::command]
fn save_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    data: Value,
) -> Result<Value, String> {
    validate_data(&data)?;
    let mut local = state.0.lock().map_err(|e| e.to_string())?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cache.json");
    atomic_write(
        &path,
        &serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
    )?;
    local.data = Some(data);
    local.cache_error = None;
    let payload = snapshot(&local);
    drop(local);
    app.emit("acorn:update", &payload)
        .map_err(|e| e.to_string())?;
    Ok(payload)
}

#[tauri::command]
fn load_grade_book(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("grades-v1.json");
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > 2 * 1024 * 1024 { return Err("Gradebook exceeds the 2 MiB limit".into()); }
    let book: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    validate_grade_book(&book)?;
    Ok(Some(book))
}
#[tauri::command]
fn save_grade_book(app: tauri::AppHandle, state: tauri::State<'_, AppState>, book: Value) -> Result<Value, String> {
    validate_grade_book(&book)?;
    // Serialize file replacement with other host writes, including repeated UI saves.
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("grades-v1.json");
    atomic_write(&path, &serde_json::to_vec(&book).map_err(|e| e.to_string())?)?;
    Ok(json!({"ok": true}))
}

// Calendar credentials and permissions are separate from the grade-file grant.
struct CloudCalendarState(Result<Arc<cloud_calendar::CloudCalendar>, String>);
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum CloudCalendarRequest {
    Status { provider: cloud_calendar::Provider },
    Connect { provider: cloud_calendar::Provider },
    Targets { provider: cloud_calendar::Provider },
    CreateTarget { provider: cloud_calendar::Provider, name: String },
    Bind { provider: cloud_calendar::Provider, #[serde(rename = "calendarId")] calendar_id: String, confirmed: bool },
    Sync { provider: cloud_calendar::Provider, series: Vec<cloud_calendar::Series>, #[serde(rename = "allowDelete")] allow_delete: bool },
    Disconnect { provider: cloud_calendar::Provider },
    Cancel { provider: cloud_calendar::Provider },
    SetForeground { foreground: bool },
}
#[tauri::command]
async fn cloud_calendar_call(app: tauri::AppHandle, window: WebviewWindow, state: tauri::State<'_, CloudCalendarState>, request: CloudCalendarRequest) -> Result<Value, String> {
    let calendar = match &state.0 {
        Ok(calendar) => calendar.clone(),
        Err(_) => return if matches!(request, CloudCalendarRequest::Status { .. }) {
            Ok(json!({"state":"storage-unavailable","enabled":false,"accountLabel":"","target":null,"nativeError":"calendar-storage-unavailable"}))
        } else { Err("calendar-storage-unavailable".into()) },
    };
    if let CloudCalendarRequest::SetForeground { foreground } = request {
        calendar.set_foreground(foreground && window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true));
        return Ok(json!({"ok":true}));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let encode = |value| serde_json::to_value(value).map_err(|_| "calendar-response-error".to_string());
        match request {
            CloudCalendarRequest::Status { provider } => encode(calendar.status(provider)?),
            CloudCalendarRequest::Connect { provider } => encode(calendar.connect(provider, |url| app.opener().open_url(url, None::<&str>).map_err(|_| "system-browser-unavailable".to_string()))?),
            CloudCalendarRequest::Targets { provider } => serde_json::to_value(calendar.targets(provider)?).map_err(|_| "calendar-response-error".into()),
            CloudCalendarRequest::CreateTarget { provider, name } => serde_json::to_value(calendar.create_target(provider, name)?).map_err(|_| "calendar-response-error".into()),
            CloudCalendarRequest::Bind { provider, calendar_id, confirmed } => encode(calendar.bind(provider, calendar_id, confirmed)?),
            CloudCalendarRequest::Sync { provider, series, allow_delete } => serde_json::to_value(calendar.sync(provider, series, allow_delete)?).map_err(|_| "calendar-response-error".into()),
            CloudCalendarRequest::Disconnect { provider } => encode(calendar.disconnect(provider)?),
            CloudCalendarRequest::Cancel { provider } => { calendar.cancel(provider); Ok(json!({"ok":true})) },
            CloudCalendarRequest::SetForeground { .. } => unreachable!(),
        }
    }).await.map_err(|_| "calendar-task-failed".to_string())?
}

// Native OAuth tokens and HTTP stay behind this narrow command boundary.
struct GradeState { auth: Result<Arc<GradeAuth>, String>, journal: Arc<GradeSyncStore> }
impl GradeState {
    fn auth(&self) -> Result<Arc<GradeAuth>, String> { self.auth.clone() }
}
#[tauri::command]
fn get_grade_sync_status(state: tauri::State<'_, GradeState>) -> Result<Value, String> {
    match state.auth() {
        Ok(auth) => serde_json::to_value(auth.status()?).map_err(|_| "native-status-error".into()),
        Err(error) => Ok(json!({"state":"error","binding":null,"connectionId":null,"deviceId":null,"automaticInbound":false,"automaticInboundMode":"none","foregroundSyncAvailable":false,"nativeError":error})),
    }
}
#[tauri::command]
async fn connect_grade_sheet(app: tauri::AppHandle, state: tauri::State<'_, GradeState>, title: String, tab: String) -> Result<GradeSyncStatus, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.connect_new_sheet(title, tab, |url| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn create_mapped_grade_sheet(app: tauri::AppHandle, state: tauri::State<'_, GradeState>, course: Value) -> Result<GradeSyncStatus, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.create_mapped_grade_sheet(course, |url| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn pick_grade_sheet(app: tauri::AppHandle, state: tauri::State<'_, GradeState>) -> Result<Value, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.pick_grade_sheet(|url| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn preview_grade_sheet(state: tauri::State<'_, GradeState>, selection_id: String, sheet_id: u32) -> Result<Value, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.preview_grade_sheet(selection_id, sheet_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn confirm_grade_sheet_mapping(state: tauri::State<'_, GradeState>, selection_id: String, mapping: Value) -> Result<GradeSyncStatus, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.confirm_grade_sheet_mapping(selection_id, mapping)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_mapped_grade_snapshot(state: tauri::State<'_, GradeState>, connection_id: String) -> Result<Value, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.read_mapped_grade_snapshot(connection_id)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn commit_mapped_grade_cells(state: tauri::State<'_, GradeState>, connection_id: String, expected_snapshot: Value, writes: Value) -> Result<Value, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.commit_mapped_grade_cells(connection_id, expected_snapshot, writes)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn grade_sheets_request(state: tauri::State<'_, GradeState>, request: SheetsRequest) -> Result<SheetsResponse, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.request(request)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn grade_sheet_version(state: tauri::State<'_, GradeState>) -> Result<SheetVersion, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.sheet_version()).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn disconnect_grade_sheet(state: tauri::State<'_, GradeState>, revoke_google: bool) -> Result<DisconnectResult, String> {
    let auth = state.auth()?;
    tauri::async_runtime::spawn_blocking(move || auth.disconnect(revoke_google)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn set_grade_sync_foreground(window: WebviewWindow, state: tauri::State<'_, GradeState>, foreground: bool) -> Result<(), String> {
    state.auth()?.set_foreground(foreground && window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true));
    Ok(())
}
#[tauri::command]
fn cancel_grade_authorization(state: tauri::State<'_, GradeState>) { if let Ok(auth) = state.auth() { auth.cancel_authorization(); } }
#[tauri::command]
fn load_grade_sync_state(state: tauri::State<'_, GradeState>, connection_id: String) -> Result<Option<Value>, String> {
    state.auth()?.validate_connection(&connection_id)?;
    state.journal.load(&connection_id)
}
#[tauri::command]
fn save_grade_sync_state(state: tauri::State<'_, GradeState>, connection_id: String, envelope: Value) -> Result<Value, String> {
    state.auth()?.validate_connection(&connection_id)?;
    state.journal.save(&connection_id, envelope)?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
fn clear_data(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    // Invoked only after the shared renderer's explicit confirmation dialog.
    // The IPC accepts no path and cannot delete preferences or arbitrary files.
    let mut local = state.0.lock().map_err(|e| e.to_string())?;
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    clear_cache(&directory)?;
    local.data = None;
    local.cache_error = None;
    let payload = snapshot(&local);
    drop(local);
    app.emit("acorn:update", &payload)
        .map_err(|e| e.to_string())?;
    Ok(payload)
}

fn persist_preferences(app: &tauri::AppHandle, preferences: &Preferences) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("window.json");
    atomic_write(
        &path,
        &serde_json::to_vec(preferences).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
fn toggle_pin(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let mut local = state.0.lock().map_err(|e| e.to_string())?;
    let pinned = !local.preferences.pinned;
    window
        .set_always_on_top(pinned)
        .map_err(|e| e.to_string())?;
    local.preferences.pinned = pinned;
    let saved = persist_preferences(&app, &local.preferences);
    drop(local);
    app.emit("widget:pinned", pinned)
        .map_err(|e| e.to_string())?;
    saved?;
    Ok(pinned)
}
#[tauri::command]
fn minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}
#[tauri::command]
fn open_menu(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let info = MenuItem::with_id(
        &app,
        "offline-info",
        "离线轻量版 · ACORN 登录尚未迁移",
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let pin = MenuItem::with_id(&app, "pin", "切换置顶", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let minimize = MenuItem::with_id(&app, "minimize", "最小化", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let close =
        MenuItem::with_id(&app, "close", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu =
        Menu::with_items(&app, &[&info, &pin, &minimize, &close]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_calendar(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<Value, String> {
    if content.len() > MAX_DATA_BYTES {
        return Err("Export exceeds the 8 MiB limit".into());
    }
    let is_json = filename.to_ascii_lowercase().ends_with(".json");
    if is_json {
        let data: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        validate_export_json(&data)?;
    } else if !content.starts_with("BEGIN:VCALENDAR") || !content.contains("END:VCALENDAR") {
        return Err("Expected an iCalendar or timetable JSON file".into());
    }
    // Suggested filename is a basename, never a renderer-provided arbitrary path.
    let safe_name: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(100)
        .collect();
    let extension = if is_json { "json" } else { "ics" };
    let safe_name =
        if safe_name.ends_with(&format!(".{extension}")) && safe_name.len() > extension.len() + 1 {
            safe_name
        } else {
            format!("acorn-timetable.{extension}")
        };
    let selected = app
        .dialog()
        .file()
        .set_title("导出课程数据")
        .add_filter(
            if is_json {
                "Timetable JSON"
            } else {
                "iCalendar"
            },
            &[extension],
        )
        .set_file_name(&safe_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(json!({"canceled":true}));
    };
    let path = selected.into_path().map_err(|e| e.to_string())?;
    // Saving is authorized only by the native file picker, not by an IPC path.
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(json!({"canceled":false,"path":path.to_string_lossy()}))
}
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid URL")?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("www.google.com" | "uri.amap.com"))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(
            "Only HTTPS Google Maps or AMap links without embedded credentials can be opened"
                .into(),
        );
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(CloudCalendarState(cloud_calendar::CloudCalendar::new(directory.clone()).map(Arc::new)));
            app.manage(GradeState {
                auth: GradeAuth::new(directory.clone()).map(Arc::new),
                journal: Arc::new(GradeSyncStore::new(directory.clone())),
            });
            let preferences: Preferences = fs::read(directory.join("window.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            let cache_path = directory.join("cache.json");
            let cache = if cache_path.exists() {
                fs::metadata(&cache_path)
                    .map_err(|e| e.to_string())
                    .and_then(|metadata| {
                        if metadata.len() > MAX_DATA_BYTES as u64 {
                            return Err("Local cache exceeds 8 MiB".into());
                        }
                        let bytes = fs::read(&cache_path).map_err(|e| e.to_string())?;
                        let data: Value =
                            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                        validate_data(&data)?;
                        Ok(data)
                    })
                    .map(Some)
            } else {
                Ok(None)
            };
            let (data, cache_error) = match cache {
                Ok(data) => (data, None),
                Err(error) => (
                    None,
                    Some(format!("无法读取本地缓存（原文件未更改）：{error}")),
                ),
            };
            app.manage(AppState(Mutex::new(LocalState {
                preferences: preferences.clone(),
                data,
                cache_error,
            })));
            let window = app
                .get_webview_window("main")
                .ok_or("Main window not found")?;
            window.set_always_on_top(preferences.pinned)?;
            if let (Some(width), Some(height)) = (preferences.width, preferences.height) {
                if (260..=8000).contains(&width) && (280..=8000).contains(&height) {
                    window.set_size(PhysicalSize::new(width, height))?;
                }
            }
            if let (Some(x), Some(y)) = (preferences.x, preferences.y) {
                // Restore only if the title bar remains reachable on a current monitor.
                let reachable = window.available_monitors()?.iter().any(|m| {
                    let p = m.position();
                    let s = m.size();
                    i64::from(x) >= i64::from(p.x)
                        && i64::from(y) >= i64::from(p.y)
                        && i64::from(x) + 100 < i64::from(p.x) + i64::from(s.width)
                        && i64::from(y) + 40 < i64::from(p.y) + i64::from(s.height)
                });
                if reachable {
                    window.set_position(PhysicalPosition::new(x, y))?;
                } else {
                    window.center()?;
                }
            }
            window.show()?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let result = match event.id().as_ref() {
                "pin" => toggle_pin(app.clone(), window, app.state()).map(|_| ()),
                "minimize" => window.minimize().map_err(|e| e.to_string()),
                "close" => window.close().map_err(|e| e.to_string()),
                _ => Ok(()),
            };
            if let Err(message) = result {
                let _ = app.emit(
                    "acorn:update",
                    json!({"status":{"state":"error","message":message}}),
                );
            }
        })
        .on_window_event(|window, event| {
            if let Some(state) = window.app_handle().try_state::<CloudCalendarState>() {
                if let Ok(calendar) = &state.0 {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                        calendar.set_foreground(false);
                    } else if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)) {
                        calendar.set_foreground(window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true));
                    }
                }
            }
            if let Some(state) = window.app_handle().try_state::<GradeState>() {
                if let Ok(auth) = state.auth() {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                        auth.set_foreground(false);
                        auth.cancel_authorization();
                    } else if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)) {
                        let visible = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true);
                        auth.set_foreground(visible);
                        if !visible { auth.cancel_authorization(); }
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                if let Ok(mut local) = state.0.lock() {
                    if !window.is_maximized().unwrap_or(false)
                        && !window.is_minimized().unwrap_or(false)
                    {
                        if let Ok(size) = window.inner_size() {
                            local.preferences.width = Some(size.width);
                            local.preferences.height = Some(size.height);
                        }
                        if let Ok(position) = window.outer_position() {
                            local.preferences.x = Some(position.x);
                            local.preferences.y = Some(position.y);
                        }
                    }
                    if let Err(error) = persist_preferences(app, &local.preferences) {
                        eprintln!("Unable to save window preferences: {error}");
                    }
                };
            }
        })
        .invoke_handler(tauri::generate_handler![
            cloud_calendar_call,
            set_grade_sync_foreground,
            get_grade_sync_status,
            connect_grade_sheet,
            create_mapped_grade_sheet,
            pick_grade_sheet,
            preview_grade_sheet,
            confirm_grade_sheet_mapping,
            read_mapped_grade_snapshot,
            commit_mapped_grade_cells,
            grade_sheets_request,
            grade_sheet_version,
            disconnect_grade_sheet,
            cancel_grade_authorization,
            load_grade_sync_state,
            save_grade_sync_state,
            get_state,
            refresh,
            login,
            save_data,
            load_grade_book,
            save_grade_book,
            clear_data,
            toggle_pin,
            minimize,
            open_menu,
            export_calendar,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Unable to run ACORN Widget Lite");
}
