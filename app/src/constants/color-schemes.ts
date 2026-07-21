/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Accent color schemes — the single source of truth.
 *
 * Each scheme is applied via the `data-color-scheme` attribute on <html> and
 * only shifts the accent tokens (`--primary`, `--ring`, `--variable`,
 * `--chart-1`); the concrete HSL values live in `app/src/index.css` under the
 * matching `[data-color-scheme="…"]` selectors. The `ColorScheme` union, the
 * settings picker, and the runtime guard all derive from this array, so adding
 * a scheme means editing this file plus the CSS — nothing else.
 */

import { Cloud, Waves, Trees, Sunset, Sparkles, Heart, Gem, Contrast } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ColorSchemeOption {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly icon: LucideIcon;
}

export const COLOR_SCHEMES = [
	{ value: "sky", label: "Sky", description: "Calm and airy", icon: Cloud },
	{ value: "ocean", label: "Ocean", description: "Deep and professional", icon: Waves },
	{ value: "forest", label: "Forest", description: "Fresh and natural", icon: Trees },
	{ value: "sunset", label: "Sunset", description: "Warm and energetic", icon: Sunset },
	{ value: "aurora", label: "Aurora", description: "Magical and modern", icon: Sparkles },
	{ value: "coral", label: "Coral", description: "Vibrant and lively", icon: Heart },
	{ value: "magenta", label: "Magenta", description: "Bold and electric", icon: Gem },
	{ value: "graphite", label: "Graphite", description: "Muted and neutral", icon: Contrast },
] as const satisfies readonly ColorSchemeOption[];

/** Accent color scheme name, applied via the `data-color-scheme` attribute. */
export type ColorScheme = (typeof COLOR_SCHEMES)[number]["value"];

/** Accent applied before the user picks one. */
export const DEFAULT_COLOR_SCHEME: ColorScheme = "ocean";

const SCHEME_VALUES = new Set<string>(COLOR_SCHEMES.map((s) => s.value));

/** Narrowing guard for values read from storage / the OS bridge. */
export function isColorScheme(value: unknown): value is ColorScheme {
	return typeof value === "string" && SCHEME_VALUES.has(value);
}
