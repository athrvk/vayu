/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The welcome screen's reading column (#1691).
 *
 * The screen filled the whole tab: at 1440px the tiles and the recent runs hugged
 * the left edge with the right two-thirds empty, so the eye had to travel the
 * width of a monitor between a tile and the run list under it. It is a centred
 * column now, at the widest size on the dialog scale (`max-w-2xl`, 672px, the
 * "Browser" width in `docs/design-system.md`) - the same job as that size, a
 * surface whose work is reading and choosing.
 *
 * Declared once and shared by the three states the screen can be in - the
 * Launcher, the first-run pitch and the skeleton between them - because a
 * skeleton in a different column from the content it stands in for shifts the
 * page the moment the queries land, which is the one thing a skeleton exists to
 * prevent. Held by the states rather than by `WelcomeScreen`'s scroller so each
 * is complete where it is mounted.
 */
export const WELCOME_COLUMN = "mx-auto w-full max-w-2xl";
