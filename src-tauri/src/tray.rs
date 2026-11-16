//! Tray icon (menu bar on macOS), its live-rendered progress glyph, and the
//! popover window it toggles.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewWindow};
use tauri_plugin_store::StoreExt;

/// Tells the web UI whether the popover is on screen, so it can stop the camera stream when hidden.
const VISIBILITY_EVENT: &str = "popover:visibility";
use tauri_plugin_positioner::{Position, WindowExt};

use crate::manager::STORE_FILE;
use crate::moonraker::{ConnectionState, Snapshot};

/// Optional text beside the progress ring. The ring itself is always visible.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct TrayAppearance {
    pub show_percent: bool,
    pub show_time_left: bool,
}

impl Default for TrayAppearance {
    fn default() -> Self {
        Self { show_percent: true, show_time_left: true }
    }
}

pub const TRAY_ID: &str = "main";
const POPOVER: &str = "main";
/// Ignore a tray click that lands right after the popover lost focus, otherwise
/// "click to close" reopens it immediately (blur hides, then the click shows).
const BLUR_GRACE: Duration = Duration::from_millis(300);

/// Tracks when the popover was last hidden by a blur.
pub struct PopoverGuard(Mutex<Option<Instant>>);

impl PopoverGuard {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

/// What the tray shows. Compared field-by-field so the icon is only redrawn on change.
#[derive(Debug, Clone, PartialEq)]
pub struct TrayState {
    /// Text beside the icon (macOS) / tooltip (elsewhere).
    pub title: String,
    pub tooltip: String,
    /// 0..=100 while printing/paused, `None` when idle.
    pub progress_pct: Option<u8>,
    pub paused: bool,
    pub alert: bool,
    pub offline: bool,
}

impl TrayState {
    pub fn empty() -> Self {
        Self {
            title: String::new(),
            tooltip: "Moonraker Bar — no printer".into(),
            progress_pct: None,
            paused: false,
            alert: false,
            offline: true,
        }
    }

    pub fn from_snapshot(name: &str, s: &Snapshot, appearance: TrayAppearance) -> Self {
        let offline = s.connection != ConnectionState::Connected;
        let alert = s.print_state == "error" || matches!(s.klippy_state.as_str(), "shutdown" | "error");
        let busy = s.is_busy();
        let progress_pct = busy.then(|| (s.progress * 100.0).round().clamp(0.0, 100.0) as u8);
        let paused = s.print_state == "paused";

        let mut parts = Vec::new();
        if !offline && busy {
            if appearance.show_percent {
                parts.push(format!("{}%", progress_pct.unwrap_or(0)));
            }
            if appearance.show_time_left {
                if let Some(left) = s.time_left {
                    parts.push(fmt_duration(left));
                }
            }
        }
        let title = parts.join(" · ");

        let tooltip = if offline {
            format!("{name} — offline")
        } else if busy {
            let file = s.filename.rsplit('/').next().unwrap_or("");
            format!("{name} — {} {file}", if paused { "paused:" } else { "printing" })
        } else {
            format!("{name} — {}", match s.print_state.as_str() {
                "complete" => "print finished",
                "cancelled" => "print cancelled",
                "error" => "error",
                _ => "ready",
            })
        };

        Self { title, tooltip, progress_pct, paused, alert, offline }
    }
}

pub fn fmt_duration(secs: f64) -> String {
    let total = secs.max(0.0).round() as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    if h > 0 {
        format!("{h}h{m:02}")
    } else {
        format!("{m}m")
    }
}

// ---------- setup ----------

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(PopoverGuard::new());

    let open = MenuItem::with_id(app, "open", "Open Moonraker Bar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    let initial = TrayState::empty();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(render_icon(&initial))
        .icon_as_template(true)
        .tooltip(&initial.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_popover(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            tauri_plugin_positioner::on_tray_event(app, &event);
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_popover(app);
            }
        })
        .build(app)?;
    restore_widget(app);
    Ok(())
}

/// Push a new state to the tray (icon, title and tooltip).
pub fn apply(app: &AppHandle, state: &TrayState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_icon(Some(render_icon(state)));
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(&state.tooltip));
    // The progress ring is always present; only its accompanying text is optional.
    let title = if state.title.is_empty() { None } else { Some(state.title.as_str()) };
    let _ = tray.set_title(title);
}

