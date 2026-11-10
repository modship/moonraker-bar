import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { backend } from "./lib/backend";
import { EMPTY_SNAPSHOT, type Layout, type PrinterConfig, type PrinterInput, type Snapshot, isBusy } from "./lib/types";

export type View = "panel" | "fleet" | "settings";
/** Printer form open in Settings: a printer id (edit), or the starting values of a new printer. */
export type Editing = string | PrinterInput | null;

interface State {
  ready: boolean;
  printers: PrinterConfig[];
  snapshots: Record<string, Snapshot>;
  /** Printer pinned by the user for the tray + panel. `null` = automatic. */
  activeId: string | null;
  /** Printer currently shown in the panel (follows activeId, else the busy one). */
  selectedId: string | null;
  view: View;
  editing: Editing;
  error: string | null;
  layout: Layout;
  /** False while the popover is hidden; the camera stream is closed then. */
  popoverVisible: boolean;

  init: () => Promise<void>;
  saveLayout: (layout: Layout) => Promise<void>;
  select: (id: string) => void;
  pin: (id: string | null) => Promise<void>;
  setView: (v: View) => void;
  setEditing: (e: Editing) => void;
  setError: (e: string | null) => void;
}

let unlisten: Array<() => void> = [];

export const useStore = create<State>((set, get) => ({
  ready: false,
  printers: [],
  snapshots: {},
  activeId: null,
  selectedId: null,
  view: "panel",
  editing: null,
  error: null,
  layout: { order: [], hidden: [] },
  popoverVisible: true,

  saveLayout: async (layout) => {
    set({ layout });
    await backend.setLayout(layout);
  },

  init: async () => {
    unlisten.forEach((u) => u());
    unlisten = [];

    const [printers, snapshots, activeId, layout] = await Promise.all([
      backend.listPrinters(),
      backend.getSnapshots(),
      backend.getActivePrinter(),
      backend.getLayout().catch(() => ({ order: [], hidden: [] })),
    ]);
    set({ printers, snapshots, activeId, layout, ready: true, view: printers.length ? "panel" : "settings" });
    set({ selectedId: pickSelected(get()) });

    unlisten.push(
      await backend.onPopoverVisibility((popoverVisible) => set({ popoverVisible })),
      await backend.onPrinterUpdate(({ id, snapshot }) => {
        set((s) => ({ snapshots: { ...s.snapshots, [id]: snapshot } }));
        const st = get();
        if (st.selectedId == null || !st.printers.some((p) => p.id === st.selectedId)) {
          set({ selectedId: pickSelected(st) });
        }
      }),
      await backend.onPrintersChanged((printers) => {
        set({ printers });
        const st = get();
        if (!printers.some((p) => p.id === st.selectedId)) {
          set({ selectedId: pickSelected(st) });
        }
      }),
    );
  },

  select: (id) => set({ selectedId: id, view: "panel" }),

  pin: async (id) => {
    await backend.setActivePrinter(id);
    set({ activeId: id, selectedId: id ?? pickSelected(get()) });
  },

  setView: (view) => set({ view, editing: null }),
  setEditing: (editing) => set({ editing }),
  setError: (error) => set({ error }),
}));

function pickSelected(s: Pick<State, "printers" | "snapshots" | "activeId">): string | null {
  if (s.activeId && s.printers.some((p) => p.id === s.activeId)) return s.activeId;
  const busy = s.printers.find((p) => isBusy(s.snapshots[p.id] ?? EMPTY_SNAPSHOT));
  return busy?.id ?? s.printers[0]?.id ?? null;
}

export const useSelectedPrinter = () =>
  useStore(
    useShallow((s) => {
      const printer = s.printers.find((p) => p.id === s.selectedId) ?? null;
      const snapshot = printer ? (s.snapshots[printer.id] ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT;
      return { printer, snapshot };
    }),
  );
