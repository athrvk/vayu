/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LegacyScriptNotice
 *
 * Shown in place of the inherited-scripts list for a run recorded **before**
 * the engine took over joining scripts. Those runs stored one string with the
 * collection chain's scripts glued to the request's own and nothing marking the
 * boundaries, so the request's own part cannot be recovered from it.
 *
 * It has to be *shown*, not merely known about. The editor above it is seeded
 * with `""` for such a run, because `seedFromRun` can only fill it from a part
 * list that does not exist - so without this block the pane would show an empty
 * script box for a run that demonstrably ran a script, and the user would
 * conclude nothing ran. That is the "written but never read" defect
 * `CLAUDE.md` names as this codebase's most repeated, and it would have applied
 * to every design run in a user's history on the day they upgraded.
 *
 * Renders nothing when there is no legacy string, which is every run recorded
 * since - so it must not leave an empty box behind.
 */

import { Callout } from "@/components/shared";
import type { InheritedScriptVariant } from "./InheritedScriptsNotice";

interface LegacyScriptNoticeProps {
	variant: InheritedScriptVariant;
	/** The whole glued string, exactly as the run recorded it. */
	script?: string;
}

const VARIANT_LABEL: Record<InheritedScriptVariant, string> = {
	pre: "pre-request script",
	post: "test script",
};

export default function LegacyScriptNotice({ variant, script }: LegacyScriptNoticeProps) {
	if (!script?.trim()) return null;

	return (
		<div className="space-y-2">
			<Callout severity="warning" title="Recorded before scripts were split by origin">
				this run stored one {VARIANT_LABEL[variant]} with the collection's parts glued to
				the request's own, and nothing marks where each began - so they cannot be separated
				again. It is shown whole below and replayed whole. Saving to the request leaves
				scripts alone for this run.
			</Callout>

			<pre className="m-0 p-3 bg-muted/50 rounded-md border border-input max-h-48 overflow-auto text-[11px] font-mono leading-relaxed text-foreground whitespace-pre-wrap">
				{script}
			</pre>
		</div>
	);
}
