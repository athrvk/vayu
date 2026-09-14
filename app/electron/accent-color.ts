/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Map OS system accent colors to Vayu's fixed accent color schemes.
 *
 * Windows and macOS expose the system accent color to applications, but Vayu
 * does not allow arbitrary accent colors - it has 8 hand-tuned schemes with
 * specific HSL values that satisfy accessibility contrast rules. This module
 * maps an OS accent (as a hex string) to the closest scheme by hue.
 *
 * The mapping is purely hue-based: extract HSL from the hex, find the nearest
 * reference hue, and apply that scheme. Low-saturation accents (like Windows
 * Graphite) map to the graphite scheme, which is itself desaturated as the
 * neutral choice.
 *
 * **Platform-gated**: the accent bridge installs nothing on Linux, where no
 * system accent color exists, and Electron's systemPreferences.getAccentColor()
 * returns undefined anyway.
 *
 * Kept out of main.ts so it can be unit-tested without importing Electron.
 */

/**
 * Reference hues for the 8 color schemes, extracted from app/src/index.css.
 * These are the hue values in degrees from the light-mode --primary HSL.
 */
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
 * Convert hex color (#rrggbbaa or #rrggbb) to HSL.
 *
 * Returns [h, s, l] where h is in degrees (0-360), s and l are in percent (0-100).
 * Throws if the hex string is not valid.
 */
function hexToHsl(hex: string): [number, number, number] {
	// Remove # and convert to RGB
	const cleaned = hex.replace(/^#/, "");
	let r: number, g: number, b: number;

	if (cleaned.length === 6 || cleaned.length === 8) {
		r = parseInt(cleaned.substring(0, 2), 16) / 255;
		g = parseInt(cleaned.substring(2, 4), 16) / 255;
		b = parseInt(cleaned.substring(4, 6), 16) / 255;
	} else {
		// Invalid format
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

/**
 * Find the nearest hue match in degrees.
 *
 * Handles wrap-around at 360/0 (red). Returns the closest hue by absolute
 * difference, accounting for the circular nature of hue space.
 */
function findNearestHue(targetHue: number): ColorScheme {
	// Normalize target to 0-360
	const normalized = ((targetHue % 360) + 360) % 360;

	let nearest: ColorScheme = "graphite";
	let minDistance = Infinity;

	for (const [scheme, refHue] of Object.entries(SCHEME_HUES)) {
		// Skip graphite in the initial hue-based search (it's the fallback)
		if (scheme === "graphite") continue;

		// Calculate circular distance
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
 * Map OS accent color hex string to the nearest ColorScheme.
 *
 * Low saturation accents (s < 15%) map to graphite regardless of hue,
 * since graphite is the desaturated/neutral scheme. Otherwise, hue determines
 * the match by finding the closest reference hue.
 */
export function accentHexToColorScheme(hex: string | null | undefined): ColorScheme | null {
	if (!hex || typeof hex !== "string") return null;

	try {
		const [h, s] = hexToHsl(hex);

		// Low-saturation accents map to graphite (the neutral scheme)
		if (s < 15) {
			return "graphite";
		}

		// Hue-based matching for everything else
		return findNearestHue(h);
	} catch {
		return null;
	}
}

/**
 * Bridge OS system accent color changes to the renderer.
 *
 * Installs once per process (not per window): systemPreferences is a
 * process-wide emitter. Reads the live window via a callback at send time,
 * so a replacement window (macOS dock reopen) receives the first accent
 * change after it existed.
 *
 * **Entirely gated by platform:** returns a no-op on any platform other than
 * Windows or macOS. Nothing is installed, no listener is registered, nothing
 * sends.
 */
export interface AccentBridgeDeps {
	/** Defaults to the host's. Injected so both branches can be tested. */
	platform?: NodeJS.Platform;
	/** Return the current OS accent color as hex, or null if unavailable. */
	getAccentColor: () => string | null;
	/** Subscribe to changes. Callback fires when the accent changes. */
	onAccentChanged: (callback: () => void) => () => void;
	/**
	 * The window as it is right now, or null. Read per call rather than
	 * captured: on macOS the app outlives its window.
	 */
	window: () => { webContents: { send: (channel: string, data: unknown) => void } } | null;
	/** Log function for warnings/errors. */
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

export const ACCENT_COLOR_CHANNEL = "accent:changed";

export function installAccentBridge(deps: AccentBridgeDeps): () => void {
	const platform = deps.platform ?? process.platform;
	const isSupported = platform === "win32" || platform === "darwin";

	// No-op on unsupported platforms (Linux, etc.)
	if (!isSupported) {
		return () => {}; // Empty cleanup
	}

	// Subscribe to accent changes and forward to renderer
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
