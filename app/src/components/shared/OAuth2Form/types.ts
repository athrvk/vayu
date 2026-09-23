/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ComponentType } from "react";
import type { OAuth2Config } from "@/types";

/**
 * Text input the form renders for every string field. Injected so the request
 * builder can supply a variable-aware VariableInput while the collection editor
 * supplies a plain Input - the shared form stays agnostic.
 */
export type OAuth2TextInput = ComponentType<{
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: "text" | "password";
}>;

export interface OAuth2FormProps {
	value: OAuth2Config;
	onChange: (next: OAuth2Config) => void;
	/** Resolves {{variables}} before a token request (defaults to identity). */
	resolveString?: (value: string) => string;
	/**
	 * The id of the entity this config belongs to - a request id, say.
	 *
	 * It identifies the *fields* for the resolved-value cache the form keeps, so
	 * a `{{$guid}}` in a credential answers the same thing after the host tab
	 * has been unmounted and remounted. Omit it where nothing resolves (a host
	 * that passes no `resolveString` has no dynamic values to hold still); see
	 * the note above `stableConfigField` in `OAuth2Form.tsx`.
	 */
	resolveKey?: string;
	/** Variable-aware text input; falls back to a plain input when omitted. */
	TextInput?: OAuth2TextInput;
}
