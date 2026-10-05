/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Over a design run's copy whose recorded url, params or body holds the
 * engine's `<redacted>` marker (#1803).
 *
 * A header the engine withheld is never seeded, but these are seeded as
 * recorded - the marker stands where the secret was - so sending the copy
 * sends that text literally. The notice is the replay's reader of
 * `DesignRunSeed.withheld`; the save path is the other one.
 *
 * Silent when nothing in the request line or body was withheld.
 */

import { Callout } from "@/components/shared";
import { WITHHELD_MARKER } from "@/lib/withheld-value";
import type { WithheldParts } from "../design-run-seed";

/** Params follow the url they are parsed from, so a withheld url names only itself. */
function withheldPartNames({ url, params, body }: WithheldParts): string[] {
	return [url ? "URL" : params ? "params" : null, body ? "body" : null].filter(
		(name): name is string => name !== null
	);
}

export function WithheldValuesNotice({
	withheld,
	className,
}: {
	withheld: WithheldParts;
	className?: string;
}) {
	const names = withheldPartNames(withheld);
	if (names.length === 0) return null;

	return (
		<Callout severity="warning" title="Withheld values" className={className}>
			The engine withholds secrets from a stored run, so this run&apos;s {names.join(" and ")}{" "}
			holds <code>{WITHHELD_MARKER}</code> where one was. Sending this copy sends that text
			literally; replace it first.
		</Callout>
	);
}
