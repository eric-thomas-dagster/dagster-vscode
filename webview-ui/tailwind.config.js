/** @type {import('tailwindcss').Config} */
// Carried over from Dagster Designer's frontend/tailwind.config.js --
// same brand tokens (Dagster Blurple etc.), so porting a component's
// classes carries its real visual design, not just its markup shape.
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        blue: {
          400: "hsl(var(--light-blurple))",
          500: "hsl(var(--blurple))",
          600: "hsl(var(--blurple))",
          700: "hsl(var(--deep-blurple))",
        },
      },
    },
  },
  plugins: [],
}
