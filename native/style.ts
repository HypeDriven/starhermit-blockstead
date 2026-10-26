// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, selects, scroll bars) fall
// back to. The browser build's body classes that swapped the palette are
// token sets here: high contrast (the runtime's accessibility option) and
// the game's high-visibility palette.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const COLORS = {
  bg: "#0b1420", panel: "#101c2a", panel2: "#1a2a3c", ink: "#eef2f6", dim: "#b9c4cf",
  accent: "#3b82f6", danger: "#b91c1c", ok: "#7cfc9a", focus: "#ffd27a", hover: "#24374d",
};
type Tokens = Record<string, string>;
let base: Tokens = {};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 24, padding: 8, spacing: 8, radius: 12,
    text: COLORS.ink, muted: COLORS.dim, panel: COLORS.panel, control: COLORS.panel2, hovered: COLORS.hover,
    pressed: COLORS.hover, field: COLORS.panel2, accent: COLORS.accent, focus: COLORS.focus, outline: "#05090e",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 36,
      parts: { box: { background: "#14202f", border: { width: 1, color: "$ink-dim" }, radius: 4 }, mark: { background: "$accent" } },
    },
    scrollArea: { parts: { bar: { background: "$ink-dim", radius: 4 } } },
  });
}

let paletteKey = "";
/** The palette tokens: high contrast (black panels, white ink and borders,
 * cyan focus), the high-visibility palette (stronger accent and focus), else
 * the sheet's. */
export function applyPalette(highContrast: boolean, highVisibility: boolean): void {
  const key = `${highContrast}:${highVisibility}`;
  if (key === paletteKey) return;
  paletteKey = key;
  const tokens: Tokens = { ...base };
  if (highContrast) {
    Object.assign(tokens, {
      bg: "#000000", panel: "rgba(0, 0, 0, 0.92)", "panel-solid": "#000000", hud: "rgba(0, 0, 0, 0.88)",
      ink: "#ffffff", "ink-dim": "#e0e0e0", line: "#ffffff", focus: "#00e5ff",
    });
  }
  if (highVisibility) Object.assign(tokens, { accent: "#2563eb", gold: "#ffd60a", ok: "#4dd0e1", focus: "#00e5ff" });
  ui.setTokens(tokens);
}
