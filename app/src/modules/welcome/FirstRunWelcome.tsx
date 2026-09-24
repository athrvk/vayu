/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * FirstRunWelcome - first run, no collections and no runs.
 *
 * Distinct from the shared `EmptyState` primitive: this is the one branded
 * screen in the app, not a "nothing here" placeholder.
 *
 * Import leads. Nobody adopts an API client from zero; they arrive carrying
 * collections from somewhere else, so naming the formats is the useful thing to
 * say here. This is the only welcome state that carries branding.
 *
 * **`DemoApiTile` belongs here too, not just on the Launcher.** The
 * Launcher's own copy was scoped to "the Launcher is the end state" (issue
 * #1694), but a workspace this empty has no collection to hold a manually
 * created request either - `onNewRequest` already creates one behind the
 * scenes (see `WelcomeScreen.tsx`'s `useNewRequest`), so the demo tile's
 * "click, then press the chord" pitch is exactly as available on this screen
 * as it is once the Launcher takes over. Its own row for the same reason as
 * the Launcher's: the two-tile grid above is icon-and-label only, with no
 * room for a chord hint.
 */

import { Download, Plus } from "lucide-react";
import { Eyebrow } from "@/components/ui";
import iconUrl from "@shared/icon_png/vayu_icon_256x256.png";
import { ActionTile } from "./components/ActionTile";
import { DemoApiTile } from "./components/DemoApiTile";
import { FooterLinks } from "./components/FooterLinks";
import { WELCOME_COLUMN } from "./welcome-column";

interface FirstRunWelcomeProps {
	onImport: () => void;
	onNewRequest: () => void;
	onOpenDemo: () => void;
}

export function FirstRunWelcome({ onImport, onNewRequest, onOpenDemo }: FirstRunWelcomeProps) {
	return (
		// `enter-fade`: this replaces `LauncherSkeleton` on mount, a plain
		// conditional swap with no Radix `data-state` to key off, the shape
		// `.enter-fade` exists for. Without it the branded pitch popped in a
		// frame after the skeleton's own bars, while `ErrorState` - the sibling
		// branch for the same swap - already fades (it carries the class itself).
		<div className={`enter-fade flex flex-col gap-8 ${WELCOME_COLUMN}`}>
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<img src={iconUrl} alt="" className="h-6 w-6" />
					<span className="text-md font-semibold text-foreground">Vayu</span>
				</div>
				<p className="text-sm text-muted-foreground">
					Send API requests, script them, and run load tests against them from one place.
				</p>
			</div>

			<section className="flex flex-col gap-2">
				<Eyebrow>Start</Eyebrow>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<ActionTile
						icon={Download}
						label="Import a collection"
						description="Bring in what you already have from Postman, Insomnia, or OpenAPI."
						onClick={onImport}
					/>
					<ActionTile
						icon={Plus}
						label="New request"
						description="Start from an empty request and send it."
						onClick={onNewRequest}
					/>
				</div>
				<DemoApiTile onClick={onOpenDemo} />
			</section>

			<FooterLinks />
		</div>
	);
}
