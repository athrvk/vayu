/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the engine did to a design send that its response does not show (issue
 * #3307): a jar cookie libcurl left off the `Cookie` line, a `Set-Cookie` it
 * discarded unread. One callout per warning, in the order the engine found
 * them; the sentence is the engine's own and names a cookie by name only.
 *
 * Silent for no warnings, which is every send that had nothing to report and
 * every exchange stored before the field. The response pane draws it as a band
 * above its tabs and a collection run's step card inside its expansion; a
 * streaming send is answered before the exchange runs and carries none.
 */

import { Callout } from "./Callout";
import { cn } from "@/lib/utils";
import type { ExchangeWarning } from "@/types/domain";

const TITLES: Record<string, string> = {
	cookie_not_sent: "A cookie did not fit the Cookie header",
	cookie_limit_reached: "Too many cookies for one request",
	cookie_dropped_oversized: "Response cookies were dropped as too large",
	cookie_dropped_too_many: "Response cookies were dropped as too many",
};

// The engine adds codes without the app learning them first; the sentence
// still reads, and a neutral title is better than a wrong one.
const FALLBACK_TITLE = "Note on this send";

export interface ExchangeWarningsProps {
	warnings: ExchangeWarning[] | undefined;
	className?: string;
}

export function ExchangeWarnings({ warnings, className }: ExchangeWarningsProps) {
	if (!warnings || warnings.length === 0) return null;

	return (
		<div className={cn("space-y-2", className)}>
			{warnings.map((warning, index) => (
				<Callout
					key={`${warning.code}-${index}`}
					severity="warning"
					title={TITLES[warning.code] ?? FALLBACK_TITLE}
				>
					{warning.message}
				</Callout>
			))}
		</div>
	);
}
