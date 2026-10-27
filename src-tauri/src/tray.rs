//! Tray icon (menu bar on macOS), its live-rendered progress glyph, and the
//! popover window it toggles.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Tells the web UI whether the popover is on screen, so it can stop the camera stream when hidden.
const VISIBILITY_EVENT: &str = "popover:visibility";
use tauri_plugin_positioner::{Position, WindowExt};

use crate::moonraker::{ConnectionState, Snapshot};

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

    pub fn from_snapshot(name: &str, s: &Snapshot) -> Self {
        let offline = s.connection != ConnectionState::Connected;
        let alert = s.print_state == "error" || matches!(s.klippy_state.as_str(), "shutdown" | "error");
        let busy = s.is_busy();
        let progress_pct = busy.then(|| (s.progress * 100.0).round().clamp(0.0, 100.0) as u8);
        let paused = s.print_state == "paused";

        let title = if offline {
            String::new()
        } else if busy {
            match s.time_left {
                Some(left) => format!("{}% · {}", progress_pct.unwrap_or(0), fmt_duration(left)),
                None => format!("{}%", progress_pct.unwrap_or(0)),
            }
        } else {
            String::new()
        };

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
    Ok(())
}

/// Push a new state to the tray (icon, title and tooltip).
pub fn apply(app: &AppHandle, state: &TrayState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_icon(Some(render_icon(state)));
    let _ = tray.set_icon_as_template(true);
    let _ = tray.set_tooltip(Some(&state.tooltip));
    // Only macOS renders a title next to the icon; elsewhere the call is a no-op or errors.
    let title = if state.title.is_empty() { None } else { Some(state.title.as_str()) };
    let _ = tray.set_title(title);
}

// ---------- popover ----------

fn popover(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(POPOVER)
}

pub fn show_popover(app: &AppHandle) {
    let Some(win) = popover(app) else { return };
    let _ = win.move_window(Position::TrayCenter);
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
    if window.label() != POPOVER {
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
