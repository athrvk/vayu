/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Button } from "@/components/ui";
import { Callout } from "./Callout";

/**
 * A background change that arrived while a draft was dirty (`useEntityDraft`'s `externalValue`, and
 * the request builder's per-field merge, #1436). The surface never overwrites the edit; it shows
 * this, with "Take theirs" adopting the external value. Shared (first written for the collection
 * tabs, #1437), as the request builder needs the same notice and a second copy would drift.
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