// ---------- popover ----------

fn popover(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(POPOVER)
}

pub fn show_popover(app: &AppHandle) {
    let Some(win) = popover(app) else { return };
    if !is_detached() {
        let _ = win.move_window(Position::TrayCenter);
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit(VISIBILITY_EVENT, true);
}

pub fn hide_popover(app: &AppHandle) {
    if let Some(win) = popover(app) {
        let _ = win.hide();
    }
    crate::camera::stop_all();
    let _ = app.emit(VISIBILITY_EVENT, false);
}

pub fn toggle_popover(app: &AppHandle) {
    let Some(win) = popover(app) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        crate::camera::stop_all();
        let _ = app.emit(VISIBILITY_EVENT, false);
        return;
    }
    if let Some(guard) = app.try_state::<PopoverGuard>() {
        if let Some(t) = *guard.0.lock().unwrap() {
            if t.elapsed() < BLUR_GRACE {
                return;
            }
        }
    }
    show_popover(app);
}

/// Called from the window event hook when the popover loses focus.
pub fn popover_blurred(window: &tauri::Window) {
    if window.label() != POPOVER || is_detached() {
        return;
    }
    let app = window.app_handle();
    if let Some(guard) = app.try_state::<PopoverGuard>() {
        *guard.0.lock().unwrap() = Some(Instant::now());
    }
    let _ = window.hide();
    crate::camera::stop_all();
    let _ = app.emit(VISIBILITY_EVENT, false);
}

// ---------- floating widget ----------

const KEY_DETACHED: &str = "detached";
const KEY_WIDGET_BOUNDS: &str = "widget_bounds";

/// True while the popover is detached from the tray as a floating widget: it stays where
/// the user drops it, on every workspace, and no longer hides when it loses focus.
static DETACHED: AtomicBool = AtomicBool::new(false);

pub fn is_detached() -> bool {
    DETACHED.load(Ordering::Relaxed)
}

pub fn set_detached(app: &AppHandle, detached: bool) {
    DETACHED.store(detached, Ordering::Relaxed);
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(KEY_DETACHED, detached);
    }
    let Some(win) = popover(app) else { return };
    let _ = win.set_visible_on_all_workspaces(detached);
    if detached {
        save_bounds(app);
    } else {
        // A popover again: snap back under the tray icon.
        show_popover(app);
    }
}

/// Divisor from physical pixels to the unit the widget's place is remembered in.
/// Physical pixels are one desktop-wide space only on Windows. On macOS and Linux they are
/// logical points times the scale factor of the monitor the window is on at that moment, so
/// a position saved on a Retina display is misread by a window created on a 1x one.
fn native_scale(scale: f64) -> f64 {
    if cfg!(windows) { 1.0 } else { scale }
}

/// Remember where the widget sits, to put it back there on the next launch.
fn save_bounds(app: &AppHandle) {
    let (Some(win), Ok(store)) = (popover(app), app.store(STORE_FILE)) else { return };
    if let (Ok(p), Ok(s), Ok(scale)) = (win.outer_position(), win.outer_size(), win.scale_factor()) {
        let k = native_scale(scale);
        let (p, s) = (p.to_logical::<f64>(k), s.to_logical::<f64>(k));
        store.set(KEY_WIDGET_BOUNDS, json!([p.x, p.y, s.width, s.height]));
    }
}

/// Called from the window event hook when the popover is moved or resized.
pub fn popover_moved(window: &tauri::Window) {
    if window.label() == POPOVER && is_detached() {
        save_bounds(window.app_handle());
    }
}

