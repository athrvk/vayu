/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Re-exported, not redefined: all three live in `components/ui` so every surface can reach them,
// and the dashboard's imports still resolve. A module-local copy of a primitive misses its fixes
// and its props: `InfoChip`'s `border-rule` (see `ui/info-chip` for why the border stays a prop),
// `Eyebrow`'s `className`.
export { EYEBROW_CLASS, Eyebrow, InfoChip } from "@/components/ui";
