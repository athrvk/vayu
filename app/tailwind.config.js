/** @type {import('tailwindcss').Config} */
export default {
	darkMode: ["class"],
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	theme: {
		extend: {
			colors: {
				// Semantic colors from CSS variables
				background: "hsl(var(--background))",
				foreground: "hsl(var(--foreground))",
				card: {
					DEFAULT: "hsl(var(--card))",
					foreground: "hsl(var(--card-foreground))",
				},
				popover: {
					DEFAULT: "hsl(var(--popover))",
					foreground: "hsl(var(--popover-foreground))",
				},
				primary: {
					DEFAULT: "hsl(var(--primary))",
					fill: "hsl(var(--primary-fill))",
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
					active: "hsl(var(--accent-active))",
				},
				destructive: {
					DEFAULT: "hsl(var(--destructive))",
					foreground: "hsl(var(--destructive-foreground))",
				},
				border: "hsl(var(--border))",
				"border-strong": "hsl(var(--border-strong))",
				input: "hsl(var(--input))",
				ring: "hsl(var(--ring))",

				// Panel - sidebar / panel bg (between background and card)
				panel: "hsl(var(--panel))",

				// Subtle foreground for truly de-emphasized text
				"subtle-foreground": "hsl(var(--subtle-foreground))",

				// Status colors
				success: {
					DEFAULT: "hsl(var(--success))",
					text: "hsl(var(--success-text))",
				},
				warning: {
					DEFAULT: "hsl(var(--warning))",
					text: "hsl(var(--warning-text))",
				},

				// Variable highlighting
				variable: "hsl(var(--variable))",

				// Variable scope (categorical): global / collection / environment
				scope: {
					global: "hsl(var(--scope-global))",
					collection: "hsl(var(--scope-collection))",
					environment: "hsl(var(--scope-environment))",
				},

				// Run / connection / test status indicators (mode-consistent)
				status: {
					success: "hsl(var(--status-success))",
					error: "hsl(var(--status-error))",
					running: "hsl(var(--status-running))",
					stopped: "hsl(var(--status-stopped))",
				},
			},
			fontFamily: {
				sans: ["Space Grotesk", "system-ui", "sans-serif"],
				mono: ["JetBrains Mono", "Consolas", "Monaco", "monospace"],
			},
			borderRadius: {
				lg: "var(--radius)",
				md: "calc(var(--radius) - 2px)",
				sm: "calc(var(--radius) - 4px)",
			},
		},
	},
	plugins: [],
};
