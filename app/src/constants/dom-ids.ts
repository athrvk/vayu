/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Element ids that two modules have to agree on.
 *
 * An id spelled at both ends is a string pair nothing keeps in step: rename the
 * writer and the reader silently finds nothing, which is a no-op rather than an
 * error. Declared here, both ends import the one value.
 *
 * Ids that only one component uses - a label's `htmlFor`, a dialog's
 * `aria-describedby` - stay where they are generated (`tab-aria.ts` is the
 * pattern for a whole family of them); this file is for the cross-module case.
 */

/**
 * The request builder's URL field.
 *
 * Written by `UrlInput`, read by the Shell's ⌘L handler (`region-focus.ts`) -
 * which lives outside the request builder and cannot hold a ref into it.
 */
export const REQUEST_URL_INPUT_ID = "request-url-input";
