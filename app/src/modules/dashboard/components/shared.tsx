/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Re-exported, not redefined - all three live in `components/ui` so every
// surface can reach them, and the dashboard's existing imports still resolve.
//
// `InfoChip` was defined here, where only the dashboard could import it without
// a module reaching into another module. The request-builder therefore grew its
// own copy (`ResponseTimingTab`'s `InfoTip`), and the copy is the one that got
// the `border-rule` fix - so the original never did. It lives in
// `ui/info-chip` now; see that file for why the border stayed a prop.
//
// `Eyebrow` was the same shape with a quieter symptom: this file imported the
// shared `EYEBROW_CLASS` and then wrapped it in a second component that dropped
// the `className` the primitive accepts. Same class string, so nothing looked
// wrong - but a dashboard caller that needed a margin had to reach past it.
export { EYEBROW_CLASS, Eyebrow, InfoChip } from "@/components/ui";
