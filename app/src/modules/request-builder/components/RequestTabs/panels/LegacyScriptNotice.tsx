/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Shown instead of the inherited-scripts list for a run recorded **before** the engine joined
 * scripts: those runs stored one string with the chain's scripts glued to the request's own and no
 * boundaries, so the request's part cannot be recovered. It must be *shown*: the editor above is
 * seeded with `""` for such a run (`seedFromRun` fills it only from a part list that does not
 * exist), so without this the pane shows an empty script for a run that ran one, the "written but
 * never read" defect `CLAUDE.md` names. Renders nothing without a legacy string, as for every newer
 * run, so no empty box.
 */

import { Callout } from "@/components/shared";

/** Which script a run recorded before parts existed glued together. */
export type InheritedScriptVariant = "pre" | "post";

interface LegacyScriptNoticeProps {
	variant: InheritedScriptVariant;
	/** The whole glued string, exactly as the run recorded it. */
	script?: string;
}

const VARIANT_LABEL: Record<InheritedScriptVariant, string> = {
	pre: "pre-request script",
	post: "post-request script",
};

export default function LegacyScriptNotice({ variant, script }: LegacyScriptNoticeProps) {
	if (!script?.trim()) return null;

	return (
		<div className="enter-fade space-y-2">
			<Callout severity="warning" title="Recorded before scripts were split by origin">
				this run stored one {VARIANT_LABEL[variant]} with the collection's parts glued to
				the request's own, and nothing marks where each began - so they cannot be separated
				again. It is shown whole below and replayed whole. Saving to the request leaves
				scripts alone for this run.
			</Callout>

			{/*
			 * `surface-sunken` + `border-rule`, not `bg-muted/50` + `border-input`: on `--muted` no
			 * border token works (it sits between `--border` and `--border-strong` in dark, so one
			 * theme was wrong). The surface declares the `--rule` that reads on it.
			 */}
			<pre className="m-0 p-3 surface-sunken rounded-md border border-rule max-h-48 overflow-auto text-label font-mono leading-relaxed text-foreground whitespace-pre-wrap">
				{script}
			</pre>
		</div>
	);
}
