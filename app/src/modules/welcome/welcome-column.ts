/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The welcome screen's reading column (#1691): centred, at the widest size on the dialog scale
 * (`max-w-2xl`, 672px, the "Browser" width in `docs/design-system/dialogs.md`), the size for a
 * surface whose work is reading and choosing. At full tab width, 1440px left the right two-thirds
 * empty and the eye would travel a monitor's width between a tile and the run list under it.
 *
 * Shared by the screen's three states (the Launcher, the first-run pitch and the skeleton between
 * them): a skeleton in a different column from the content it stands in for shifts the page when
 * the queries land, the one thing a skeleton exists to prevent. Held by the states, not
 * `WelcomeScreen`'s scroller, so each is complete where it is mounted.
 */
export const WELCOME_COLUMN = "mx-auto w-full max-w-2xl";
