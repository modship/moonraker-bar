import { ChevronRight, Maximize2, Pin } from "lucide-react";
import { useStore } from "@/store";
import { EMPTY_SNAPSHOT, isBusy, type PrinterConfig, type Snapshot } from "@/lib/types";
import { cn, fmtDuration, fmtFilename, fmtPct, fmtTemp } from "@/lib/format";
import { ProgressRing } from "./ProgressRing";
import { PrinterArt } from "./PrinterArt";
import { detectModel } from "@/lib/model";
import { artState, partColor, artTools } from "@/lib/art";
import { Card, IconButton } from "./ui";

/** All printers at a glance; click one to open its panel. `compact` is the floating widget's small view. */
export function Fleet({ compact }: { compact?: boolean }) {
  const { printers, snapshots, activeId, select, pin, setCompact } = useStore();
  const sorted = [...printers].sort((a, b) => urgency(snapshots[a.id]) - urgency(snapshots[b.id]));
  if (compact) {
    return (
      // No header to grab here: the whole widget drags, except its buttons.
      <div data-tauri-drag-region="deep" className="flex flex-col">
        {sorted.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-3 py-2">
            <Summary printer={p} snapshot={snapshots[p.id] ?? EMPTY_SNAPSHOT} />
            <IconButton
              title="Full view"
              onClick={() => {
                select(p.id);
                setCompact(false);
              }}
            >
              <Maximize2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {sorted.map((p) => (
        <FleetRow
          key={p.id}
          printer={p}
          snapshot={snapshots[p.id] ?? EMPTY_SNAPSHOT}
          pinned={activeId === p.id}
          onOpen={() => select(p.id)}
          onPin={() => pin(activeId === p.id ? null : p.id)}
        />
      ))}
    </div>
  );
}

function FleetRow({
  printer,
  snapshot: s,
  pinned,
  onOpen,
  onPin,
}: {
  printer: PrinterConfig;
  snapshot: Snapshot;
  pinned: boolean;
  onOpen: () => void;
  onPin: () => void;
}) {
  return (
    <Card className={cn("group flex items-center gap-3 p-2.5 transition hover:bg-surface-3/50", s.connection !== "connected" && "opacity-70")}>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Summary printer={printer} snapshot={s} />
      </button>
      <button
        title={pinned ? "The menu bar follows this printer" : "Pin to the menu bar"}
        onClick={onPin}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition",
          pinned ? "bg-accent/15 text-accent" : "text-fg-3 opacity-0 hover:bg-surface-3 hover:text-fg group-hover:opacity-100",
        )}
      >
        <Pin size={12} />
      </button>
      <ChevronRight size={14} className="shrink-0 text-fg-3" />
    </Card>
  );
}

/** Progress ring (the printer's drawing when idle) and status lines: a fleet row, and a line of the compact widget. */
function Summary({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const online = s.connection === "connected";
  const busy = isBusy(s);
  const paused = s.print_state === "paused";
  const alert = s.print_state === "error" || s.klippy_state === "shutdown" || s.klippy_state === "error";

  const subtitle = !online
    ? s.connection === "connecting"
      ? "Connecting…"
      : "Offline"
    : alert
      ? "Klipper error"
      : busy
        ? fmtFilename(s.filename)
        : s.print_state === "complete"
          ? `Done · ${fmtFilename(s.filename)}`
          : "Ready";

  const detail = online && busy ? (s.time_left != null ? `${fmtDuration(s.time_left)} left` : "estimating…") : online ? `${fmtTemp(s.extruder.temperature)} · ${fmtTemp(s.bed.temperature)}` : "";

  return (
    <>
      {busy ? (
        <ProgressRing value={s.progress} paused={paused} size={44} stroke={5}>
          <span className="text-[10px] font-semibold tabular-nums">{fmtPct(s.progress)}</span>
        </ProgressRing>
      ) : (
        <PrinterArt model={detectModel(printer, s)} tools={artTools(detectModel(printer, s), s)} progress={0} state={artState(s)} color={partColor(s)} size={48} className="-m-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold tracking-tight">{printer.name}</span>
          {paused && <span className="rounded-full bg-warn/15 px-1.5 text-[10px] font-medium text-warn">paused</span>}
        </div>
        <div className={cn("truncate text-[12px]", alert ? "text-danger" : "text-fg-2")}>{subtitle}</div>
        {detail && <div className="truncate text-[11px] tabular-nums text-fg-3">{detail}</div>}
      </div>
    </>
  );
}

/** Printers that need attention first: error, paused, printing, idle, offline. */
function urgency(s: Snapshot | undefined): number {
  if (!s || s.connection !== "connected") return 4;
  if (s.print_state === "error" || s.klippy_state === "shutdown" || s.klippy_state === "error") return 0;
  if (s.print_state === "paused") return 1;
  if (s.print_state === "printing") return 2;
  return 3;
}
