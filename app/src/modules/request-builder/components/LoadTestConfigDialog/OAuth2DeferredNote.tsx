/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Callout } from "@/components/shared";
import { deferredTokens } from "@/lib/deferred-note";
import { pickByCount } from "@/modules/dashboard/utils/format";

/**
 * Says a load run's OAuth 2.0 token is acquired once, before any script, from
 * the stored values (#2742), when a pre-request script sets a name the config
 * uses. A Send resolves the config after the script, so the same request behaves
 * differently there and the user has no other way to learn it.
 *
 * Renders nothing for an empty @p names.
 */
export function OAuth2DeferredNote({ names }: { names: readonly string[] }) {
	if (names.length === 0) return null;

	const tokens = deferredTokens(names);
	const setBy = pickByCount(names.length, {
		one: `${tokens} is set by a pre-request script, but`,
		other: `${tokens} are set by a pre-request script, but`,
	});

	return (
		<Callout severity="info" title="OAuth 2.0 token is fetched before scripts">
			{setBy} a load run gets its token once, before any script, from the stored values.
			Script changes to OAuth 2.0 settings don&apos;t apply under load.
		</Callout>
	);
}