/// On launch, put a detached widget back where it was left. It stays hidden here:
/// the web UI shows it once it has something to draw.
fn restore_widget(app: &AppHandle) {
    let (Some(win), Ok(store)) = (popover(app), app.store(STORE_FILE)) else { return };
    if store.get(KEY_DETACHED) != Some(json!(true)) {
        return;
    }
    DETACHED.store(true, Ordering::Relaxed);
    let _ = win.set_visible_on_all_workspaces(true);
    let bounds: Option<[f64; 4]> = store.get(KEY_WIDGET_BOUNDS).and_then(|v| serde_json::from_value(v).ok());
    let (Some([x, y, w, h]), Ok(scale)) = (bounds, win.scale_factor()) else { return };
    // The monitor it was parked on may be unplugged: only restore a position that is still on screen.
    let on_screen = win.available_monitors().unwrap_or_default().iter().any(|m| {
        let k = native_scale(m.scale_factor());
        let (p, s) = (m.position().to_logical::<f64>(k), m.size().to_logical::<f64>(k));
        (p.x..p.x + s.width).contains(&x) && (p.y..p.y + s.height).contains(&y)
    });
    if on_screen {
        // Position first: on Windows, landing on a monitor with another DPI rescales the window.
        let k = native_scale(scale);
        let _ = win.set_position(LogicalPosition::new(x, y).to_physical::<i32>(k));
        let _ = win.set_size(LogicalSize::new(w, h).to_physical::<u32>(k));
    }
}

/// Size the popover to its content (logical px). The popover grows down from the tray;
/// a detached widget grows away from the nearest screen corner, so it stays put when
/// parked there, and is kept inside the work area.
pub fn resize_popover(app: &AppHandle, width: f64, height: f64) {
    let Some(win) = popover(app) else { return };
    // Read the geometry before resizing: the resize is applied asynchronously.
    let frame = (win.outer_position(), win.outer_size(), win.current_monitor(), win.scale_factor());
    let _ = win.set_size(LogicalSize::new(width, height));
    if !is_detached() {
        return;
    }
    let (Ok(pos), Ok(old), Ok(Some(monitor)), Ok(scale)) = frame else { return };
    let new = LogicalSize::new(width, height).to_physical::<i32>(scale);
    let area = monitor.work_area();
    let (x, y) = (
        anchor(pos.x, old.width as i32, new.width, area.position.x, area.size.width as i32),
        anchor(pos.y, old.height as i32, new.height, area.position.y, area.size.height as i32),
    );
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// New origin on one axis for a window going from `old` to `new` long inside `area_start..+area_len`:
/// the far edge stays fixed when the window sits in the far half, then the result is clamped to the area.
fn anchor(pos: i32, old: i32, new: i32, area_start: i32, area_len: i32) -> i32 {
    let far_half = pos + old / 2 > area_start + area_len / 2;
    let moved = if far_half { pos + old - new } else { pos };
    moved.min(area_start + area_len - new).max(area_start)
}

// ---------- icon rendering ----------

const SIZE: u32 = 36; // 18 pt @2x
const OUTER: f32 = 16.0;
const INNER: f32 = 11.5;
const SUPERSAMPLE: u32 = 3;

/// Draw the tray glyph as RGBA. On macOS it is a template image, so only the
/// alpha channel matters and the system tints it for light/dark menu bars.
pub fn render_icon(state: &TrayState) -> Image<'static> {
    #[cfg(target_os = "macos")]
    let ink: [u8; 3] = [0, 0, 0];
    #[cfg(not(target_os = "macos"))]
    let ink: [u8; 3] = [255, 255, 255];

    let center = SIZE as f32 / 2.0;
    let progress = state.progress_pct.map(|p| p as f32 / 100.0);
    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut acc = 0.0f32;
            for sy in 0..SUPERSAMPLE {
                for sx in 0..SUPERSAMPLE {
                    let px = x as f32 + (sx as f32 + 0.5) / SUPERSAMPLE as f32 - center;
                    let py = y as f32 + (sy as f32 + 0.5) / SUPERSAMPLE as f32 - center;
                    acc += coverage(px, py, progress, state);
                }
            }
            let alpha = (acc / (SUPERSAMPLE * SUPERSAMPLE) as f32 * 255.0).round() as u8;
            let i = ((y * SIZE + x) * 4) as usize;
            buf[i] = ink[0];
            buf[i + 1] = ink[1];
            buf[i + 2] = ink[2];
            buf[i + 3] = alpha;
        }
    }
    Image::new_owned(buf, SIZE, SIZE)
}

