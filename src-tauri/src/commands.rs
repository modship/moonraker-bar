//! Tauri commands exposed to the web front (`invoke("...")`).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::manager::{Layout, Manager};
use crate::moonraker::{self, Action, PrinterConfig, Snapshot};
use crate::tray;

type Mgr<'a> = State<'a, Arc<Manager>>;

/// Printer fields as typed in the settings form.
#[derive(Debug, Deserialize)]
pub struct PrinterInput {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub camera_url: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

impl PrinterInput {
    fn into_config(self, id: String, pinned_macros: Vec<String>, shown_temps: Vec<String>) -> Result<PrinterConfig, String> {
        let name = self.name.trim().to_string();
        let url = self.url.trim().trim_end_matches('/').to_string();
        if url.is_empty() {
            return Err("Moonraker URL is required".into());
        }
        let cfg = PrinterConfig {
            id,
            name: if name.is_empty() { url.clone() } else { name },
            url,
            api_key: clean(self.api_key),
            camera_url: clean(self.camera_url),
            web_url: clean(self.web_url),
            model: clean(self.model).filter(|m| m != "auto"),
            pinned_macros,
            shown_temps,
        };
        cfg.websocket_url()?; // validate
        Ok(cfg)
    }
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn list_printers(mgr: Mgr<'_>) -> Result<Vec<PrinterConfig>, String> {
    Ok(mgr.list().await)
}

#[tauri::command]
pub async fn get_snapshots(mgr: Mgr<'_>) -> Result<HashMap<String, Snapshot>, String> {
    Ok(mgr.snapshots().await)
}

#[tauri::command]
pub async fn add_printer(mgr: Mgr<'_>, input: PrinterInput) -> Result<PrinterConfig, String> {
    let cfg = input.into_config(String::new(), Vec::new(), Vec::new())?;
    Ok(mgr.add(cfg).await)
}

#[tauri::command]
pub async fn update_printer(mgr: Mgr<'_>, id: String, input: PrinterInput) -> Result<PrinterConfig, String> {
    let (pinned, temps) = mgr
        .list()
        .await
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| (p.pinned_macros, p.shown_temps))
        .unwrap_or_default();
    let cfg = input.into_config(id, pinned, temps)?;
    mgr.update(cfg.clone()).await?;
    Ok(cfg)
}

#[tauri::command]
pub async fn set_pinned_macros(mgr: Mgr<'_>, id: String, macros: Vec<String>) -> Result<(), String> {
    mgr.set_pinned_macros(&id, macros).await
}

/// Slicer thumbnail of a file on the printer, as a data URL (the API key stays in the backend).
#[tauri::command]
pub async fn get_thumbnail(mgr: Mgr<'_>, id: String, path: String) -> Result<String, String> {
    let cfg = mgr
        .list()
        .await
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Unknown printer".to_string())?;
    crate::discovery::fetch_gcode_file(&cfg.url, cfg.api_key.as_deref(), &path).await
}

/// Moonraker instances found on the local network (mDNS + subnet scan, ~3 s).
#[tauri::command]
pub async fn discover_printers() -> Result<Vec<crate::discovery::Discovered>, String> {
    Ok(crate::discovery::discover().await)
}

#[tauri::command]
pub async fn get_layout(mgr: Mgr<'_>) -> Result<Layout, String> {
    Ok(mgr.layout().await)
}

#[tauri::command]
pub async fn set_layout(mgr: Mgr<'_>, layout: Layout) -> Result<(), String> {
    mgr.set_layout(layout).await;
    Ok(())
}

#[tauri::command]
pub async fn set_shown_temps(mgr: Mgr<'_>, id: String, objects: Vec<String>) -> Result<(), String> {
    mgr.set_shown_temps(&id, objects).await
}

#[tauri::command]
pub async fn remove_printer(mgr: Mgr<'_>, id: String) -> Result<(), String> {
    mgr.remove(&id).await
}

#[tauri::command]
pub async fn get_active_printer(mgr: Mgr<'_>) -> Result<Option<String>, String> {
    Ok(mgr.active().await)
}

#[tauri::command]
pub async fn set_active_printer(mgr: Mgr<'_>, id: Option<String>) -> Result<(), String> {
    mgr.set_active(id).await;
    Ok(())
}

/// `action`: `pause` | `resume` | `cancel` | `estop` | `firmware_restart` | `speed` (arg = percent)
/// | `gcode` (arg = script) | `preset` (arg = preset id) | `cooldown` | `reload_presets`
#[tauri::command]
pub async fn printer_action(
    mgr: Mgr<'_>,
    id: String,
    action: String,
    arg: Option<String>,
) -> Result<(), String> {
    let action = match action.as_str() {
        "pause" => Action::Pause,
        "resume" => Action::Resume,
        "cancel" => Action::Cancel,
        "estop" => Action::EmergencyStop,
        "firmware_restart" => Action::FirmwareRestart,
        "speed" => {
            let pct: u32 = arg
                .as_deref()
                .and_then(|s| s.trim().parse().ok())
                .ok_or_else(|| "Invalid percentage".to_string())?;
            Action::Gcode(format!("M220 S{}", pct.clamp(10, 500)))
        }
        "gcode" => {
            let script = arg.unwrap_or_default();
            if script.trim().is_empty() {
                return Err("Empty script".into());
            }
            Action::Gcode(script)
        }
        "preset" => Action::ApplyPreset(arg.unwrap_or_default()),
        "cooldown" => Action::Cooldown,
        "reload_presets" => Action::ReloadPresets,
        other => return Err(format!("Unknown action: {other}")),
    };
    mgr.execute(&id, action).await
}

/// Connectivity check for the settings form. Returns a short description of the host.
#[tauri::command]
pub async fn test_connection(input: PrinterInput) -> Result<String, String> {
    let cfg = input.into_config("probe".into(), Vec::new(), Vec::new())?;
    moonraker::probe(&cfg).await
}

#[tauri::command]
pub fn hide_popover(app: AppHandle) {
    tray::hide_popover(&app);
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// Starts reading an MJPEG stream; frames arrive on `on_event`. Returns the stream id.
#[tauri::command]
pub fn camera_start(url: String, on_event: tauri::ipc::Channel<crate::camera::CameraEvent>) -> u64 {
    crate::camera::start(url, on_event)
}

/// Stops a stream started with `camera_start` and closes its connection.
#[tauri::command]
pub fn camera_stop(id: u64) {
    crate::camera::stop(id)
}
