import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";

// Read version from package.json
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf-8"));

export default defineConfig({
	plugins: [react()],
	define: {
		__VAYU_VERSION__: JSON.stringify(packageJson.version),
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@/components": path.resolve(__dirname, "./src/components"),
			"@/modules": path.resolve(__dirname, "./src/modules"),
			"@/stores": path.resolve(__dirname, "./src/stores"),
			"@/hooks": path.resolve(__dirname, "./src/hooks"),
			"@/services": path.resolve(__dirname, "./src/services"),
			"@/types": path.resolve(__dirname, "./src/types"),
			"@/utils": path.resolve(__dirname, "./src/utils"),
		},
	},
	base: "./",
	server: {
		port: 5173,
		strictPort: true,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		rollupOptions: {
			output: {
				manualChunks: {
					"react-vendor": ["react", "react-dom"],
					charts: ["recharts"],
				},
			},
		},
	},
});
