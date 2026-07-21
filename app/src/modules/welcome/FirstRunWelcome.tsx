/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * FirstRunWelcome — first run, no collections and no runs.
 *
 * Distinct from the shared `EmptyState` primitive: this is the one branded
 * screen in the app, not a "nothing here" placeholder.
 *
 * Import leads. Nobody adopts an API client from zero; they arrive carrying
 * collections from somewhere else, so naming the formats is the useful thing to
 * say here. This is the only welcome state that carries branding.
 */

import { Download, Plus } from "lucide-react";
import iconUrl from "@shared/icon_png/vayu_icon_256x256.png";
import { ActionTile } from "./components/ActionTile";
import { FooterLinks } from "./components/FooterLinks";

interface FirstRunWelcomeProps {
	onImport: () => void;
	onNewRequest: () => void;
}

export function FirstRunWelcome({ onImport, onNewRequest }: FirstRunWelcomeProps) {
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<img src={iconUrl} alt="" className="h-6 w-6" />
					<span className="text-[15px] font-semibold text-foreground">Vayu</span>
				</div>
				<p className="text-[13px] text-muted-foreground">
					Send API requests, script them, and load test them from one place.
				</p>
			</div>

			<section>
				<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
					Start
				</p>
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
			</section>

			<FooterLinks />
		</div>
	);
}
