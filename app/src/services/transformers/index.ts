
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Transformers Index
 *
 * Central export for all data transformers.
 * These transformers handle conversion between frontend and backend formats:
 * - Date conversion (number timestamps → ISO strings)
 * - Data structure transformation (arrays → objects)
 */

export { RequestTransformer, type BackendRequest } from "./request-transformer";
export { CollectionTransformer, type BackendCollection } from "./collection-transformer";
export { RunReportTransformer } from "./run-report-transformer";
export { GlobalsTransformer, type BackendGlobals } from "./globals-transformer";
