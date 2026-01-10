import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@/components": path.resolve(__dirname, "./src/components"),
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
