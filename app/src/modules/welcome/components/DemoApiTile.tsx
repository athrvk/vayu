/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DemoApiTile - "try sending a request" (issue #1694).
 *
 * The Launcher's Start grid is six equal-weight actions with no room for a
 * sentence, so this is its own row rather than a seventh tile squeezed into
 * that grid at a different height. Shown only while `runs.length === 0`
 * (`Launcher.tsx`) - once anything has been sent, the app has already
 * answered the question this row exists to answer, and it disappears without
 * a dismiss to click.
 *
 * Opens a real, pre-filled request (`DEMO_REQUEST_PRESET`) rather than
 * explaining Vayu in prose - the module's own README rules out marketing copy
 * here, and "click, then press the chord you'll use every day" teaches the
 * one interaction that matters more than any paragraph could.
 */

import { Zap } from "lucide-react";
import { Kbd } from "@/components/ui";
import { SEND_CHORD } from "@/constants/shortcuts";
import { chordKeys } from "@/lib/platform";

export function DemoApiTile({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Zap className="size-icon shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
			<span className="flex-1 text-sm font-medium text-foreground">Open Demo API</span>
			<span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
				{/* One `Kbd` per key, so the chord reads as the app's own everywhere
				    else it is shown - see the primitive's own doc comment. */}
				{chordKeys(SEND_CHORD).map((key) => (
					<Kbd key={key} size="sm">
						{key}
					</Kbd>
				))}
				<span>to send it</span>
			</span>
		</button>
	);
}
