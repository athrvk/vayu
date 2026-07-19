/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// UI State Types
// Cross-cutting UI types shared across components, hooks, and the Electron
// preload contract. View/navigation state now lives with its owning store
// (DrawerView in layout-store, TabType in tabs-store).

/** App theme preference. `system` follows the OS via Electron's nativeTheme. */
export type ThemeSource = "system" | "light" | "dark";

/**
 * Accent color scheme, applied via the `data-color-scheme` attribute.
 * Re-exported from the single source of truth in `@/constants/color-schemes`.
 */
export type { ColorScheme } from "@/constants/color-schemes";
