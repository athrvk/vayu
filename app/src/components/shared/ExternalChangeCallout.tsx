/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Button } from "@/components/ui";
import { Callout } from "./Callout";

/**
 * A background change that arrived while a draft was dirty - see
 * `useEntityDraft`'s `externalValue`, and the request builder's own per-field
 * merge (issue #1436). The surface never overwrites the in-progress edit;
 * this is what it shows instead, with a "Take theirs" action that adopts the
 * external value.
 *
 * Shared rather than collection-tab-local (it started in
 * `CollectionDetail/shared.tsx` for #1437): the request builder needs the
 * same notice for the same reason, and a second copy would be the "written
 * but never read" style drift CLAUDE.md warns about, just for a component
 * instead of a field.
 */
export function ExternalChangeCallout({
	what,
	onTakeTheirs,
	className,
}: {
	/** Named in the title, e.g. "name", "description", "the script", "auth". */
	what: string;
	onTakeTheirs: () => void;
	/** Spacing is the caller's. */
	className?: string;
}) {
	return (
		<Callout
			severity="warning"
			title={`Changed elsewhere: ${what}`}
			className={className}
			action={
				<Button variant="outline" size="sm" onClick={onTakeTheirs}>
					Take theirs
				</Button>
			}
		>
			Someone else changed this while you were editing. Your edit is kept until you choose.
		</Callout>
	);
}
