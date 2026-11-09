import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Plus, Trash2, Pencil, Wifi, Check, Loader2, GripVertical, ChevronUp, ChevronDown, Eye, EyeOff, Radar, X } from "lucide-react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useStore } from "@/store";
import { backend } from "@/lib/backend";
import { CARD_LABELS, resolveLayout, type CardId, type Discovered, type PrinterConfig, type PrinterInput, type Snapshot, type TrayAppearance } from "@/lib/types";
import { MODELS, MODEL_LABELS, guessModel } from "@/lib/model";
import { cn } from "@/lib/format";
import { defaultTemps, tempColor, tempLabel } from "@/lib/temps";
import { Button, Card, Field, IconButton, Input } from "./ui";

type Editing = PrinterConfig | "new" | { prefill: PrinterInput } | null;

export function Settings() {
  const { printers, snapshots } = useStore();
  const [editing, setEditing] = useState<Editing>(null);
  const [scanning, setScanning] = useState(printers.length === 0);

  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-fg-2">Printers</h2>
          {editing === null && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" icon={<Radar size={13} />} onClick={() => setScanning(true)} disabled={scanning}>
                Find
              </Button>
              <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setEditing("new")}>
                Add
              </Button>
            </div>
          )}
        </div>

        {editing === null && scanning && (
          <NetworkScan
            onClose={() => setScanning(false)}
            onManual={(prefill) => {
              setScanning(false);
              setEditing({ prefill });
            }}
          />
        )}

        {editing !== null ? (
          <PrinterForm
            initial={editing === "new" || "prefill" in editing ? null : editing}
            prefill={editing !== "new" && "prefill" in editing ? editing.prefill : undefined}
            onDone={() => setEditing(null)}
          />
        ) : printers.length === 0 ? (
          scanning ? null : <Card className="py-6 text-center text-[12px] text-fg-3">No printers yet.</Card>
        ) : (
          <Card className="divide-y divide-line p-0">
            {printers.map((p) => {
              const s = snapshots[p.id];
              const online = s?.connection === "connected";
              return (
                <div key={p.id} className="flex items-center gap-2.5 px-3 py-2">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", online ? "bg-ok" : "bg-fg-3")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="truncate text-[11px] text-fg-3">
                      {p.url}
                      {s?.hostname ? ` · ${s.hostname}` : ""}
                    </div>
                  </div>
                  <IconButton title="Edit" onClick={() => setEditing(p)}>
                    <Pencil size={13} />
                  </IconButton>
                  <DeleteButton id={p.id} />
                </div>
              );
            })}
          </Card>
        )}
      </section>

      {printers.length > 0 && editing === null && (
        <section>
          <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-2">Temperature tiles</h2>
          <div className="flex flex-col gap-2">
            {printers.map((p) => (
              <TempPicker key={p.id} printer={p} snapshot={snapshots[p.id]} />
            ))}
          </div>
        </section>
      )}

      {editing === null && (
        <section>
          <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-2">Layout</h2>
          <LayoutEditor />
        </section>
      )}

      <section>
        <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-2">Menu bar</h2>
        <MenuBarSettings />
      </section>

      <section>
        <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-2">General</h2>
        <Card className="p-0">
          <AutostartRow />
        </Card>
      </section>
    </div>
  );
}

function DeleteButton({ id }: { id: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <IconButton
      title={armed ? "Confirm removal" : "Remove"}
      className={cn(armed && "bg-danger/15 text-danger hover:bg-danger/25 hover:text-danger")}
      onClick={async () => {
        if (!armed) return setArmed(true);
        try {
          await backend.removePrinter(id);
        } catch (e) {
          useStore.getState().setError(String(e));
        }
      }}
    >
      {armed ? <Check size={13} /> : <Trash2 size={13} />}
    </IconButton>
  );
}

