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
 * text input). Public surface only — TokenStatusRow is an internal detail.
 */

export { default as OAuth2Form } from "./OAuth2Form";
export type { OAuth2FormProps, OAuth2TextInput } from "./types";
