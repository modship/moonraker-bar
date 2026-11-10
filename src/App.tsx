import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Settings as SettingsIcon, X, Power, ChevronLeft, ExternalLink, Download, Loader2 } from "lucide-react";
import { useStore, useSelectedPrinter } from "./store";
import { backend } from "./lib/backend";
import { cn, webUiUrl } from "./lib/format";
import { useUpdater } from "./lib/useUpdater";
import { PrinterSwitcher } from "./components/PrinterSwitcher";
import { PrinterPanel } from "./components/PrinterPanel";
import { Fleet } from "./components/Fleet";
import { Settings } from "./components/Settings";
import { Badge, IconButton } from "./components/ui";

const WIDTH = 360;
const MIN_HEIGHT = 220;
/** Room left for the menu bar / taskbar and a margin, in logical px. */
const SCREEN_MARGIN = 48;

export default function App() {
  const { ready, view, setView, error, setError, printers, snapshots, editing, setEditing } = useStore();
  const { printer } = useSelectedPrinter();
  const rootRef = useRef<HTMLDivElement>(null);
  const updater = useUpdater();
  const webUi = printer ? webUiUrl(printer) : null;

  useEffect(() => {
    useStore.getState().init().catch((e) => setError(String(e)));
  }, [setError]);

  // Escape closes the popover, like a native menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") backend.hidePopover();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Size the native window to the content, so the popover never shows dead space
  // and never needs a scrollbar as long as it fits on screen.
  const [maxHeight, setMaxHeight] = useState(900);
  useEffect(() => {
    const refresh = () =>
      currentMonitor()
        .then((m) => {
          if (m) setMaxHeight(Math.max(MIN_HEIGHT, Math.floor(m.size.height / m.scaleFactor) - SCREEN_MARGIN));
        })
        .catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let last = 0;
    const apply = () => {
      const h = Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.ceil(el.getBoundingClientRect().height)));
      if (h === last) return;
      last = h;
      getCurrentWindow()
        .setSize(new LogicalSize(WIDTH, h))
        .catch(() => {});
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, [maxHeight]);

  const multi = printers.length > 1;
  const title = view === "settings" ? "Settings" : view === "fleet" ? "Printers" : null;
  // A printer form open in Settings takes over the header, and its own actions replace the footer.
  const detail = view === "settings" && editing != null;
  const edited = typeof editing === "string" ? printers.find((p) => p.id === editing) : undefined;

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex flex-col overflow-hidden rounded-[var(--radius-popover)]",
        "border border-line bg-surface text-fg",
      )}
      style={{ maxHeight }}
    >
      <header className="drag flex items-center gap-1 px-3 pt-2.5 pb-2">
        {view === "panel" ? (
          <>
            {multi && (
              <IconButton title="All printers" onClick={() => setView("fleet")} className="-ml-1 mr-0.5">
                <ChevronLeft size={15} />
              </IconButton>
            )}
            <PrinterSwitcher />
          </>
        ) : detail ? (
          <>
            <IconButton title="Back" onClick={() => setEditing(null)} className="-ml-1 mr-0.5">
              <ChevronLeft size={15} />
            </IconButton>
            <div className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{edited?.name ?? "Add printer"}</div>
            {edited &&
              (snapshots[edited.id]?.connection === "connected" ? (
                <Badge tone="ok">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" /> Online
                </Badge>
              ) : (
                <Badge>Offline</Badge>
              ))}
          </>
        ) : (
          <div className="flex-1 text-[15px] font-semibold tracking-tight">{title}</div>
        )}
        {view === "panel" && webUi && (
          <IconButton title={`Open ${webUi}`} onClick={() => openUrl(webUi).catch((e) => setError(String(e)))}>
            <ExternalLink size={15} />
          </IconButton>
        )}
        {detail ? null : view === "settings" ? (
          <IconButton title="Back" onClick={() => setView(multi ? "fleet" : "panel")}>
            <X size={15} />
          </IconButton>
        ) : (
          <IconButton title="Settings" onClick={() => setView("settings")}>
            <SettingsIcon size={15} />
          </IconButton>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {!ready ? (
          <div className="py-10 text-center text-fg-2">Loading…</div>
        ) : view === "panel" ? (
          <PrinterPanel />
        ) : view === "fleet" ? (
          <Fleet />
        ) : (
          <Settings />
        )}
      </main>

      {error && (
        <div className="mx-3 mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            OK
          </button>
        </div>
      )}

      {!detail && (
        <footer className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px] text-fg-3">
          <UpdateStatus updater={updater} />
          <button
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg"
            onClick={() => backend.quit()}
            title="Quit"
          >
            <Power size={11} /> Quit
          </button>
        </footer>
      )}
    </div>
  );
}

function UpdateStatus({ updater }: { updater: ReturnType<typeof useUpdater> }) {
  const { state, install } = updater;
  switch (state.kind) {
    case "available":
      return (
        <button
          onClick={install}
          title={state.notes || `Install version ${state.version}`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent/10"
        >
          <Download size={11} /> Update {state.version}
        </button>
      );
    case "downloading":
      return (
        <span className="flex items-center gap-1 text-fg-2">
          <Loader2 size={11} className="animate-spin" /> Downloading
          {state.progress != null ? ` ${Math.round(state.progress * 100)}%` : "…"}
        </span>
      );
    case "ready":
      return <span className="text-fg-2">Restarting…</span>;
    case "error":
      return (
        <span className="truncate text-danger" title={state.message}>
          Update failed
        </span>
      );
    default:
      return <span>Moonraker Bar v{__APP_VERSION__}</span>;
  }
}
