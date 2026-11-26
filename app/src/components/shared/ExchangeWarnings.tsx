/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the engine did to a design send that its response does not show (#3307): a jar cookie
 * libcurl left off `Cookie`, a `Set-Cookie` it discarded. One callout per warning in the engine's
 * order, the engine's sentence, naming a cookie by name only. Silent with none, including every
 * exchange stored before the field. The response pane draws it above its tabs, a collection run's
 * step card in its expansion. A stream's `202` carries none, so they appear when the stream ends
 * and the pane takes the stored trace (#3315).
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

// The engine adds codes the app has not learned; the sentence still reads, and a neutral title
// beats a wrong one.
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
