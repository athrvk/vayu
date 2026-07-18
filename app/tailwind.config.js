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

				// Panel — sidebar / panel bg (between background and card)
				panel: "hsl(var(--panel))",

				// Subtle foreground for truly de-emphasized text
				"subtle-foreground": "hsl(var(--subtle-foreground))",

				// Status colors
				success: {
					DEFAULT: "hsl(var(--success))",
					foreground: "hsl(var(--success-foreground))",
					text: "hsl(var(--success-text))",
				},
				warning: {
					DEFAULT: "hsl(var(--warning))",
					foreground: "hsl(var(--warning-foreground))",
					text: "hsl(var(--warning-text))",
				},
				info: {
					DEFAULT: "hsl(var(--info))",
					foreground: "hsl(var(--info-foreground))",
				},

				// Chart colors
				chart: {
					1: "hsl(var(--chart-1))",
					2: "hsl(var(--chart-2))",
					3: "hsl(var(--chart-3))",
					4: "hsl(var(--chart-4))",
					5: "hsl(var(--chart-5))",
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
			keyframes: {
				"accordion-down": {
					from: { height: "0" },
					to: { height: "var(--radix-accordion-content-height)" },
				},
				"accordion-up": {
					from: { height: "var(--radix-accordion-content-height)" },
					to: { height: "0" },
				},
				"fade-in": {
					from: { opacity: "0" },
					to: { opacity: "1" },
				},
				"slide-in": {
					from: { transform: "translateY(-10px)", opacity: "0" },
					to: { transform: "translateY(0)", opacity: "1" },
				},
				"vayu-spin": {
					to: { transform: "rotate(360deg)" },
				},
				"vayu-pulse": {
					"0%, 100%": { opacity: "1" },
					"50%": { opacity: "0.35" },
				},
				"vayu-fadepulse": {
					"0%, 100%": { opacity: "0.9" },
					"50%": { opacity: "0.5" },
				},
			},
			animation: {
				"accordion-down": "accordion-down 0.2s ease-out",
				"accordion-up": "accordion-up 0.2s ease-out",
				"fade-in": "fade-in 0.2s ease-out",
				"slide-in": "slide-in 0.2s ease-out",
				"vayu-spin": "vayu-spin 0.7s linear infinite",
				"vayu-pulse": "vayu-pulse 1.6s ease-in-out infinite",
				"vayu-fadepulse": "vayu-fadepulse 2s ease-in-out infinite",
			},
		},
	},
	plugins: [require("tailwindcss-animate")],
};
