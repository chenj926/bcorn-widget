#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, sync::Mutex};

mod data;
use data::{atomic_write, clear_cache, validate_data, MAX_DATA_BYTES};
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
        validate_data(&data)?;
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
            get_state,
            refresh,
            login,
            save_data,
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
