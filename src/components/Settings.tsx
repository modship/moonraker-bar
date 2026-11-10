import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Plus, Trash2, Wifi, Check, Loader2, GripVertical, ChevronUp, ChevronDown, ChevronRight, ChevronsUpDown, Eye, EyeOff, Radar } from "lucide-react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useStore } from "@/store";
import { backend } from "@/lib/backend";
import { CARD_LABELS, resolveLayout, type CardId, type Discovered, type PrinterConfig, type PrinterInput, type Snapshot, type TrayAppearance } from "@/lib/types";
import { MODELS, MODEL_LABELS, guessModel } from "@/lib/model";
import { cn } from "@/lib/format";
import { defaultTemps, tempColor, tempLabel } from "@/lib/temps";
import { THEMES, getThemePref, setThemePref, type Theme, type ThemePref } from "@/lib/theme";
import { Button, Card, IconButton } from "./ui";

const TABS = { printers: "Printers", display: "Display", general: "General" } as const;
type Tab = keyof typeof TABS;

/** A card holding full-width rows. */
const LIST = "divide-y divide-line overflow-hidden p-0";
const LINK = "text-[11px] font-medium text-accent-text hover:underline";
const NOTE = "text-[11px] leading-[14px] text-fg-2";
/** Borderless control inside a `Row`. */
const BARE = "h-7 min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-fg-2 focus:outline-none";

