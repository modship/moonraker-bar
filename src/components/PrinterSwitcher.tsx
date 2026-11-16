import { ChevronDown, Pin } from "lucide-react";
import { useStore } from "@/store";
import { EMPTY_SNAPSHOT, isBusy } from "@/lib/types";
import { cn } from "@/lib/format";

/** Printer name in the header; a <select> when several are configured, plus a pin toggle. */
export function PrinterSwitcher() {
  const { printers, snapshots, selectedId, activeId, select, pin } = useStore();
  const current = printers.find((p) => p.id === selectedId);
  const snap = current ? (snapshots[current.id] ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT;

  const dot =
    snap.connection !== "connected"
      ? "bg-fg-3"
      : snap.print_state === "error" || snap.klippy_state === "shutdown"
        ? "bg-danger"
        : isBusy(snap)
          ? snap.print_state === "paused"
            ? "bg-warn"
            : "bg-ok"
          : "bg-fg-3";

  if (printers.length === 0) {
    return <div className="flex-1 text-[15px] font-semibold tracking-tight">Moonraker Bar</div>;
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dot, snap.connection === "connecting" && "pulse-soft")} />
      {printers.length > 1 ? (
        <div className="relative min-w-0">
          <select
            value={selectedId ?? ""}
            onChange={(e) => select(e.target.value)}
            className="w-full cursor-pointer appearance-none truncate bg-transparent pr-5 text-[15px] font-semibold tracking-tight text-fg focus:outline-none"
          >
            {printers.map((p) => {
              const s = snapshots[p.id] ?? EMPTY_SNAPSHOT;
              const suffix = isBusy(s) ? ` · ${Math.round(s.progress * 100)}%` : s.connection !== "connected" ? " · offline" : "";
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {suffix}
                </option>
              );
            })}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 text-fg-3" />
        </div>
      ) : (
        <div className="truncate text-[15px] font-semibold tracking-tight">{current?.name}</div>
      )}
      {printers.length > 1 && current && (
        <button
          title={activeId === current.id ? "Menu bar follows the active printer automatically" : "Pin this printer to the menu bar"}
          onClick={() => pin(activeId === current.id ? null : current.id)}
          className={cn(
            "ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition",
            activeId === current.id ? "bg-accent/15 text-accent" : "text-fg-3 hover:bg-surface-3 hover:text-fg",
          )}
        >
          <Pin size={12} />
        </button>
      )}
    </div>
  );
}
