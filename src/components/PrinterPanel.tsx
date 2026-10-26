import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Pause,
  Play,
  Square,
  Gauge,
  AlertTriangle,
  RotateCcw,
  Fan,
  Camera,
  Terminal,
  Check,
  Loader2,
  Home,
  Unplug,
  Flame,
  Snowflake,
} from "lucide-react";
import { useStore, useSelectedPrinter } from "@/store";
import { backend } from "@/lib/backend";
import { isBusy, resolveLayout, type CardId, type PrinterConfig, type Snapshot } from "@/lib/types";
import { useAction } from "@/lib/useAction";
import { cameraSource } from "@/lib/camera";
import { detectModel } from "@/lib/model";
import { artState, partColor, artTools } from "@/lib/art";
import { useThumbnail } from "@/lib/useThumbnail";
import { PrinterArt } from "./PrinterArt";
import { tempColor, tempLabel, visibleTemps } from "@/lib/temps";
import { AfcCard } from "./Afc";
import { cn, fmtDuration, fmtEta, fmtFilename, fmtPct, fmtTemp, fmtFilament } from "@/lib/format";
import { Badge, Button, Card, Input } from "./ui";

export function PrinterPanel() {
  const { printer, snapshot } = useSelectedPrinter();
  const setView = useStore((s) => s.setView);
  const layout = useStore((s) => s.layout);

  if (!printer) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="text-fg-2">No printer configured.</div>
        <Button variant="primary" onClick={() => setView("settings")}>
          Add a printer
        </Button>
      </div>
    );
  }

  if (snapshot.connection !== "connected") {
    return <OfflineCard printer={printer} snapshot={snapshot} />;
  }

  const busy = isBusy(snapshot);
  const { order, hidden } = resolveLayout(layout);

  const cards: Record<CardId, ReactNode> = {
    job: (
      <>
        <JobCard printer={printer} snapshot={snapshot} />
        {snapshot.message && snapshot.message !== snapshot.filename && (
          <div className="truncate rounded-lg bg-surface-3 px-3 py-1.5 text-[12px] text-fg-2" title={snapshot.message}>
            {snapshot.message}
          </div>
        )}
      </>
    ),
    temps: <Temperatures printer={printer} snapshot={snapshot} />,
    controls: busy ? <Controls printer={printer} snapshot={snapshot} /> : null,
    afc: snapshot.afc ? <AfcCard printer={printer} snapshot={snapshot} afc={snapshot.afc} /> : null,
    macros: <Macros printer={printer} snapshot={snapshot} />,
    camera: <CameraCard printer={printer} snapshot={snapshot} />,
    actions: <QuickActions printer={printer} snapshot={snapshot} />,
  };

  return (
    <div className="flex flex-col gap-2.5">
      {snapshot.klippy_state !== "ready" && <KlippyBanner printer={printer} snapshot={snapshot} />}
      {order
        .filter((id) => !hidden.has(id) && cards[id] != null)
        .map((id) => (
          <div key={id} className="contents">
            {cards[id]}
          </div>
        ))}
    </div>
  );
}

// ---------- pieces ----------

function OfflineCard({ printer, snapshot }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const connecting = snapshot.connection === "connecting";
  return (
    <Card className="flex flex-col items-center gap-2 py-8 text-center">
      <div className={cn("h-3 w-3 rounded-full", connecting ? "bg-warn pulse-soft" : "bg-fg-3")} />
      <div className="font-semibold">{connecting ? "Connecting…" : "Offline"}</div>
      <div className="text-[12px] text-fg-2">{printer.url}</div>
      {snapshot.last_error && <div className="text-[12px] text-danger">{snapshot.last_error}</div>}
      {!connecting && <div className="text-[11px] text-fg-3">Retrying automatically…</div>}
    </Card>
  );
}

