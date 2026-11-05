// Mirrors src-tauri/src/moonraker/model.rs

export interface PrinterConfig {
  id: string;
  name: string;
  url: string;
  api_key?: string;
  camera_url?: string;
  web_url?: string;
  pinned_macros: string[];
  shown_temps: string[];
  model?: string;
}

export interface Machine {
  kinematics: string;
  x_max: number;
  y_max: number;
  z_max: number;
  leveling: string;
}

export interface Discovered {
  name: string;
  url: string;
  hostname: string;
  ip: string;
  source: string;
  needs_api_key: boolean;
}

/** Panel cards, in their default order. */
export const CARD_IDS = ["job", "temps", "controls", "afc", "macros", "camera", "actions"] as const;
export type CardId = (typeof CARD_IDS)[number];

export const CARD_LABELS: Record<CardId, string> = {
  job: "Job",
  temps: "Temperatures & presets",
  controls: "Print controls",
  afc: "AFC",
  macros: "Macros",
  camera: "Camera",
  actions: "Quick actions",
};

export interface TrayAppearance {
  show_percent: boolean;
  show_time_left: boolean;
}

export interface Layout {
  order: string[];
  hidden: string[];
}

/** Effective card order: saved order first, then any card it doesn't know about. */
export function resolveLayout(layout: Layout): { order: CardId[]; hidden: Set<CardId> } {
  const known = new Set<string>(CARD_IDS);
  const order = layout.order.filter((c): c is CardId => known.has(c));
  for (const c of CARD_IDS) if (!order.includes(c)) order.push(c);
  return { order, hidden: new Set(layout.hidden.filter((c): c is CardId => known.has(c))) };
}

export interface Webcam {
  name: string;
  enabled: boolean;
  service: string;
  stream_url: string;
  snapshot_url: string;
  flip_horizontal: boolean;
  flip_vertical: boolean;
  rotation: number;
}

export type TempKind = "extruder" | "heater_bed" | "heater_generic" | "temperature_sensor" | "temperature_fan";

export interface TempReading {
  object: string;
  kind: TempKind;
  temperature: number;
  target: number | null;
  power: number | null;
  speed: number | null;
}

export interface MacroInfo {
  name: string;
  description: string;
}

export interface PresetTarget {
  object: string;
  kind: "heater" | "temperature_fan";
  value: number;
}

export interface Preset {
  id: string;
  name: string;
  source: "mainsail" | "fluidd";
  targets: PresetTarget[];
  gcode: string;
}

export interface PrinterInput {
  name: string;
  url: string;
  api_key?: string;
  camera_url?: string;
  web_url?: string;
  model?: string;
}

export type ConnectionState = "offline" | "connecting" | "connected";

export type PrintState =
  | ""
  | "standby"
  | "printing"
  | "paused"
  | "complete"
  | "cancelled"
  | "error";

export interface AfcLane {
  object: string;
  name: string;
  unit: string;
  hub: string;
  extruder: string;
  index: number;
  map: string;
  load: boolean;
  prep: boolean;
  tool_loaded: boolean;
  loaded_to_hub: boolean;
  material: string;
  color: string;
  filament_name: string;
  weight: number;
  spool_id: number | null;
  filament_status: "In Tool" | "Ready" | "Prep" | "Not Ready" | string;
  status: string;
  runout_lane: string;
  extruder_temp: number;
}

export interface AfcHub {
  object: string;
  name: string;
  state: boolean;
}

export interface AfcExtruder {
  object: string;
  name: string;
  lane_loaded: string;
  tool_start_status: boolean | null;
  tool_end_status: boolean | null;
}

export interface AfcState {
  current_load: string | null;
  current_lane: string | null;
  next_lane: string | null;
  current_state: string;
  error_state: boolean;
  bypass_state: boolean;
  current_toolchange: number;
  number_of_toolchanges: number;
  spoolman: boolean;
  message: string;
  message_type: string;
  units: string[];
  lanes: AfcLane[];
  hubs: AfcHub[];
  extruders: AfcExtruder[];
}

export interface Heater {
  temperature: number;
  target: number;
  power: number;
}

export interface Snapshot {
  connection: ConnectionState;
  klippy_state: string;
  klippy_message: string;
  print_state: PrintState;
  filename: string;
  progress: number;
  print_duration: number;
  total_duration: number;
  estimated_time: number | null;
  time_left: number | null;
  filament_used: number;
  current_layer: number | null;
  total_layer: number | null;
  extruder: Heater;
  bed: Heater;
  chamber: Heater | null;
  fan_speed: number;
  speed_factor: number;
  flow_factor: number;
  message: string;
  hostname: string;
  software_version: string;
  macros: MacroInfo[];
  presets: Preset[];
  cooldown_gcode: string;
  afc: AfcState | null;
  temperatures: TempReading[];
  webcams: Webcam[];
  thumbnail: string | null;
  filament_color: string | null;
  filament_type: string | null;
  filament_colors: string[];
  active_extruder: string;
  machine: Machine;
  last_update: number;
  last_error: string | null;
}

export interface PrinterUpdate {
  id: string;
  snapshot: Snapshot;
}

export type PrinterAction =
  | "pause"
  | "resume"
  | "cancel"
  | "estop"
  | "firmware_restart"
  | "speed"
  | "gcode"
  | "preset"
  | "cooldown"
  | "reload_presets";

export const EMPTY_HEATER: Heater = { temperature: 0, target: 0, power: 0 };

export const EMPTY_SNAPSHOT: Snapshot = {
  connection: "offline",
  klippy_state: "",
  klippy_message: "",
  print_state: "",
  filename: "",
  progress: 0,
  print_duration: 0,
  total_duration: 0,
  estimated_time: null,
  time_left: null,
  filament_used: 0,
  current_layer: null,
  total_layer: null,
  extruder: EMPTY_HEATER,
  bed: EMPTY_HEATER,
  chamber: null,
  fan_speed: 0,
  speed_factor: 1,
  flow_factor: 1,
  message: "",
  hostname: "",
  software_version: "",
  macros: [],
  presets: [],
  cooldown_gcode: "",
  afc: null,
  temperatures: [],
  webcams: [],
  thumbnail: null,
  filament_color: null,
  filament_type: null,
  filament_colors: [],
  active_extruder: "extruder",
  machine: { kinematics: "", x_max: 0, y_max: 0, z_max: 0, leveling: "" },
  last_update: 0,
  last_error: null,
};

export const isBusy = (s: Snapshot) =>
  s.print_state === "printing" || s.print_state === "paused";
