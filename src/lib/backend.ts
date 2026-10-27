// Typed wrappers around the Tauri commands and events exposed by src-tauri.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Discovered,
  Layout,
  PrinterAction,
  PrinterConfig,
  PrinterInput,
  PrinterUpdate,
  Snapshot,
} from "./types";

export type CameraEvent = { type: "frame"; data: string } | { type: "error"; message: string };

export const backend = {
  /** Reads an MJPEG stream in the backend; returns the id to pass to cameraStop. */
  cameraStart: (url: string, onEvent: (e: CameraEvent) => void) => {
    const channel = new Channel<CameraEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("camera_start", { url, onEvent: channel });
  },
  cameraStop: (id: number) => invoke<void>("camera_stop", { id }),
  listPrinters: () => invoke<PrinterConfig[]>("list_printers"),
  getSnapshots: () => invoke<Record<string, Snapshot>>("get_snapshots"),
  addPrinter: (input: PrinterInput) => invoke<PrinterConfig>("add_printer", { input }),
  updatePrinter: (id: string, input: PrinterInput) =>
    invoke<PrinterConfig>("update_printer", { id, input }),
  removePrinter: (id: string) => invoke<void>("remove_printer", { id }),
  setPinnedMacros: (id: string, macros: string[]) =>
    invoke<void>("set_pinned_macros", { id, macros }),
  setShownTemps: (id: string, objects: string[]) =>
    invoke<void>("set_shown_temps", { id, objects }),
  getLayout: () => invoke<Layout>("get_layout"),
  getThumbnail: (id: string, path: string) => invoke<string>("get_thumbnail", { id, path }),
  discoverPrinters: () => invoke<Discovered[]>("discover_printers"),
  setLayout: (layout: Layout) => invoke<void>("set_layout", { layout }),
  getActivePrinter: () => invoke<string | null>("get_active_printer"),
  setActivePrinter: (id: string | null) => invoke<void>("set_active_printer", { id }),
  action: (id: string, action: PrinterAction, arg?: string) =>
    invoke<void>("printer_action", { id, action, arg: arg ?? null }),
  testConnection: (input: PrinterInput) => invoke<string>("test_connection", { input }),
  hidePopover: () => invoke<void>("hide_popover"),
  quit: () => invoke<void>("quit"),

  onPrinterUpdate: (cb: (u: PrinterUpdate) => void): Promise<UnlistenFn> =>
    listen<PrinterUpdate>("printer:update", (e) => cb(e.payload)),
  onPrintersChanged: (cb: (list: PrinterConfig[]) => void): Promise<UnlistenFn> =>
    listen<PrinterConfig[]>("printers:changed", (e) => cb(e.payload)),
  onPopoverVisibility: (cb: (visible: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>("popover:visibility", (e) => cb(e.payload)),
};
