/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shared auth field editor (None / Bearer / Basic / API Key, and OAuth 2.0 via
 * the shared OAuth2Form). Rendered by the request builder's Auth tab and the
 * collection Auth tab.
 */

export { default as AuthFields } from "./AuthFields";
export type { AuthFieldsProps, AuthTextInput, EditableAuth } from "./types";
