// Colour themes. Each one is a `:root[data-theme="<id>"]` block of tokens in index.css;
// adding a theme = one CSS block + one entry here.

export const THEMES = { light: "Light", dark: "Dark" } as const;
export type Theme = keyof typeof THEMES;
/** What the user picked: a theme, or "system" to follow the OS light / dark setting. */
export type ThemePref = Theme | "system";

// ponytail: localStorage, not the Tauri store — it is read synchronously, so the first frame is already themed.
const KEY = "theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v && Object.hasOwn(THEMES, v) ? (v as Theme) : "system";
}

export function setThemePref(pref: ThemePref) {
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  apply();
}

function apply() {
  const pref = getThemePref();
  document.documentElement.dataset.theme = pref === "system" ? (media.matches ? "dark" : "light") : pref;
}

/** Applies the saved theme and keeps "system" in sync with the OS. Call once before rendering. */
export function initTheme() {
  apply();
  media.addEventListener("change", apply);
}
