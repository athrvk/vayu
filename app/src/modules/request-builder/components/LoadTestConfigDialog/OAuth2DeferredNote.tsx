/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Callout } from "@/components/shared";
import { deferredTokens } from "@/lib/deferred-note";

/**
 * Says a load run acquires its OAuth 2.0 token once, before any script, from stored values (#2742),
 * when a pre-request script may change a name the config uses. A Send resolves the config after the
 * script, so the request behaves differently there and nothing else tells the user. The names are
 * the engine's deferred ones, which say a script *runs*, not that it writes them; hence "may be
 * changed". Renders nothing for empty @p names.
 */
export function OAuth2DeferredNote({ names }: { names: readonly string[] }) {
	if (names.length === 0) return null;

	return (
		<Callout severity="info" title="OAuth 2.0 token is fetched before scripts">
			{deferredTokens(names)} may be changed by a pre-request script, but a load run gets its
			token once, before any script, from the stored values. Script changes to OAuth 2.0
			settings don&apos;t apply under load.
		</Callout>
	);
}
