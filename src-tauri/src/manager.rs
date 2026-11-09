//! Owns every configured printer: persistence, one client task per printer,
//! fan-out of updates to the UI, notifications and the tray refresh.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;
use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};

use crate::moonraker::{self, Action, Command, PrinterConfig, PrinterUpdate, Snapshot};
use crate::tray;

const STORE_FILE: &str = "settings.json";
const KEY_PRINTERS: &str = "printers";
const KEY_ACTIVE: &str = "active";
const KEY_LAYOUT: &str = "layout";
const KEY_TRAY_APPEARANCE: &str = "tray_appearance";

/// Which cards the panel shows, and in what order. Keys are the card ids the
/// front knows: job, temps, controls, afc, macros, camera, actions.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default, PartialEq)]
pub struct Layout {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub hidden: Vec<String>,
}

pub struct PrinterHandle {
    pub cfg: PrinterConfig,
    pub snapshot: Arc<RwLock<Snapshot>>,
    cmd_tx: mpsc::Sender<Command>,
    stop: watch::Sender<bool>,
}

pub struct Manager {
    app: AppHandle,
    printers: Mutex<Vec<PrinterHandle>>,
    /// Printer the tray follows. `None` = whichever is busy, else the first one.
    active: Mutex<Option<String>>,
    layout: Mutex<Layout>,
    tray_appearance: Mutex<tray::TrayAppearance>,
    updates_tx: mpsc::Sender<PrinterUpdate>,
    /// Last known `print_state` per printer, for transition notifications.
    last_states: Mutex<HashMap<String, String>>,
    last_tray: Mutex<Option<tray::TrayState>>,
}

