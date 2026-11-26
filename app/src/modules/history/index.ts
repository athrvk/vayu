/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The History module: `sidebar/` (the run list, `HistoryList`), `main/` (the run views:
 * `HistoryDetail`, `LoadTestDetail`, `DesignRunView`) and `types.ts`, the module's shared types.
 * Import from `@/modules/history/sidebar` or `@/modules/history/main`, or from here through the
 * `sidebar` / `main` namespaces; the four views are also re-exported flat.
 */

export * as sidebar from "./sidebar";

export * as main from "./main";

export { default as HistoryList } from "./sidebar/HistoryList";
export { default as HistoryDetail } from "./main/HistoryDetail";
export { default as LoadTestDetail } from "./main/LoadTestDetail";
export { default as DesignRunView } from "./main/DesignRunView";

export * from "./types";
