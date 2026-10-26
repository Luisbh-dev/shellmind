import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";
import plugin from "tailwindcss/plugin";
import { INK_SHADES, SHADES, THEMED_HUES, themeStylesheet } from "./src/features/appearance/palette";

// Colours are CSS custom properties set per theme and accent (see
// src/features/appearance/palette.ts), so the classes stay the same in every
// theme: `text-zinc-100` is strong text, `bg-white/5` a hover tint, and so on.
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;
const scale = (name: string, shades: readonly number[]) =>
  Object.fromEntries(shades.map((shade) => [shade, token(`${name}-${shade}`)]));
// The overlay colours scale the alpha of the class by a per-theme factor.
const scaled = (name: string, factor: string) => `rgb(var(--c-${name}) / calc(<alpha-value> * var(--${factor}, 1)))`;

// The density (Settings → Appearance) scales spacing in rem by --density:
// gaps and stacks in both directions, paddings and margins only vertically.
// Compact rows get denser while horizontal insets, which icons inside inputs
// and table columns line up with, stay put. Widths, heights and font sizes
// never change.
const dense = (value: string) => (value.endsWith("rem") ? `calc(${value} * var(--density, 1))` : value);
const densitySpacing = Object.fromEntries(Object.entries(defaultTheme.spacing).map(([key, value]) => [key, dense(value)]));

// Tailwind's padding and margin utilities (same names, groups and cascade
// order; the core plugins are off) with the vertical sides following the
// density.
const VERTICAL = new Set(["padding-top", "padding-bottom", "margin-top", "margin-bottom"]);
type SideGroup = Array<[prefix: string, properties: string[]]>;
const sides = (p: string, property: string): SideGroup[] => [
  [[p, [`${property}-top`, `${property}-right`, `${property}-bottom`, `${property}-left`]]],
  [[`${p}x`, [`${property}-left`, `${property}-right`]], [`${p}y`, [`${property}-top`, `${property}-bottom`]]],
  [
    [`${p}s`, [`${property}-inline-start`]], [`${p}e`, [`${property}-inline-end`]], [`${p}t`, [`${property}-top`]],
    [`${p}r`, [`${property}-right`]], [`${p}b`, [`${property}-bottom`]], [`${p}l`, [`${property}-left`]]
  ]
];
const densitySides = (property: "padding" | "margin", prefix: string) =>
  plugin(({ matchUtilities, theme }) => {
    for (const group of sides(prefix, property)) {
      matchUtilities(
        Object.fromEntries(group.map(([name, properties]) => [
          name,
          (value: string) => Object.fromEntries(properties.map((side) => [side, VERTICAL.has(side) ? dense(value) : value]))
        ])),
        { values: theme(property), supportsNegativeValues: property === "margin" }
      );
    }
  });

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
    "./index.html"
  ],
  corePlugins: { padding: false, margin: false },
  theme: {
    gap: densitySpacing,
    space: densitySpacing,
    extend: {
      colors: {
        // Layered surfaces — from deepest background up to elevated panels.
        ink: scale("ink", INK_SHADES),
        // The accent colour chosen in Settings → Appearance (teal by default).
        brand: scale("brand", SHADES),
        "on-brand": token("on-brand"),
        // Keyboard focus indicators (palette.ts focusRingColor).
        focus: token("focus-ring"),
        zinc: scale("zinc", SHADES),
        ...Object.fromEntries(THEMED_HUES.map((hue) => [hue, scale(hue, SHADES)])),
        white: scaled("white", "tint-boost"),
        black: scaled("black", "well-scale"),
        scrim: scaled("scrim", "scrim-scale"),
        // The same in every theme (text on solid status colours).
        fixed: { white: "#ffffff", black: "#08090c" }
      },
      // Inter and JetBrains Mono are bundled (main.tsx), so every OS renders
      // the same fonts; the fallbacks only cover a failed load. Mono text is
      // commands, paths and output people read and copy character by
      // character: no ligatures (JetBrains Mono draws `--` as a dash and
      // `===` as a double bar). Applies to font-mono and to code/pre/kbd.
      fontFamily: {
        sans: ["'Inter Variable'", "Inter", "-apple-system", "BlinkMacSystemFont", "'Segoe UI'", "sans-serif"],
        mono: [
          ["'JetBrains Mono Variable'", "'JetBrains Mono'", "'Cascadia Mono'", "Consolas", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
          { fontFeatureSettings: "'calt' 0, 'liga' 0" }
        ]
      },
      boxShadow: {
        glow: "0 0 0 1px rgb(var(--c-brand-400) / 0.18), 0 8px 30px -8px rgb(var(--c-brand-500) / 0.35)",
        panel: "var(--shadow-panel)",
        soft: "var(--shadow-soft)"
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" }
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" }
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" }
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" }
        }
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "scale-in": "scale-in 0.16s cubic-bezier(0.16,1,0.3,1)",
        "slide-up": "slide-up 0.22s cubic-bezier(0.16,1,0.3,1)",
        "slide-in-right": "slide-in-right 0.24s cubic-bezier(0.16,1,0.3,1)"
      }
    }
  },
  plugins: [
    typography,
    plugin(({ addBase }) => addBase(themeStylesheet())),
    densitySides("margin", "m"),
    densitySides("padding", "p"),
  ],
};
export default config;
