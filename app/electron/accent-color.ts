/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Maps an OS accent color (hex) to the nearest of Vayu's 8 fixed accent schemes by hue. Arbitrary
 * accents are not allowed: each scheme's HSL values are hand-tuned to meet accessibility contrast
 * rules. Low-saturation accents (like Windows Graphite) map to the graphite scheme, itself
 * desaturated as the neutral choice.
 *
 * **Platform-gated**: the accent bridge installs nothing on Linux, which has no system accent color
 * and where `systemPreferences.getAccentColor()` returns undefined anyway.
 *
 * Kept out of main.ts so it can be unit-tested without importing Electron.
 */

/** Each scheme's light-mode `--primary` hue in degrees, from app/src/index.css. */
const SCHEME_HUES: Record<string, number> = {
	sunset: 24,
	sky: 192,
	ocean: 217,
	forest: 142,
	aurora: 262,
	coral: 0,
	magenta: 305,
	graphite: 220, // Desaturated fallback for low-saturation accents
};

type ColorScheme = keyof typeof SCHEME_HUES;

/**
 * `#rrggbbaa` or `#rrggbb` to `[h, s, l]`: h in degrees (0-360), s and l in percent (0-100). Throws
 * on an invalid string.
 */
function hexToHsl(hex: string): [number, number, number] {
	const cleaned = hex.replace(/^#/, "");
	let r: number, g: number, b: number;

	if (cleaned.length === 6 || cleaned.length === 8) {
		r = parseInt(cleaned.substring(0, 2), 16) / 255;
		g = parseInt(cleaned.substring(2, 4), 16) / 255;
		b = parseInt(cleaned.substring(4, 6), 16) / 255;
	} else {
		throw new Error(`Invalid hex color format: ${hex}`);
	}

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;

	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

		switch (max) {
			case r:
				h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
				break;
			case g:
				h = ((b - r) / d + 2) / 6;
				break;
			case b:
				h = ((r - g) / d + 4) / 6;
				break;
		}
	}

	return [h * 360, s * 100, l * 100];
}

/** The scheme whose reference hue is nearest, measured around the circle (red wraps at 360/0). */
function findNearestHue(targetHue: number): ColorScheme {
	const normalized = ((targetHue % 360) + 360) % 360;

	let nearest: ColorScheme = "graphite";
	let minDistance = Infinity;

	for (const [scheme, refHue] of Object.entries(SCHEME_HUES)) {
		// Skip graphite in the initial hue-based search (it's the fallback)
		if (scheme === "graphite") continue;

		let distance = Math.abs(normalized - refHue);
		if (distance > 180) {
			distance = 360 - distance;
		}

		if (distance < minDistance) {
			minDistance = distance;
			nearest = scheme as ColorScheme;
		}
	}

	return nearest;
}

/**
 * The scheme nearest an OS accent hex. Saturation under 15% maps to graphite, the neutral scheme,
 * whatever the hue.
 */
export function accentHexToColorScheme(hex: string | null | undefined): ColorScheme | null {
	if (!hex || typeof hex !== "string") return null;

	try {
		const [h, s] = hexToHsl(hex);

		if (s < 15) {
			return "graphite";
		}

		return findNearestHue(h);
	} catch {
		return null;
	}
}

/**
 * Forwards OS accent changes to the renderer. Installed once per process, not per window, because
 * `systemPreferences` is a process-wide emitter; the live window is read at send time, so a
 * replacement window (macOS dock reopen) gets the first change after it opens.
 *
 * **Entirely gated by platform:** a no-op on anything but Windows and macOS. Nothing is installed,
 * no listener registered, nothing sent.
 */
export interface AccentBridgeDeps {
	/** Defaults to the host's. Injected so both branches can be tested. */
	platform?: NodeJS.Platform;
	/** Return the current OS accent color as hex, or null if unavailable. */
	getAccentColor: () => string | null;
	/** Subscribe to changes. Callback fires when the accent changes. */
	onAccentChanged: (callback: () => void) => () => void;
	/** The current window, or null; read per call, as on macOS the app outlives its window. */
	window: () => { webContents: { send: (channel: string, data: unknown) => void } } | null;
	/** Log function for warnings/errors. */
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

export const ACCENT_COLOR_CHANNEL = "accent:changed";

export function installAccentBridge(deps: AccentBridgeDeps): () => void {
	const platform = deps.platform ?? process.platform;
	const isSupported = platform === "win32" || platform === "darwin";

	if (!isSupported) {
		return () => {}; // Empty cleanup
	}

	const unsubscribe = deps.onAccentChanged(() => {
		const win = deps.window();
		if (!win) return;

		const accentHex = deps.getAccentColor();
		const scheme = accentHexToColorScheme(accentHex);

		try {
			win.webContents.send(ACCENT_COLOR_CHANNEL, {
				accentScheme: scheme,
			});
		} catch (error) {
			deps.log("Failed to send accent change", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	return unsubscribe;
}
