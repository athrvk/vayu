/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { OAUTH2_FIELD_LABELS } from "@/constants/oauth2-fields";
import type { OAuth2Config } from "@/types";

/**
 * The labels of what the engine needs before a token request can go anywhere:
 * the authorize start rejects without authorizationUrl + clientId, the token
 * endpoint without accessTokenUrl + clientId (clientId for every grant, not just
 * the ones RFC 6749 requires it for), and a `jwt_bearer` grant without a
 * subject, an assertion audience and a key from one source (#3632). Presence
 * only - the engine owns URL validity, and duplicating that rule here would be
 * a second copy of it to keep in step; its 400 arrives relabelled instead
 * (`humanizeOAuth2Error`).
 *
 * A `privateKey` counts as present whatever it holds: it is a reference the
 * engine resolves, so the renderer cannot tell an empty variable from a set one.
 */
export function missingOAuth2Fields(config: OAuth2Config): string[] {
	const missing: string[] = [];
	if (config.grantType === "authorization_code" && !config.authorizationUrl) {
		missing.push(OAUTH2_FIELD_LABELS.authorizationUrl);
	}
	if (!config.accessTokenUrl) missing.push(OAUTH2_FIELD_LABELS.accessTokenUrl);
	if (!config.clientId) missing.push(OAUTH2_FIELD_LABELS.clientId);
	if (config.grantType === "jwt_bearer") missing.push(...missingJwtBearerFields(config));
	return missing;
}

function missingJwtBearerFields(config: OAuth2Config): string[] {
	const missing: string[] = [];
	if (!config.subject) missing.push(OAUTH2_FIELD_LABELS.subject);
	if (!config.assertionAudience) missing.push(OAUTH2_FIELD_LABELS.assertionAudience);
	if (!config.privateKey && !config.privateKeyFile) missing.push(OAUTH2_FIELD_LABELS.privateKey);
	return missing;
}