function KlippyBanner({ printer, snapshot }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const [busy, setBusy] = useState(false);
  const bad = snapshot.klippy_state === "shutdown" || snapshot.klippy_state === "error";
  const restart = async () => {
    setBusy(true);
    try {
      await backend.action(printer.id, "firmware_restart");
    } catch (e) {
      useStore.getState().setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("rounded-lg px-3 py-2 text-[12px]", bad ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn")}>
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle size={13} />
        Klipper: {labelKlippy(snapshot.klippy_state)}
      </div>
      {snapshot.klippy_message && (
        <div className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] opacity-90">
          {snapshot.klippy_message}
        </div>
      )}
      {bad && (
        <Button size="sm" variant="danger" className="mt-2" icon={<RotateCcw size={12} />} disabled={busy} onClick={restart}>
          Firmware restart
        </Button>
      )}
    </div>
  );
}

function labelKlippy(state: string) {
  switch (state) {
    case "startup":
      return "starting up";
    case "shutdown":
      return "shutdown";
    case "error":
      return "error";
    case "disconnected":
      return "disconnected";
    default:
      return state || "unknown";
  }
}

function JobCard({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const busy = isBusy(s);
  const finished = s.print_state === "complete" || s.print_state === "cancelled" || s.print_state === "error";
  const model = detectModel(printer, s);
  const thumb = useThumbnail(printer.id, busy || finished ? s.thumbnail : null);
  const material = s.afc?.lanes.find((l) => l.name === s.afc?.current_load)?.material || s.filament_type;

  // Idle: a compact one-line card.
  if (!busy && !finished) {
    return (
      <Card className="flex items-center gap-3 py-2">
        <PrinterArt model={model} tools={artTools(model, s)} progress={0} state={artState(s)} size={48} className="-my-1 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-tight">Ready to print</div>
          <div className="truncate text-[11px] text-fg-3">
            {s.hostname || "Klipper"}
            {s.software_version ? ` · Moonraker ${s.software_version.replace(/^v/, "").split("-")[0]}` : ""}
          </div>
        </div>
        <span className="h-2 w-2 rounded-full bg-ok" />
      </Card>
    );
  }

  const pct = s.print_state === "complete" ? 1 : s.progress;
  return (
    <Card>
      <div className="flex items-stretch gap-3">
        <div className="-my-1 -ml-1 shrink-0">
          <PrinterArt model={model} tools={artTools(model, s)} progress={pct} state={artState(s)} color={partColor(s)} size={112} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-1.5">
                <StateBadge snapshot={s} />
                {material && <span className="truncate text-[11px] text-fg-3">{material}</span>}
              </div>
              <div className="truncate text-[14px] font-semibold tracking-tight" title={s.filename}>
                {s.filename ? fmtFilename(s.filename) : "No file"}
              </div>
            </div>
            {thumb && (
              <img src={thumb} alt="" className="h-11 w-11 shrink-0 rounded-lg border border-line bg-surface-3 object-contain" />
            )}
          </div>

          {busy ? (
            <>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-[22px] font-semibold leading-none tabular-nums tracking-tight">{fmtPct(s.progress)}</span>
                <span className="text-[12px] text-fg-2">{s.time_left != null ? `${fmtDuration(s.time_left)} left` : "estimating…"}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fg/10">
                <div
                  className={cn("h-full rounded-full transition-[width] duration-700", s.print_state === "paused" ? "bg-warn" : "bg-accent")}
                  style={{ width: `${Math.round(s.progress * 1000) / 10}%` }}
                />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
                <Stat label="ETA" value={fmtEta(s.time_left)} />
                <Stat label="Elapsed" value={fmtDuration(s.print_duration)} />
                <Stat label="Layer" value={s.total_layer != null ? `${s.current_layer ?? "–"}/${s.total_layer}` : "—"} />
              </dl>
            </>
          ) : (
            <div className="mt-auto text-[12px] text-fg-2">
              {s.print_state === "complete" ? "in " : "after "}
              {fmtDuration(s.print_duration)} · {fmtFilament(s.filament_used)} of filament
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-fg-3">{label}</dt>
      <dd className="truncate text-[12px] font-medium tabular-nums text-fg">{value}</dd>
    </div>
  );
}

function stateLabel(state: string) {
  switch (state) {
    case "printing":
      return "Printing";
    case "paused":
      return "Paused";
    case "complete":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
    case "standby":
    case "":
      return "Ready";
    default:
      return state;
  }
}

function StateBadge({ snapshot: s }: { snapshot: Snapshot }) {
  const tone =
    s.print_state === "printing" ? "ok" : s.print_state === "paused" ? "warn" : s.print_state === "error" ? "danger" : s.print_state === "complete" ? "accent" : "neutral";
  return <Badge tone={tone}>{stateLabel(s.print_state)}</Badge>;
}

function Temperatures({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const tiles = visibleTemps(printer, s);
  const cols = tiles.length === 0 ? 1 : tiles.length === 1 ? 1 : tiles.length === 2 || tiles.length === 4 ? 2 : 3;
  return (
    <div className="flex flex-col gap-2">
      {tiles.length > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {tiles.map((t) => {
            const color = tempColor(t);
            const hasTarget = t.target != null && t.target > 0;
            return (
              <Card key={t.object} className="px-3 py-2" title={t.object}>
                <div className="truncate text-[11px] font-medium text-fg-2">{tempLabel(t.object)}</div>
                <div className="flex items-baseline gap-1">
                  <span className={cn("text-[18px] font-semibold tabular-nums tracking-tight", hasTarget ? color : "")}>{fmtTemp(t.temperature)}</span>
                  {hasTarget && <span className="text-[11px] tabular-nums text-fg-3">/ {fmtTemp(t.target!)}</span>}
                  {t.kind === "temperature_fan" && t.speed != null && (
                    <span className="ml-auto text-[11px] tabular-nums text-fg-3" title="Fan speed">
                      {Math.round(t.speed * 100)}%
                    </span>
                  )}
                </div>
                {hasTarget && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-fg/10">
                    <div
                      className={cn("h-full rounded-full bg-current transition-[width] duration-500", color)}
                      style={{ width: `${Math.min(100, (t.temperature / t.target!) * 100)}%` }}
                    />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {!isBusy(s) && <Presets printer={printer} snapshot={s} />}
    </div>
  );
}

const TARGET_LABELS: Record<string, string> = { extruder: "Nozzle", heater_bed: "Bed" };

function targetLabel(object: string) {
  if (TARGET_LABELS[object]) return TARGET_LABELS[object];
  const short = object.replace(/^(heater_generic|temperature_fan|extruder)\s*/, "") || object;
  return short.toLowerCase().includes("chamber") ? "Chamber" : short;
}

/** Preheat presets read from Mainsail / Fluidd, plus a cooldown button while anything is heating. */
function Presets({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const { pending, run } = useAction(printer.id);
  const ready = s.klippy_state === "ready";
  const heating = s.extruder.target > 0 || s.bed.target > 0 || (s.chamber?.target ?? 0) > 0;
  if (s.presets.length === 0 && !heating) return null;

  // A preset is "active" when every one of its heater targets is the current
  // setpoint, and at least one of them is actually heating. Targets we cannot
  // map to a known heater (temperature fans, extra heaters) never match.
  const heaterFor = (object: string) =>
    object === "extruder" ? s.extruder : object === "heater_bed" ? s.bed : /^heater_generic .*chamber/i.test(object) ? s.chamber : null;
  const isActive = (p: (typeof s.presets)[number]) => {
    const heaters = p.targets.filter((t) => t.kind !== "temperature_fan");
    if (heaters.length === 0) return false;
    let hot = false;
    for (const t of heaters) {
      const h = heaterFor(t.object);
      if (!h || Math.abs(h.target - t.value) >= 0.5) return false;
      if (t.value > 0 && h.target > 0) hot = true;
    }
    return hot;
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Flame size={13} className="text-fg-3" />
      {s.presets.map((p) => {
        const running = pending === `preset:${p.id}`;
        const active = isActive(p);
        const tip = p.targets.map((t) => `${targetLabel(t.object)} ${Math.round(t.value)}°`).join(" · ") + (p.gcode.trim() ? " + G-code" : "");
        return (
          <button
            key={p.id}
            title={tip}
            disabled={!ready || pending != null}
            onClick={() => run("preset", p.id)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-[12px] font-medium transition disabled:opacity-50",
              active ? "bg-heat/15 text-heat" : "bg-surface-3 text-fg hover:brightness-110",
              running && "bg-accent text-accent-fg",
            )}
          >
            {running ? <Loader2 size={12} className="inline animate-spin" /> : null} {p.name}
          </button>
        );
      })}
      {heating && (
        <button
          title={s.cooldown_gcode || "TURN_OFF_HEATERS"}
          disabled={!ready || pending != null}
          onClick={() => run("cooldown")}
          className="ml-auto rounded-lg bg-surface-3 px-2.5 py-1 text-[12px] font-medium text-chamber transition hover:brightness-110 disabled:opacity-50"
        >
          {pending === "cooldown" ? <Loader2 size={12} className="inline animate-spin" /> : <Snowflake size={12} className="inline" />} Cool down
        </button>
      )}
      {s.presets.length === 0 && !heating ? null : s.presets.length === 0 ? (
        <span className="text-[11px] text-fg-3">No presets (create them in Mainsail or Fluidd)</span>
      ) : null}
    </div>
  );
}

const SPEEDS = [50, 100, 150, 200];

function Controls({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const { pending, run } = useAction(printer.id);
  const busy = isBusy(s);
  const ready = s.klippy_state === "ready";

  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        {s.print_state === "paused" ? (
          <Button variant="primary" className="flex-1" icon={<Play size={14} />} disabled={!ready || pending != null} onClick={() => run("resume")}>
            Resume
          </Button>
        ) : (
          <Button variant="primary" className="flex-1" icon={<Pause size={14} />} disabled={!busy || !ready || pending != null} onClick={() => run("pause")}>
            Pause
          </Button>
        )}
        <ConfirmButton
          label="Cancel"
          confirmLabel="Cancel print?"
          icon={<Square size={14} />}
          disabled={!busy || !ready || pending != null}
          onConfirm={() => run("cancel")}
        />
      </div>

      <div className="flex items-center gap-2 text-[12px]">
        <span className="flex items-center gap-1 text-fg-2">
          <Gauge size={13} /> Speed
        </span>
        <div className="flex flex-1 gap-1">
          {SPEEDS.map((pct) => {
            const active = Math.round(s.speed_factor * 100) === pct;
            return (
              <button
                key={pct}
                disabled={!ready || pending != null}
                onClick={() => run("speed", String(pct))}
                className={cn(
                  "flex-1 rounded-md py-1 text-[12px] font-medium tabular-nums transition disabled:opacity-40",
                  active ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg-2 hover:text-fg",
                )}
              >
                {pct}%
              </button>
            );
          })}
        </div>
        <span className="flex items-center gap-1 text-fg-3" title="Part cooling fan">
          <Fan size={13} className={cn(s.fan_speed > 0 && "animate-spin [animation-duration:2s]")} /> {Math.round(s.fan_speed * 100)}%
        </span>
      </div>
    </Card>
  );
}

/** Home, motors off and the emergency stop. Motion commands are locked while printing. */
function QuickActions({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const { pending, run } = useAction(printer.id);
  const ready = s.klippy_state === "ready";
  const busy = isBusy(s);
  const lockMotion = !ready || busy || pending != null;
  const homing = pending === "gcode:G28";
  const motorsOff = pending === "gcode:M84";
  return (
    <div className="flex items-center gap-2">
      <Button
        className="flex-1 whitespace-nowrap"
        icon={homing ? <Loader2 size={14} className="animate-spin" /> : <Home size={14} />}
        disabled={lockMotion}
        title={busy ? "Unavailable while printing" : "G28 — home all axes"}
        onClick={() => run("gcode", "G28")}
      >
        Home
      </Button>
      <Button
        className="flex-1 whitespace-nowrap"
        icon={motorsOff ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
        disabled={lockMotion}
        title={busy ? "Unavailable while printing" : "M84 — disable motors"}
        onClick={() => run("gcode", "M84")}
      >
        Motors off
      </Button>
      <ConfirmButton
        label="Stop"
        confirmLabel="Sure?"
        icon={<AlertTriangle size={14} />}
        disabled={pending === "estop"}
        onConfirm={() => run("estop")}
        className="flex-1 whitespace-nowrap bg-danger text-white hover:bg-danger hover:brightness-110"
        title="Klipper emergency stop (needs a firmware restart afterwards)"
      />
    </div>
  );
}

/** Pinned Klipper macros as buttons, with a picker to choose which ones to show. */
function Macros({ printer, snapshot: s }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const { pending, run } = useAction(printer.id);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState("");
  const ready = s.klippy_state === "ready";
  const byName = new Map(s.macros.map((m) => [m.name, m]));
  const pinned = printer.pinned_macros.filter((n) => byName.has(n));

  const toggle = async (name: string) => {
    const next = printer.pinned_macros.includes(name)
      ? printer.pinned_macros.filter((n) => n !== name)
      : [...printer.pinned_macros, name];
    try {
      await backend.setPinnedMacros(printer.id, next);
    } catch (e) {
      useStore.getState().setError(String(e));
    }
  };

  if (s.macros.length === 0) return null;

  if (editing) {
    const q = filter.trim().toLowerCase();
    const list = s.macros.filter((m) => !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
    return (
      <Card className="flex flex-col gap-2 p-2.5">
        <div className="flex items-center gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter macros…" autoFocus className="h-7" />
          <Button size="sm" variant="primary" onClick={() => setEditing(false)}>
            OK
          </Button>
        </div>
        <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
          {list.map((m) => {
            const on = printer.pinned_macros.includes(m.name);
            return (
              <button
                key={m.name}
                onClick={() => toggle(m.name)}
                className={cn(
                  "flex w-full items-center gap-2 border-b border-line px-2.5 py-1.5 text-left last:border-b-0 hover:bg-surface-3/60",
                  on && "bg-accent/8",
                )}
              >
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-accent bg-accent text-accent-fg" : "border-fg/25")}>
                  {on && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]">{m.name}</span>
                  {m.description && <span className="block truncate text-[11px] text-fg-3">{m.description}</span>}
                </span>
              </button>
            );
          })}
          {list.length === 0 && <div className="px-2.5 py-3 text-center text-[12px] text-fg-3">No macros</div>}
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-fg-2">
          <Terminal size={12} /> Macros
        </span>
        <button onClick={() => setEditing(true)} className="rounded px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-surface-3 hover:text-fg">
          {pinned.length ? "Edit" : "Choose…"}
        </button>
      </div>
      {pinned.length === 0 ? (
        <div className="text-[12px] text-fg-3">
          {s.macros.length} macro{s.macros.length > 1 ? "s" : ""} available — pick the ones to show here.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {pinned.map((name) => {
            const m = byName.get(name)!;
            const running = pending === `gcode:${name}`;
            return (
              <button
                key={name}
                title={m.description || name}
                disabled={!ready || pending != null}
                onClick={() => run("gcode", name)}
                className={cn(
                  "rounded-lg bg-surface-3 px-2.5 py-1.5 font-mono text-[12px] text-fg transition",
                  "hover:brightness-110 active:brightness-95 disabled:opacity-50",
                  running && "bg-accent text-accent-fg",
                )}
              >
                {running ? <Loader2 size={12} className="inline animate-spin" /> : null} {prettyMacro(name)}
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** PRINT_START → "Print start" for display; the real name is sent to Klipper. */
function prettyMacro(name: string) {
  const words = name.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return name;
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
}

/** Two-step button: first click arms it for 3 s, second click fires. */
function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = "danger",
  size = "md",
  icon,
  disabled,
  className,
  title,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: "danger" | "ghost";
  size?: "sm" | "md";
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      variant={armed ? "danger" : variant}
      size={size}
      icon={icon}
      disabled={disabled}
      title={title}
      className={cn(armed && "ring-2 ring-danger/40", className)}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

const SNAPSHOT_EVERY_MS = 2000;
/** No first frame after this long: the stream is stuck, open a new connection. */
const STREAM_STALL_MS = 5000;
/** Reconnections before falling back to snapshots. */
const STREAM_RETRIES = 3;
/**
 * Global, not per card: the card remounts when you switch printers or views, and a
 * per-card counter would start again at 1 and reuse a URL WebKit still holds an
 * aborted, frameless response for.
 */
let streamSessions = 0;

/**
 * An <img> playing an MJPEG stream. Removing an <img> does not close its
 * connection in WebKit / Chromium, so the src is cleared on unmount to abort it.
 */
function StreamImg({
  src,
  alt,
  style,
  onError,
  onFrame,
}: {
  src: string;
  alt: string;
  style?: CSSProperties;
  /** Failed, or no frame within STREAM_STALL_MS. */
  onError: () => void;
  /** First frame decoded. */
  onFrame: () => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const alive = useRef(true);
  useLayoutEffect(() => {
    const img = ref.current;
    alive.current = true;
    // An MJPEG response can stay open without ever sending a frame (camera busy,
    // stale connection) and no event fires: watch for the first decoded frame.
    let gotFrame = false;
    const poll = setInterval(() => {
      if (!gotFrame && img && img.naturalWidth > 0) {
        gotFrame = true;
        clearInterval(poll);
        alive.current && onFrame();
      }
    }, 250);
    const stall = setTimeout(() => {
      if (!gotFrame && alive.current) onError();
    }, STREAM_STALL_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(stall);
      // Ignore the error the aborted request is about to raise.
      alive.current = false;
      if (img) img.src = "data:,";
    };
  }, [src]);
  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      className="block h-full w-full object-cover"
      style={style}
      onError={() => alive.current && onError()}
    />
  );
}

/**
 * Live MJPEG stream when the camera offers one, else a snapshot refreshed every 2 s.
 * Nothing is downloaded while the popover is hidden.
 */
function CameraCard({ printer, snapshot }: { printer: PrinterConfig; snapshot: Snapshot }) {
  const visible = useStore((s) => s.popoverVisible);
  const source = cameraSource(printer, snapshot);
  const key = `${source?.stream ?? ""}|${source?.snapshot ?? ""}`;

  const [streamFailed, setStreamFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [tick, setTick] = useState(0);
  /** Changes every time the popover opens (or the camera changes), so the stream is a fresh request. */
  const session = useMemo(() => ++streamSessions, [key, visible, retry]);

  // New camera, or popover shown again: try the live stream first.
  useEffect(() => {
    setStreamFailed(false);
    setSnapshotFailed(false);
    setRetry(0);
    setStreaming(false);
  }, [key, visible]);

  const onStreamError = () => {
    setStreaming(false);
    if (retry + 1 < STREAM_RETRIES) setRetry((n) => n + 1);
    else setStreamFailed(true);
  };

  const live = !!source?.stream && !streamFailed;

  useEffect(() => {
    if (!visible || live || !source?.snapshot) return;
    const t = setInterval(() => setTick((n) => n + 1), snapshotFailed ? 10000 : SNAPSHOT_EVERY_MS);
    return () => clearInterval(t);
  }, [visible, live, source?.snapshot, snapshotFailed]);

  if (!source) return null;

  const imgStyle = source.transform ? { transform: source.transform } : undefined;
  const snapSrc = source.snapshot ? `${source.snapshot}${source.snapshot.includes("?") ? "&" : "?"}_t=${tick}` : null;

  return (
    <Card className="relative overflow-hidden p-0" title={source.name}>
      <div className="aspect-video w-full bg-black/40">
        {!visible ? null : live ? (
          <StreamImg
            key={`stream-${key}-${session}`}
            src={`${source.stream}${source.stream!.includes("?") ? "&" : "?"}_s=${session}`}
            alt={source.name}
            style={imgStyle}
            onError={onStreamError}
            onFrame={() => setStreaming(true)}
          />
        ) : snapSrc && !snapshotFailed ? (
          <img
            src={snapSrc}
            alt={source.name}
            className="block h-full w-full object-cover"
            style={imgStyle}
            onError={() => setSnapshotFailed(true)}
            onLoad={() => setSnapshotFailed(false)}
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-fg-3">
            <Camera size={14} /> Camera unavailable
          </div>
        )}
      </div>
      {visible && live && (
        <span className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white">
          {streaming ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-danger" /> LIVE
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/70" /> Connecting…
            </>
          )}
        </span>
      )}
    </Card>
  );
}
