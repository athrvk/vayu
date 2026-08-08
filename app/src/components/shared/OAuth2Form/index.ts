/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared OAuth 2.0 auth-editor form.
 *
 * Rendered by the request builder's Auth tab (and any host that injects a
 * text input).
 *
 * `TokenStatusRow` used to be an internal detail of the form. It is exported
 * now because the context bar's auth section shows the same thing - is there a
 * token, has it expired, fetch or clear it - for a request whose auth resolves
 * to OAuth 2.0, and the alternative was a second copy of the cache-key
 * derivation and the interactive-authorize flow. It takes a config with
 * `{{variables}}` already resolved and owns everything after that.
 */

export { default as OAuth2Form } from "./OAuth2Form";
export { default as TokenStatusRow } from "./TokenStatusRow";
export type { OAuth2FormProps, OAuth2TextInput } from "./types";