/// Opacity (0..1) of the glyph at a sub-pixel position relative to the centre.
fn coverage(px: f32, py: f32, progress: Option<f32>, state: &TrayState) -> f32 {
    let r = (px * px + py * py).sqrt();

    // Ring.
    let in_ring = (INNER..=OUTER).contains(&r);
    let ring: f32 = if in_ring {
        match progress {
            Some(p) => {
                // Angle from 12 o'clock, clockwise, 0..1.
                let ang = (px.atan2(-py) / (2.0 * std::f32::consts::PI)).rem_euclid(1.0);
                if ang <= p { 1.0 } else { 0.28 }
            }
            None if state.offline => 0.28,
            None => 1.0,
        }
    } else {
        0.0
    };

    // Centre glyph: pause bars, alert dot, or nothing.
    let inner: f32 = if state.alert {
        if r <= 4.0 { 1.0 } else { 0.0 }
    } else if state.paused {
        let in_bar = |cx: f32| (px - cx).abs() <= 1.6 && py.abs() <= 5.0;
        if in_bar(-3.2) || in_bar(3.2) { 1.0 } else { 0.0 }
    } else {
        0.0
    };

    ring.max(inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn printing() -> Snapshot {
        Snapshot {
            connection: ConnectionState::Connected,
            print_state: "printing".into(),
            progress: 0.64,
            time_left: Some(3720.0),
            ..Default::default()
        }
    }

    #[test]
    fn independent_labels_never_change_the_ring() {
        for (percent, time, expected) in [
            (false, false, ""),
            (true, false, "64%"),
            (false, true, "1h02"),
            (true, true, "64% · 1h02"),
        ] {
            let state = TrayState::from_snapshot("Printer", &printing(), TrayAppearance {
                show_percent: percent, show_time_left: time,
            });
            assert_eq!(state.title, expected);
            assert_eq!(state.progress_pct, Some(64));
            assert!(render_icon(&state).rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
    }

    #[test]
    fn missing_eta_idle_offline_and_paused() {
        let appearance = TrayAppearance { show_percent: true, show_time_left: true };
        let mut snapshot = printing();
        snapshot.time_left = None;
        assert_eq!(TrayState::from_snapshot("P", &snapshot, appearance).title, "64%");
        let time_only = TrayAppearance { show_percent: false, show_time_left: true };
        assert_eq!(TrayState::from_snapshot("P", &snapshot, time_only).title, "");
        snapshot.print_state = "paused".into();
        let paused = TrayState::from_snapshot("P", &snapshot, appearance);
        assert!(paused.paused);
        assert_eq!(paused.progress_pct, Some(64));
        snapshot.connection = ConnectionState::Offline;
        assert_eq!(TrayState::from_snapshot("P", &snapshot, appearance).title, "");
        snapshot.connection = ConnectionState::Connected;
        snapshot.print_state = "standby".into();
        assert_eq!(TrayState::from_snapshot("P", &snapshot, appearance).title, "");
    }

    #[test]
    fn widget_resizes_away_from_the_nearest_edge() {
        // Screen axis 0..1000. Near the start: the origin stays put.
        assert_eq!(anchor(10, 360, 260, 0, 1000), 10);
        // Flush against the far edge: the far edge stays put, both shrinking and growing.
        assert_eq!(anchor(640, 360, 260, 0, 1000), 740);
        assert_eq!(anchor(740, 260, 360, 0, 1000), 640);
        // Growing past the end, or dragged off the start, is pulled back inside.
        assert_eq!(anchor(400, 100, 700, 0, 1000), 300);
        assert_eq!(anchor(-50, 100, 100, 0, 1000), 0);
        // A second monitor to the right keeps its own offset.
        assert_eq!(anchor(2700, 260, 360, 2000, 1000), 2600);
    }

    #[test]
    fn absent_preferences_preserve_original_labels() {
        let appearance: TrayAppearance = serde_json::from_str("{}").unwrap();
        assert_eq!(appearance, TrayAppearance::default());
        assert!(appearance.show_percent && appearance.show_time_left);
        assert_eq!(TrayState::from_snapshot("P", &printing(), appearance).title, "64% · 1h02");
        let partial: TrayAppearance = serde_json::from_str(r#"{"show_percent":false}"#).unwrap();
        assert!(!partial.show_percent && partial.show_time_left);
        let saved: TrayAppearance = serde_json::from_str(r#"{"show_percent":false,"show_time_left":false}"#).unwrap();
        assert!(!saved.show_percent && !saved.show_time_left);
    }
}
