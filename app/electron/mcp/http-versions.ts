/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file http-versions.ts
 * @brief HTTP protocol values a request asks the engine to negotiate.
 *
 * Mirrors `HTTP_VERSIONS` in `app/src/constants/request.ts` - restated here
 * rather than imported because `electron/` shares no module graph with
 * `app/src/` (no `@/` alias). Lived in `resolve.ts` until issue #226 deleted
 * MCP's composition copy; the value list is all that had to survive, because
 * `tools.ts` builds its Zod enums from it.
 *
 * The two arrays hold the same *values* but deliberately differ in *shape*:
 * the renderer's is `{value, label}[]` because it populates a picker, this one
 * is a flat tuple because `z.enum` takes bare strings. Do not "fix" the
 * difference by diffing them literally - it is the value list that must stay
 * in step, not the structure.
 */

export const HTTP_VERSIONS = ["auto", "http1.1", "http2"] as const;
export type HttpVersion = (typeof HTTP_VERSIONS)[number];
