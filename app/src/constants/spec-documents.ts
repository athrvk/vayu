/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Seed for the engine's cap on one stored OpenAPI document, mirroring
 * `constants::spec_document::MAX_BYTES` engine-side.
 *
 * Not the rule - `maxSpecDocumentBytes` is a setting a user can raise, and the
 * live value comes from the config query via {@link useSpecDocumentLimit}. This
 * stands in only until that query resolves, and it is the number the engine
 * itself seeds, so the gap changes nothing.
 */
export const SPEC_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