export function Settings() {
  const printers = useStore((st) => st.printers);
  const editing = useStore((st) => st.editing);
  const [tab, setTab] = useState<Tab>("printers");

  if (editing != null) {
    const printer = typeof editing === "string" ? printers.find((p) => p.id === editing) : undefined;
    return <PrinterForm initial={printer ?? null} prefill={typeof editing === "string" ? undefined : editing} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" className="grid grid-cols-3 gap-0.5 rounded-[9px] bg-fg/8 p-0.5">
        {(Object.entries(TABS) as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("h-7 rounded-[7px] text-[12px] transition", tab === id ? "bg-raised font-semibold shadow-sm" : "hover:bg-fg/5")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        {tab === "printers" ? (
          <PrintersTab />
        ) : tab === "display" ? (
          <>
            <MenuBarSettings />
            <LayoutEditor />
          </>
        ) : (
          <>
            <Section title="Theme">
              <ThemePicker />
              <p className={NOTE}>System follows your computer's light or dark appearance.</p>
            </Section>
            <Section title="Startup">
              <Card className={LIST}>
                <AutostartRow />
              </Card>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex h-5 items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PrintersTab() {
  const { printers, snapshots, setEditing } = useStore();
  const [scanning, setScanning] = useState(printers.length === 0);

  return (
    <>
      <Section title="Printers">
        {printers.length > 0 ? (
          <Card className={LIST}>
            {printers.map((p) => {
              const s = snapshots[p.id];
              const online = s?.connection === "connected";
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setEditing(p.id)}
                  className="flex h-[52px] w-full items-center gap-2.5 pr-2.5 pl-3 text-left hover:bg-surface-3/60"
                >
                  {/* Filled vs hollow, so the state does not rest on colour alone. */}
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", online ? "bg-ok" : "border-[1.5px] border-fg-2")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate text-[11px] text-fg-2">
                      {p.url}
                      {s?.hostname ? ` · ${s.hostname}` : ""}
                    </span>
                  </span>
                  <span className="text-[11px] text-fg-2">{online ? "Online" : "Offline"}</span>
                  <ChevronRight size={14} className="shrink-0 text-fg-3" />
                </button>
              );
            })}
          </Card>
        ) : (
          !scanning && <Card className="py-6 text-center text-[12px] text-fg-2">No printers yet.</Card>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="text-[12px]" icon={<Radar size={13} />} onClick={() => setScanning(true)} disabled={scanning}>
            Find on network
          </Button>
          <Button variant="outline" className="text-[12px]" icon={<Plus size={13} />} onClick={() => setEditing({ name: "", url: "http://" })}>
            Add manually
          </Button>
        </div>
      </Section>
      {scanning && <NetworkScan />}
    </>
  );
}

/** Looks for Moonraker on the local network (mDNS + subnet scan) and adds printers in one click. */
function NetworkScan() {
  const printers = useStore((st) => st.printers);
  const [found, setFound] = useState<Discovered[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let alive = true;
    setFound(null);
    backend
      .discoverPrinters()
      .then((list) => alive && setFound(list))
      .catch((e) => {
        if (alive) setFound([]);
        useStore.getState().setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [run]);

  const known = (d: Discovered) =>
    printers.some((p) => {
      try {
        const h = new URL(p.url).hostname;
        return h === d.ip || h === d.hostname || h === `${d.hostname}.local` || p.url === d.url;
      } catch {
        return false;
      }
    });

  const add = async (d: Discovered) => {
    // An API key has to be typed in: open the form with the rest filled in.
    if (d.needs_api_key) return useStore.getState().setEditing({ name: prettyName(d.name), url: d.url });
    setAdding(d.url);
    try {
      await backend.addPrinter({ name: prettyName(d.name), url: d.url });
    } catch (e) {
      useStore.getState().setError(String(e));
    } finally {
      setAdding(null);
    }
  };

  return (
    <Section
      title="Found on your network"
      action={
        found !== null && (
          <button type="button" className={LINK} onClick={() => setRun((n) => n + 1)}>
            Scan again
          </button>
        )
      }
    >
      <Card className={LIST}>
        {found === null ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-fg-2">
            <Loader2 size={13} className="animate-spin text-accent" /> Looking for printers…
          </div>
        ) : found.length === 0 ? (
          <div className="px-3 py-2.5 text-[11px] leading-relaxed text-fg-2">
            Moonraker was not found on port 7125 of this network. Add it by hand with <span className="font-medium text-fg">Add manually</span>, or
            enable <code className="text-fg">[zeroconf]</code> in moonraker.conf.
          </div>
        ) : (
          found.map((d) => (
            <div key={d.url} className="flex h-[52px] items-center gap-2.5 px-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{prettyName(d.name)}</div>
                <div className="truncate text-[11px] text-fg-2">
                  {d.url}
                  {d.needs_api_key ? " · needs an API key" : ""}
                </div>
              </div>
              {known(d) ? (
                <span className="flex items-center gap-1 text-[11px] text-fg-2">
                  <Check size={12} /> Added
                </span>
              ) : (
                <Button size="sm" variant={d.needs_api_key ? "outline" : "primary"} disabled={adding != null} onClick={() => add(d)}>
                  {adding === d.url ? <Loader2 size={12} className="animate-spin" /> : null}
                  {d.needs_api_key ? "Set up…" : "Add"}
                </Button>
              )}
            </div>
          ))
        )}
      </Card>
    </Section>
  );
}

/** "voron" -> "Voron", "Voron-24" stays as is. */
function prettyName(name: string) {
  return name && name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** One labelled line of a grouped form. `hint` is shown as a tooltip. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label title={hint} className="flex h-10 items-center gap-2 px-3 focus-within:bg-accent/10">
      <span className="w-[100px] shrink-0 text-[12px] text-fg-2">{label}</span>
      {children}
    </label>
  );
}

/** Add or edit a printer. The header (back, name, status) is drawn by App from `store.editing`. */
function PrinterForm({ initial, prefill }: { initial: PrinterConfig | null; prefill?: PrinterInput }) {
  const snapshot = useStore((st) => (initial ? st.snapshots[initial.id] : undefined));
  const [form, setForm] = useState<PrinterInput>({
    name: initial?.name ?? prefill?.name ?? "",
    url: initial?.url ?? prefill?.url ?? "http://",
    api_key: initial?.api_key ?? "",
    camera_url: initial?.camera_url ?? "",
    web_url: initial?.web_url ?? "",
    model: initial?.model ?? "auto",
  });
  const detected = initial && snapshot ? guessModel(initial, snapshot) : null;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const done = () => useStore.getState().setEditing(null);

  const set = (k: keyof PrinterInput) => (e: ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setTestResult(null);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const text = await backend.testConnection(form);
      setTestResult({ ok: true, text });
    } catch (e) {
      setTestResult({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (initial) await backend.updatePrinter(initial.id, form);
      else await backend.addPrinter(form);
      done();
    } catch (err) {
      useStore.getState().setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Section title="Printer">
        <Card className={LIST}>
          <Row label="Name">
            <input className={BARE} value={form.name} onChange={set("name")} placeholder="Voron 2.4" autoFocus />
          </Row>
          <Row label="Model" hint="Picks the printer drawn in the panel.">
            <select
              value={form.model ?? "auto"}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              className={cn(BARE, "appearance-none")}
            >
              <option value="auto">Auto{detected ? ` (${MODEL_LABELS[detected]})` : ""}</option>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m]}
                </option>
              ))}
            </select>
            <ChevronsUpDown size={13} className="pointer-events-none shrink-0 text-fg-3" />
          </Row>
        </Card>
      </Section>

      <Section title="Connection">
        <Card className={LIST}>
          <Row label="Moonraker URL" hint="http://printer.local:7125 — or the Mainsail/Fluidd URL when Moonraker sits behind nginx.">
            <input className={BARE} value={form.url} onChange={set("url")} placeholder="http://voron.local:7125" required spellCheck={false} />
          </Row>
          <Row label="API key" hint="Optional unless authentication is enabled in Moonraker.">
            <input className={BARE} value={form.api_key ?? ""} onChange={set("api_key")} placeholder="Optional" spellCheck={false} />
          </Row>
        </Card>
        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            icon={testing ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
            disabled={testing}
            onClick={test}
          >
            Test connection
          </Button>
          {testResult && (
            <span className={cn("flex min-w-0 items-center gap-1 text-[12px] leading-4 font-medium", testResult.ok ? "text-ok-text" : "text-danger-text")}>
              {testResult.ok && <Check size={13} strokeWidth={2.5} className="shrink-0" />}
              {testResult.text}
            </span>
          )}
        </div>
      </Section>

      <Section title="Web UI & camera">
        <Card className={LIST}>
          <Row label="Web UI" hint="Mainsail or Fluidd. Empty = the Moonraker host without its port.">
            <input className={BARE} value={form.web_url ?? ""} onChange={set("web_url")} placeholder="http://voron.local" spellCheck={false} />
          </Row>
          <Row label="Camera URL" hint="Stream or snapshot URL, absolute or relative to the web UI.">
            <input className={BARE} value={form.camera_url ?? ""} onChange={set("camera_url")} placeholder="Automatic" spellCheck={false} />
          </Row>
        </Card>
        <p className={NOTE}>Leave empty to use the Moonraker host and the webcam set up in Mainsail / Fluidd.</p>
      </Section>

      {initial && <TempPicker printer={initial} snapshot={snapshot} />}

      {/* Pinned to the bottom edge of the popover: the negative margins and offset cancel <main>'s padding. */}
      <div className="sticky -bottom-3 -mx-3 -mb-3 flex items-center gap-2 border-t border-line bg-surface px-3 py-2.5">
        {initial && <RemoveButton id={initial.id} />}
        <div className="flex-1" />
        <Button type="button" size="sm" variant="outline" onClick={done}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={saving}>
          {initial ? "Save" : "Add"}
        </Button>
      </div>
    </form>
  );
}

/** Two clicks to remove: the first one arms the button for 3 s. */
function RemoveButton({ id }: { id: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("text-danger-text hover:bg-danger/10 hover:text-danger-text", armed && "bg-danger/15")}
      icon={armed ? <Check size={13} /> : <Trash2 size={13} />}
      onClick={async () => {
        if (!armed) return setArmed(true);
        useStore.getState().setEditing(null);
        try {
          await backend.removePrinter(id);
        } catch (e) {
          useStore.getState().setError(String(e));
        }
      }}
    >
      {armed ? "Confirm" : "Remove"}
    </Button>
  );
}

/** Checklist of every heater / sensor / temperature fan Klipper reports for this printer. */
function TempPicker({ printer, snapshot }: { printer: PrinterConfig; snapshot: Snapshot | undefined }) {
  const all = snapshot?.temperatures ?? [];
  const chosen = printer.shown_temps.length ? printer.shown_temps : defaultTemps(all);
  const isDefault = printer.shown_temps.length === 0;

  const save = (objects: string[]) => backend.setShownTemps(printer.id, objects).catch((e) => useStore.getState().setError(String(e)));

  const toggle = (object: string) => {
    const next = chosen.includes(object) ? chosen.filter((o) => o !== object) : [...chosen, object];
    // Keep the printer's discovery order so tiles don't jump around.
    save(all.map((t) => t.object).filter((o) => next.includes(o)));
  };

  return (
    <Section
      title="Temperature tiles"
      action={
        !isDefault && (
          <button type="button" className={LINK} onClick={() => save([])}>
            Reset to default
          </button>
        )
      }
    >
      <Card className="p-2.5">
        {all.length === 0 ? (
          <div className="text-[12px] text-fg-2">
            {snapshot?.connection === "connected" ? "No sensors found." : "Connect the printer to list its sensors."}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {all.map((t) => {
              const on = chosen.includes(t.object);
              return (
                <button
                  key={t.object}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.object)}
                  title={t.object}
                  className={cn(
                    "flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border px-2 text-[12px] transition",
                    on ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-fg-2 hover:text-fg",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded",
                      on ? "bg-accent text-accent-fg" : "border-[1.5px] border-fg-2",
                    )}
                  >
                    {on && <Check size={10} strokeWidth={3.5} />}
                  </span>
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-current", tempColor(t))} />
                  <span className="min-w-0 flex-1 truncate text-left">{tempLabel(t.object)}</span>
                  <span className="tabular-nums">{Math.round(t.temperature)}°</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </Section>
  );
}

function MenuBarSettings() {
  const [appearance, setAppearance] = useState<TrayAppearance | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let alive = true;
    backend.getTrayAppearance()
      .then((value) => { if (alive) setAppearance(value); })
      .catch((e) => { if (alive) useStore.getState().setError(String(e)); });
    return () => { alive = false; };
  }, []);

  const toggle = async (key: keyof TrayAppearance) => {
    if (!appearance || pending) return;
    const next = { ...appearance, [key]: !appearance[key] };
    setPending(true);
    try {
      await backend.setTrayAppearance(next);
      setAppearance(next);
    } catch (e) {
      useStore.getState().setError(String(e));
    } finally {
      setPending(false);
    }
  };

  // What the tray shows mid-print with these settings, on a made-up job at 64 %.
  const sample = [appearance?.show_percent && "64%", appearance?.show_time_left && "1h02"].filter(Boolean).join(" · ");

  return (
    <Section title="Menu bar">
      <Card className={LIST}>
        <div className="flex h-12 items-center justify-between px-3">
          <span className="text-[12px] text-fg-2">Preview</span>
          <span className="flex h-6 items-center gap-1.5 rounded-md bg-surface-3 px-2 text-[12px] font-medium tabular-nums">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="8" cy="8" r="6" opacity="0.25" />
              {/* 64 % of the 37.7 circumference */}
              <circle cx="8" cy="8" r="6" strokeLinecap="round" strokeDasharray="24.1 37.7" transform="rotate(-90 8 8)" />
            </svg>
            {sample}
          </span>
        </div>
        {([
          ["show_percent", "Show percentage"],
          ["show_time_left", "Show time remaining"],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" role="switch" aria-checked={appearance?.[key] ?? false}
            disabled={!appearance || pending} onClick={() => toggle(key)}
            className="flex h-10 w-full items-center justify-between px-3 text-left hover:bg-surface-3/60 disabled:opacity-50">
            <span className="font-medium">{label}</span>
            <Toggle on={appearance?.[key] ?? false} />
          </button>
        ))}
      </Card>
      <p className={NOTE}>The progress ring is always visible.</p>
    </Section>
  );
}

/** Reorder the panel's cards (drag, or arrows) and hide the ones you don't need. */
function LayoutEditor() {
  const { layout, saveLayout } = useStore();
  const { order, hidden } = resolveLayout(layout);
  const [dragging, setDragging] = useState<CardId | null>(null);
  const [over, setOver] = useState<CardId | null>(null);

  const commit = (nextOrder: CardId[], nextHidden: Set<CardId>) =>
    saveLayout({ order: nextOrder, hidden: [...nextHidden] }).catch((e) => useStore.getState().setError(String(e)));

  const move = (id: CardId, to: number) => {
    const next = order.filter((c) => c !== id);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
    commit(next, hidden);
  };

  const toggle = (id: CardId) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit(order, next);
  };

  const isDefault = layout.order.length === 0 && layout.hidden.length === 0;

  return (
    <Section
      title="Panel cards"
      action={
        !isDefault && (
          <button type="button" className={LINK} onClick={() => commit([], new Set())}>
            Reset to default
          </button>
        )
      }
    >
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-line">
          {order.map((id, i) => {
            const off = hidden.has(id);
            return (
              <li
                key={id}
                draggable
                onDragStart={(e) => {
                  setDragging(id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (over !== id) setOver(id);
                }}
                onDragLeave={() => setOver((o) => (o === id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== id) move(dragging, order.indexOf(id));
                  setDragging(null);
                  setOver(null);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                className={cn(
                  "flex h-9 items-center gap-0.5 pr-1.5 pl-2 transition",
                  dragging === id && "opacity-40",
                  over === id && dragging !== id && "bg-accent/10",
                )}
              >
                <GripVertical size={14} className="mr-1.5 shrink-0 cursor-grab text-fg-3" aria-hidden="true" />
                <span className={cn("min-w-0 flex-1 truncate text-[13px]", off && "text-fg-2 line-through")}>{CARD_LABELS[id]}</span>
                <IconButton title="Move up" disabled={i === 0} onClick={() => move(id, i - 1)} className="h-6 w-6">
                  <ChevronUp size={13} />
                </IconButton>
                <IconButton title="Move down" disabled={i === order.length - 1} onClick={() => move(id, i + 1)} className="h-6 w-6">
                  <ChevronDown size={13} />
                </IconButton>
                <IconButton title={off ? "Show" : "Hide"} onClick={() => toggle(id)} className="h-6 w-6">
                  {off ? <EyeOff size={13} /> : <Eye size={13} />}
                </IconButton>
              </li>
            );
          })}
        </ul>
      </Card>
      <p className={NOTE}>Drag to reorder. Hidden cards stay out of the panel.</p>
    </Section>
  );
}

/** Picker entries: the preference, its label, and the theme(s) drawn in its thumbnail. */
const THEME_OPTIONS: [ThemePref, string, Theme[]][] = [
  ["system", "System", ["light", "dark"]],
  ...(Object.keys(THEMES) as Theme[]).map((t): [ThemePref, string, Theme[]] => [t, THEMES[t].label, [t]]),
];

function ThemePicker() {
  const [pref, setPref] = useState(getThemePref);
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
      {THEME_OPTIONS.map(([id, label, previews]) => {
        const on = pref === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              setThemePref(id);
              setPref(id);
            }}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <span className={cn("flex h-16 w-full overflow-hidden rounded-lg border border-line", on && "ring-2 ring-accent")}>
              {previews.map((t) => (
                <ThemePreview key={t} theme={t} />
              ))}
            </span>
            <span className={cn("flex h-4 items-center justify-center gap-1 text-[12px]", on && "font-semibold")}>
              {on && (
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-accent-fg">
                  <Check size={9} strokeWidth={3.5} />
                </span>
              )}
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A miniature popover in the given theme's colours. */
function ThemePreview({ theme }: { theme: Theme }) {
  const [surface, card, fg] = THEMES[theme].preview;
  const box = { background: card, borderColor: `color-mix(in srgb, ${fg} 12%, transparent)` };
  return (
    <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-[5px] px-2 py-[7px]" style={{ background: surface }}>
      <span className="h-1 w-1/3 rounded-full opacity-55" style={{ background: fg }} />
      <span className="flex h-5 items-center gap-1 rounded border px-1" style={box}>
        <span className="h-2 w-2 shrink-0 rounded-full border-2 border-accent" />
        <span className="h-[3px] w-1/2 rounded-full opacity-30" style={{ background: fg }} />
      </span>
      <span className="flex h-3.5 items-center rounded border px-1" style={box}>
        <span className="h-[3px] w-2/3 rounded-full opacity-30" style={{ background: fg }} />
      </span>
    </span>
  );
}

function AutostartRow() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    isEnabled().then(setEnabled).catch(() => setEnabled(false));
  }, []);
  const toggle = async () => {
    if (enabled == null) return;
    try {
      if (enabled) await disable();
      else await enable();
      setEnabled(!enabled);
    } catch (e) {
      useStore.getState().setError(String(e));
    }
  };
  return (
    <button type="button" role="switch" aria-checked={enabled === true} onClick={toggle} className="flex h-[52px] w-full items-center justify-between gap-2.5 px-3 text-left hover:bg-surface-3/60">
      <div>
        <div className="font-medium">Launch at login</div>
        <div className="text-[11px] text-fg-2">Starts quietly in the menu bar.</div>
      </div>
      <Toggle on={enabled === true} />
    </button>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={cn("relative inline-block h-5 w-8 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-fg/20")}>
      <span className={cn("absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition", on && "translate-x-3")} />
    </span>
  );
}