function PrinterForm({ initial, prefill, onDone }: { initial: PrinterConfig | null; prefill?: PrinterInput; onDone: () => void }) {
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
      onDone();
    } catch (err) {
      useStore.getState().setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-2.5">
        <Field label="Name">
          <Input value={form.name} onChange={set("name")} placeholder="Voron 2.4" autoFocus />
        </Field>
        <Field label="Moonraker URL" hint="http://printer.local:7125 — or the Mainsail/Fluidd URL when Moonraker sits behind nginx.">
          <Input value={form.url} onChange={set("url")} placeholder="http://voron.local:7125" required spellCheck={false} />
        </Field>
        <Field label="API key" hint="Optional unless authentication is enabled in Moonraker.">
          <Input value={form.api_key ?? ""} onChange={set("api_key")} placeholder="—" spellCheck={false} />
        </Field>
        <Field label="Web UI" hint="Mainsail or Fluidd. Empty = the Moonraker host without its port.">
          <Input value={form.web_url ?? ""} onChange={set("web_url")} placeholder="http://voron.local" spellCheck={false} />
        </Field>
        <Field label="Model" hint="Picks the printer drawn in the panel.">
          <select
            value={form.model ?? "auto"}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            className="h-8 w-full rounded-lg border border-line bg-surface-2 px-2 text-[13px] text-fg focus:border-accent focus:outline-none"
          >
            <option value="auto">Auto{detected ? ` (${MODEL_LABELS[detected]})` : ""}</option>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Camera URL" hint="Optional: the webcam set up in Mainsail / Fluidd is used automatically. Stream or snapshot URL, absolute or relative to the web UI.">
          <Input value={form.camera_url ?? ""} onChange={set("camera_url")} placeholder="auto" spellCheck={false} />
        </Field>

        {testResult && (
          <div className={cn("rounded-lg px-2.5 py-1.5 text-[12px]", testResult.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger")}>
            {testResult.text}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" icon={testing ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />} disabled={testing} onClick={test}>
            Test
          </Button>
          <div className="flex-1" />
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={saving}>
            {initial ? "Save" : "Add"}
          </Button>
        </div>
      </form>
    </Card>
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
    <Card className="p-0">
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
                "flex items-center gap-2 px-2.5 py-1.5 transition",
                dragging === id && "opacity-40",
                over === id && dragging !== id && "bg-accent/10",
              )}
            >
              <GripVertical size={14} className="shrink-0 cursor-grab text-fg-3" aria-hidden="true" />
              <span className={cn("flex-1 text-[13px]", off && "text-fg-3 line-through")}>{CARD_LABELS[id]}</span>
              <IconButton title="Move up" disabled={i === 0} onClick={() => move(id, i - 1)} className="h-6 w-6">
                <ChevronUp size={13} />
              </IconButton>
              <IconButton title="Move down" disabled={i === order.length - 1} onClick={() => move(id, i + 1)} className="h-6 w-6">
                <ChevronDown size={13} />
              </IconButton>
              <IconButton title={off ? "Show" : "Hide"} onClick={() => toggle(id)} className={cn("h-6 w-6", off && "text-fg-3")}>
                {off ? <EyeOff size={13} /> : <Eye size={13} />}
              </IconButton>
            </li>
          );
        })}
      </ul>
      {!isDefault && (
        <div className="border-t border-line px-2.5 py-1.5 text-right">
          <button onClick={() => commit([], new Set())} className="text-[11px] text-fg-3 hover:text-fg">
            Reset to default
          </button>
        </div>
      )}
    </Card>
  );
}

