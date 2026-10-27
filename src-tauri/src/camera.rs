//! MJPEG camera streams, read by the backend.
//!
//! An `<img>` pointed at an MJPEG URL keeps its HTTP connection open in WKWebView
//! even after the element is removed or its src changed. Every time the panel was
//! shown again a new connection piled up, until the camera server (crowsnest /
//! ustreamer / mjpg-streamer) ran out of client slots and stopped sending frames.
//! Here each stream is one task we own: aborting it drops the connection for real.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::async_runtime::{self, JoinHandle};

/// No frame for this long: report the stream as failed so the UI can retry.
const STALL: Duration = Duration::from_secs(6);
/// Frames sent to the UI at most this often (~15 fps).
const MIN_FRAME_GAP: Duration = Duration::from_millis(66);
/// Drop the buffer if a frame never ends (not an MJPEG stream).
const MAX_BUFFER: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CameraEvent {
    /// One JPEG frame, base64.
    Frame { data: String },
    Error { message: String },
}

fn streams() -> &'static Mutex<HashMap<u64, JoinHandle<()>>> {
    static S: OnceLock<Mutex<HashMap<u64, JoinHandle<()>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Starts reading `url` and returns the stream id to pass to [`stop`].
pub fn start(url: String, channel: Channel<CameraEvent>) -> u64 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    // Tauri's runtime, not tokio::spawn: sync commands run on the main thread, outside any runtime.
    let task = async_runtime::spawn(async move {
        if let Err(message) = run(&url, &channel).await {
            log::info!("camera stream {url}: {message}");
            let _ = channel.send(CameraEvent::Error { message });
        }
        streams().lock().unwrap().remove(&id);
    });
    streams().lock().unwrap().insert(id, task);
    id
}

/// Stops a stream and closes its connection. Unknown ids are ignored.
pub fn stop(id: u64) {
    if let Some(task) = streams().lock().unwrap().remove(&id) {
        task.abort();
    }
}

/// Stops every stream, e.g. when the popover is hidden.
pub fn stop_all() {
    for (_, task) in streams().lock().unwrap().drain() {
        task.abort();
    }
}

async fn run(url: &str, channel: &Channel<CameraEvent>) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = tokio::time::timeout(STALL, client.get(url).send())
        .await
        .map_err(|_| "no response".to_string())?
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let mut buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut last_sent: Option<Instant> = None;
    let mut last_frame = Instant::now();
    loop {
        let chunk = tokio::time::timeout(STALL, resp.chunk())
            .await
            .map_err(|_| "stalled".to_string())?
            .map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else {
            return Err("stream ended".into());
        };
        buf.extend_from_slice(&chunk);

        // Keep only the newest complete JPEG in the buffer (SOI ff d8 .. EOI ff d9).
        let mut newest: Option<(usize, usize)> = None;
        let mut from = 0;
        while let Some(soi) = find(&buf[from..], &[0xff, 0xd8]).map(|i| i + from) {
            match find(&buf[soi + 2..], &[0xff, 0xd9]).map(|i| i + soi + 2) {
                Some(eoi) => {
                    newest = Some((soi, eoi + 2));
                    from = eoi + 2;
                }
                None => break,
            }
        }
        if let Some((a, b)) = newest {
            last_frame = Instant::now();
            if last_sent.map_or(true, |t| t.elapsed() >= MIN_FRAME_GAP) {
                let data = base64::engine::general_purpose::STANDARD.encode(&buf[a..b]);
                channel.send(CameraEvent::Frame { data }).map_err(|e| e.to_string())?;
                last_sent = Some(Instant::now());
            }
            buf.drain(..b);
        }
        if last_frame.elapsed() > STALL {
            return Err("no frame".into());
        }
        if buf.len() > MAX_BUFFER {
            return Err("not an MJPEG stream".into());
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}
