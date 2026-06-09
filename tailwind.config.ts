import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
    "./index.html"
  ],
  theme: {
    extend: {
      colors: {
        // Layered surfaces — from deepest background up to elevated panels.
        ink: {
          900: "#08090c",
          850: "#0b0d11",
          800: "#0f1115",
          750: "#13161c",
          700: "#181b22",
          650: "#1d212a",
          600: "#242935"
        },
        // Primary brand accent (teal/cyan).
        brand: {
          50: "#effdfb",
          100: "#cffcf6",
          200: "#9ff7ee",
          300: "#5eeae0",
          400: "#2dd4cb",
          500: "#14b8b0",
          600: "#0b9390",
          700: "#0e7472",
          800: "#115d5d",
          900: "#134d4e"
        }
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "'Courier New'", "monospace"]
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(45,212,203,0.18), 0 8px 30px -8px rgba(20,184,176,0.35)",
        panel: "0 18px 48px -16px rgba(0,0,0,0.65)",
        soft: "0 8px 24px -12px rgba(0,0,0,0.5)"
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
    require('@tailwindcss/typography'),
  ],
};
export default config;