impl Manager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<PrinterUpdate>(256);
        let mgr = Arc::new(Self {
            app,
            printers: Mutex::new(Vec::new()),
            active: Mutex::new(None),
            layout: Mutex::new(Layout::default()),
            tray_appearance: Mutex::new(tray::TrayAppearance::default()),
            updates_tx: tx,
            last_states: Mutex::new(HashMap::new()),
            last_tray: Mutex::new(None),
        });
        let consumer = mgr.clone();
        tauri::async_runtime::spawn(async move { consumer.consume(rx).await });
        mgr
    }

    // ---------- persistence ----------

    /// Read the store and start a client for every saved printer.
    pub async fn load(&self) {
        let (configs, active, layout, appearance) = match self.app.store(STORE_FILE) {
            Ok(store) => {
                let configs: Vec<PrinterConfig> = store
                    .get(KEY_PRINTERS)
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                let active: Option<String> = store
                    .get(KEY_ACTIVE)
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or(None);
                let layout: Layout = store
                    .get(KEY_LAYOUT)
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                let appearance = store
                    .get(KEY_TRAY_APPEARANCE)
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                (configs, active, layout, appearance)
            }
            Err(e) => {
                log::error!("store unavailable: {e}");
                (Vec::new(), None, Layout::default(), tray::TrayAppearance::default())
            }
        };
        *self.active.lock().await = active;
        *self.layout.lock().await = layout;
        *self.tray_appearance.lock().await = appearance;
        for cfg in configs {
            self.spawn(cfg).await;
        }
        self.refresh_tray().await;
    }

    async fn persist(&self) {
        let printers: Vec<PrinterConfig> =
            self.printers.lock().await.iter().map(|h| h.cfg.clone()).collect();
        let active = self.active.lock().await.clone();
        let layout = self.layout.lock().await.clone();
        match self.app.store(STORE_FILE) {
            Ok(store) => {
                store.set(KEY_PRINTERS, json!(printers));
                store.set(KEY_ACTIVE, json!(active));
                store.set(KEY_LAYOUT, json!(layout));
                if let Err(e) = store.save() {
                    log::error!("store save failed: {e}");
                }
            }
            Err(e) => log::error!("store unavailable: {e}"),
        }
    }

    // ---------- printers ----------

    async fn spawn(&self, cfg: PrinterConfig) {
        let snapshot = Arc::new(RwLock::new(Snapshot::default()));
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>(16);
        let (stop_tx, stop_rx) = watch::channel(false);
        tauri::async_runtime::spawn(moonraker::client::run(
            cfg.clone(),
            snapshot.clone(),
            self.updates_tx.clone(),
            cmd_rx,
            stop_rx,
        ));
        self.printers.lock().await.push(PrinterHandle { cfg, snapshot, cmd_tx, stop: stop_tx });
    }

    pub async fn list(&self) -> Vec<PrinterConfig> {
        self.printers.lock().await.iter().map(|h| h.cfg.clone()).collect()
    }

    pub async fn snapshots(&self) -> HashMap<String, Snapshot> {
        let printers = self.printers.lock().await;
        let mut out = HashMap::with_capacity(printers.len());
        for h in printers.iter() {
            out.insert(h.cfg.id.clone(), h.snapshot.read().await.clone());
        }
        out
    }

    pub async fn add(&self, mut cfg: PrinterConfig) -> PrinterConfig {
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        self.spawn(cfg.clone()).await;
        self.persist().await;
        self.emit_printers().await;
        cfg
    }

    pub async fn update(&self, cfg: PrinterConfig) -> Result<(), String> {
        let (old, idx) = {
            let mut printers = self.printers.lock().await;
            let idx = printers
                .iter()
                .position(|h| h.cfg.id == cfg.id)
                .ok_or_else(|| "Unknown printer".to_string())?;
            (printers.remove(idx), idx)
        };
        let _ = old.stop.send(true);
        // Keep ordering stable: re-insert at the same index.
        let snapshot = Arc::new(RwLock::new(Snapshot::default()));
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>(16);
        let (stop_tx, stop_rx) = watch::channel(false);
        tauri::async_runtime::spawn(moonraker::client::run(
            cfg.clone(),
            snapshot.clone(),
            self.updates_tx.clone(),
            cmd_rx,
            stop_rx,
        ));
        {
            let mut printers = self.printers.lock().await;
            let idx = idx.min(printers.len());
            printers.insert(idx, PrinterHandle { cfg, snapshot, cmd_tx, stop: stop_tx });
        }
        self.persist().await;
        self.emit_printers().await;
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let removed = {
            let mut printers = self.printers.lock().await;
            let idx = printers
                .iter()
                .position(|h| h.cfg.id == id)
                .ok_or_else(|| "Unknown printer".to_string())?;
            printers.remove(idx)
        };
        let _ = removed.stop.send(true);
        {
            let mut active = self.active.lock().await;
            if active.as_deref() == Some(id) {
                *active = None;
            }
        }
        self.last_states.lock().await.remove(id);
        self.persist().await;
        self.emit_printers().await;
        self.refresh_tray().await;
        Ok(())
    }

    /// Change the pinned macro list without restarting the printer's client.
    pub async fn set_pinned_macros(&self, id: &str, macros: Vec<String>) -> Result<(), String> {
        {
            let mut printers = self.printers.lock().await;
            let h = printers
                .iter_mut()
                .find(|h| h.cfg.id == id)
                .ok_or_else(|| "Unknown printer".to_string())?;
            h.cfg.pinned_macros = macros;
        }
        self.persist().await;
        self.emit_printers().await;
        Ok(())
    }

    /// Change which temperature tiles are shown without restarting the client.
    pub async fn set_shown_temps(&self, id: &str, objects: Vec<String>) -> Result<(), String> {
        {
            let mut printers = self.printers.lock().await;
            let h = printers
                .iter_mut()
                .find(|h| h.cfg.id == id)
                .ok_or_else(|| "Unknown printer".to_string())?;
            h.cfg.shown_temps = objects;
        }
        self.persist().await;
        self.emit_printers().await;
        Ok(())
    }

    pub async fn layout(&self) -> Layout {
        self.layout.lock().await.clone()
    }

    pub async fn set_layout(&self, layout: Layout) {
        *self.layout.lock().await = layout;
        self.persist().await;
    }

    pub async fn tray_appearance(&self) -> tray::TrayAppearance {
        *self.tray_appearance.lock().await
    }

    pub async fn set_tray_appearance(&self, appearance: tray::TrayAppearance) -> Result<(), String> {
        let store = self.app.store(STORE_FILE).map_err(|e| e.to_string())?;
        store.set(KEY_TRAY_APPEARANCE, json!(appearance));
        store.save().map_err(|e| e.to_string())?;
        *self.tray_appearance.lock().await = appearance;
        self.refresh_tray().await;
        Ok(())
    }

    pub async fn active(&self) -> Option<String> {
        self.active.lock().await.clone()
    }

    pub async fn set_active(&self, id: Option<String>) {
        *self.active.lock().await = id;
        self.persist().await;
        self.refresh_tray().await;
    }

    pub async fn execute(&self, id: &str, action: Action) -> Result<(), String> {
        let cmd_tx = {
            let printers = self.printers.lock().await;
            printers
                .iter()
                .find(|h| h.cfg.id == id)
                .map(|h| h.cmd_tx.clone())
                .ok_or_else(|| "Unknown printer".to_string())?
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(Command { action, reply: reply_tx })
            .await
            .map_err(|_| "Printer stopped".to_string())?;
        reply_rx
            .await
            .map_err(|_| "No reply".to_string())?
            .map(|_| ())
    }

    // ---------- fan-out ----------

    async fn emit_printers(&self) {
        let list = self.list().await;
        let _ = self.app.emit("printers:changed", &list);
    }

    async fn consume(self: Arc<Self>, mut rx: mpsc::Receiver<PrinterUpdate>) {
        while let Some(update) = rx.recv().await {
            let _ = self.app.emit("printer:update", &update);
            self.notify_transitions(&update).await;
            self.refresh_tray().await;
        }
    }

    async fn notify_transitions(&self, update: &PrinterUpdate) {
        let name = {
            let printers = self.printers.lock().await;
            match printers.iter().find(|h| h.cfg.id == update.id) {
                Some(h) => h.cfg.name.clone(),
                None => return,
            }
        };
        let new_state = update.snapshot.print_state.clone();
        if new_state.is_empty() {
            return;
        }
        let prev = {
            let mut states = self.last_states.lock().await;
            states.insert(update.id.clone(), new_state.clone())
        };
        let Some(prev) = prev else { return };
        if prev == new_state {
            return;
        }
        let file = update.snapshot.filename.rsplit('/').next().unwrap_or("").to_string();
        let body = match (prev.as_str(), new_state.as_str()) {
            ("printing", "complete") => Some(format!("Print finished: {file}")),
            ("printing" | "paused", "error") => Some(format!("Print error: {file}")),
            ("printing" | "paused", "cancelled") => Some(format!("Print cancelled: {file}")),
            ("printing", "paused") => {
                let why = update.snapshot.message.trim();
                Some(if why.is_empty() {
                    format!("Print paused: {file}")
                } else {
                    format!("Paused — {why}")
                })
            }
            (_, "printing") if prev != "paused" => Some(format!("Print started: {file}")),
            _ => None,
        };
        if let Some(body) = body {
            if let Err(e) = self.app.notification().builder().title(&name).body(&body).show() {
                log::warn!("notification failed: {e}");
            }
        }
    }

    /// Pick the printer the tray should show and push its state to the icon.
    async fn refresh_tray(&self) {
        let appearance = self.tray_appearance().await;
        let picked = self.pick_tray_printer().await;
        let state = match picked {
            Some((name, snapshot)) => tray::TrayState::from_snapshot(&name, &snapshot, appearance),
            None => tray::TrayState::empty(),
        };
        self.apply_tray(state).await;
    }

    /// The pinned printer if any, else the first busy one, else the first one.
    async fn pick_tray_printer(&self) -> Option<(String, Snapshot)> {
        let printers = self.printers.lock().await;
        if printers.is_empty() {
            return None;
        }
        let active = self.active.lock().await.clone();
        let mut idx = active
            .as_deref()
            .and_then(|id| printers.iter().position(|h| h.cfg.id == id));
        if idx.is_none() {
            for (i, h) in printers.iter().enumerate() {
                if h.snapshot.read().await.is_busy() {
                    idx = Some(i);
                    break;
                }
            }
        }
        let h = &printers[idx.unwrap_or(0)];
        let snapshot = h.snapshot.read().await.clone();
        Some((h.cfg.name.clone(), snapshot))
    }

    async fn apply_tray(&self, state: tray::TrayState) {
        let mut last = self.last_tray.lock().await;
        if last.as_ref() == Some(&state) {
            return;
        }
        tray::apply(&self.app, &state);
        *last = Some(state);
    }
}
