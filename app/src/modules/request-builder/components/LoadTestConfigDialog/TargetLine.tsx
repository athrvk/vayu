/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { MethodBadge } from "@/components/shared";
import { truncateUrl } from "@/lib/truncate-url";
import type { Target } from "./target";

/** Fits the dialog's `max-w-xl` body at the mono size below. */
const URL_DISPLAY_CHARS = 64;

interface TargetLineProps {
	method?: string;
	/** The variable-resolved URL, as the run will send it. */
	url: string;
	target: Target;
}

/**
 * What the run is aimed at, said before the profile is configured (#2117). The
 * description line of the dialog: spans only, because it renders inside a `<p>`.
 */
export function TargetLine({ method, url, target }: TargetLineProps) {
	const shown = url.trim();
	return (
		<>
			<span className="flex min-w-0 items-center gap-2">
				{method && <MethodBadge method={method} />}
				{target.kind === "host" ? (
					<span className="min-w-0 truncate font-mono font-semibold text-foreground">
						{target.host}
					</span>
				) : (
					<span className="min-w-0 text-foreground">{unknownHostText(target)}</span>
				)}
			</span>
			{shown !== "" && (
				<span className="block truncate font-mono text-label" title={shown}>
					{truncateUrl(shown, URL_DISPLAY_CHARS)}
				</span>
			)}
		</>
	);
}

function unknownHostText({ variable }: Extract<Target, { kind: "unknown" }>) {
	if (variable === null) return "Host unknown";
	return (
		<>
			Host unknown: <span className="font-mono">{`{{${variable}}}`}</span> has no value in any
			scope.
		</>
	);
}
