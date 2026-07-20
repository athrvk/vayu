/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Min/max width for resizable side panels (drawer, context bar). */
export const PANEL_MIN_WIDTH = 220;
export const PANEL_MAX_WIDTH = 480;

/** Default widths per drawer view (px). */
export const DEFAULT_DRAWER_WIDTHS = {
	collections: 260,
	history: 320,
	variables: 260,
	settings: 260,
} as const;

/** Default width of the right context bar (px). */
export const DEFAULT_CONTEXT_BAR_WIDTH = 252;