/** Per-printer checklist of every heater / sensor / temperature fan Klipper reports. */
function TempPicker({ printer, snapshot }: { printer: PrinterConfig; snapshot: Snapshot | undefined }) {
  const all = snapshot?.temperatures ?? [];
  const chosen = printer.shown_temps.length ? printer.shown_temps : defaultTemps(all);
  const isDefault = printer.shown_temps.length === 0;

  const toggle = async (object: string) => {
    const next = chosen.includes(object) ? chosen.filter((o) => o !== object) : [...chosen, object];
    // Keep the printer's discovery order so tiles don't jump around.
    const ordered = all.map((t) => t.object).filter((o) => next.includes(o));
    try {
      await backend.setShownTemps(printer.id, ordered);
    } catch (e) {
      useStore.getState().setError(String(e));
    }
  };

  const reset = async () => {
    try {
      await backend.setShownTemps(printer.id, []);
    } catch (e) {
      useStore.getState().setError(String(e));
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-2.5">
      <div className="flex items-center justify-between">
        <span className="truncate font-medium">{printer.name}</span>
        {!isDefault && (
          <button onClick={reset} className="text-[11px] text-fg-3 hover:text-fg">
            Default
          </button>
        )}
      </div>
      {all.length === 0 ? (
        <div className="text-[12px] text-fg-3">
          {snapshot?.connection === "connected" ? "No sensors found." : "Connect the printer to list its sensors."}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {all.map((t) => {
            const on = chosen.includes(t.object);
            return (
              <button
                key={t.object}
                onClick={() => toggle(t.object)}
                title={`${t.object} · ${Math.round(t.temperature)}°`}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] transition",
                  on ? "border-accent/60 bg-accent/10 text-fg" : "border-line bg-surface-3/40 text-fg-2 hover:text-fg",
                )}
              >
                <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded border", on ? "border-accent bg-accent text-accent-fg" : "border-fg/25")}>
                  {on && <Check size={10} />}
                </span>
                <span className={cn("h-1.5 w-1.5 rounded-full bg-current", tempColor(t))} />
                {tempLabel(t.object)}
                <span className="tabular-nums text-fg-3">{Math.round(t.temperature)}°</span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Looks for Moonraker on the local network (mDNS + subnet scan) and adds printers in one click. */
function NetworkScan({ onClose, onManual }: { onClose: () => void; onManual: (prefill: PrinterInput) => void }) {
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
    if (d.needs_api_key) return onManual({ name: d.name, url: d.url });
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
    <Card className="mb-2 p-0">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium">
          {found === null ? <Loader2 size={13} className="animate-spin text-accent" /> : <Radar size={13} className="text-accent" />}
          {found === null ? "Looking for printers…" : found.length ? `${found.length} found on your network` : "No printer found"}
        </span>
        <div className="flex gap-1">
          {found !== null && (
            <button onClick={() => setRun((n) => n + 1)} className="rounded px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-surface-3 hover:text-fg">
              Again
            </button>
          )}
          <IconButton title="Close" onClick={onClose} className="h-6 w-6">
            <X size={13} />
          </IconButton>
        </div>
      </div>
      {found?.map((d) => {
        const already = known(d);
        return (
          <div key={d.url} className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{prettyName(d.name)}</div>
              <div className="truncate text-[11px] text-fg-3">
                {d.url}
                {d.needs_api_key ? " · needs an API key" : ""}
              </div>
            </div>
            {already ? (
              <span className="flex items-center gap-1 text-[11px] text-fg-3">
                <Check size={12} /> Added
              </span>
            ) : (
              <Button size="sm" variant="primary" disabled={adding != null} onClick={() => add(d)}>
                {adding === d.url ? <Loader2 size={12} className="animate-spin" /> : null}
                Add
              </Button>
            )}
          </div>
        );
      })}
      {found !== null && found.length === 0 && (
        <div className="px-3 py-2.5 text-[11px] leading-relaxed text-fg-3">
          Moonraker was not found on port 7125 of this network. Add it by hand with <span className="text-fg-2">Add</span>, or enable{" "}
          <code className="text-fg-2">[zeroconf]</code> in moonraker.conf.
        </div>
      )}
    </Card>
  );
}

/** "voron" -> "Voron", "Voron-24" stays as is. */
function prettyName(name: string) {
  return name && name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
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

  return (
    <Card className="divide-y divide-line p-0">
      <div className="px-3 py-2 text-[11px] text-fg-3">The progress ring is always visible.</div>
      {([
        ["show_percent", "Show percentage"],
        ["show_time_left", "Show time remaining"],
      ] as const).map(([key, label]) => (
        <button key={key} type="button" role="switch" aria-checked={appearance?.[key] ?? false}
          disabled={!appearance || pending} onClick={() => toggle(key)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-3/60 disabled:opacity-50">
          <span className="font-medium">{label}</span>
          <Toggle on={appearance?.[key] ?? false} />
        </button>
      ))}
    </Card>
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
    <button type="button" onClick={toggle} className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-3/60">
      <div>
        <div className="font-medium">Launch at login</div>
        <div className="text-[11px] text-fg-3">Starts quietly in the menu bar.</div>
      </div>
      <Toggle on={enabled === true} />
    </button>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={cn("relative inline-block h-5 w-8 rounded-full transition", on ? "bg-accent" : "bg-fg/20")}>
      <span className={cn("absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition", on && "translate-x-3")} />
    </span>
  );
}
