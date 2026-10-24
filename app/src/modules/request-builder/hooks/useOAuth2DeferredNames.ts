/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo } from "react";
import { useDeferredVariables } from "@/components/layout/context-bar/code-composition";
import type { OAuth2Config } from "@/types";
import { oauth2DeferredNames, oauth2HasTokens } from "../utils/auth-resolution";

/**
 * The names in @p rawConfig, the OAuth 2.0 config *as written*, that a
 * pre-request script may change before @p requestId's Send (#2742). Empty
 * until the engine's composition lands, for a config with no `{{token}}`, and
 * while @p enabled is false.
 *
 * The raw config is read, never the resolved one: a name that also has a stored
 * value is swapped for it there, and the token is gone from the text. /compose
 * is asked only while the config holds a `{{token}}`, so a literal one costs no
 * compose. The result is memoised: a host passes it down as a prop.
 */
export function useOAuth2DeferredNames(
	requestId: string,
	rawConfig: OAuth2Config | null,
	enabled = true
): readonly string[] {
	const hasTokens = useMemo(() => oauth2HasTokens(rawConfig), [rawConfig]);
	const engineDeferred = useDeferredVariables(requestId, enabled && hasTokens);
	return useMemo(
		() => oauth2DeferredNames(rawConfig, engineDeferred),
		[rawConfig, engineDeferred]
	);
}
