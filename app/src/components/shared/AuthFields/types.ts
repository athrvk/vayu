/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RequestAuth } from "@/types";
import type { OAuth2TextInput } from "../OAuth2Form";

/**
 * The injected text input is the same contract `OAuth2Form` already defines -
 * one host passes a variable-aware editor, the other a plain input - so it is
 * re-exported rather than restated. A second identical type would be a second
 * thing to keep in step.
 */
export type AuthTextInput = OAuth2TextInput;

/** The concrete auth an editor may hold. `inherit` resolves elsewhere. */
export type EditableAuth = Exclude<RequestAuth, { mode: "inherit" }>;

export interface AuthFieldsProps {
	value: EditableAuth;
	onChange: (next: EditableAuth) => void;
	/**
	 * What "No Auth" means *here*. The two hosts say genuinely different things -
	 * a request sends nothing, a collection hands nothing down - so the copy is
	 * supplied rather than guessed, while the empty state itself stays shared.
	 */
	noAuthDescription: React.ReactNode;
	/** Variable-aware text input; falls back to a plain input when omitted. */
	TextInput?: AuthTextInput;
	/** Resolves {{variables}} before an OAuth 2.0 token request. */
	resolveString?: (value: string) => string;
}
