/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The first-run welcome: no collections and no runs. Not the shared `EmptyState` primitive: this is
 * the app's one branded screen, not a "nothing here" placeholder.
 *
 * Import leads: nobody adopts an API client from zero, they arrive carrying collections from
 * somewhere else, so naming the formats is the useful thing to say here.
 *
 * **`DemoApiTile` belongs here too, not only on the Launcher** (#1694). A workspace this empty has
 * no collection to hold a request, but `onNewRequest` creates one behind the scenes
 * (`WelcomeScreen.tsx`'s `useNewRequest`), so the tile's "click, then press the chord" works here
 * as well. Its own row, as on the Launcher: the two-tile grid above is icon-and-label only, with no
 * room for a chord hint.
 *
 * **The agent-connect row is this screen's alone** (#2122): MCP is a feature the user has to know
 * to look for, and a fresh install is the one moment the app has their attention; once a workspace
 * has content the Launcher keeps only the shared footer link. It opens Settings on the "AI agents
 * (MCP)" section rather than explaining anything here.
 */

import { Download, Plug, Plus } from "lucide-react";
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
	onConnectAgent: () => void;
}

export function FirstRunWelcome({
	onImport,
	onNewRequest,
	onOpenDemo,
	onConnectAgent,
}: FirstRunWelcomeProps) {
	return (
		// `enter-fade`: this replaces `LauncherSkeleton` on mount in a plain conditional swap with
		// no Radix `data-state` to key off, the shape `.enter-fade` exists for. `ErrorState`, the
		// sibling branch of the same swap, carries the class itself.
		<div className={`enter-fade flex flex-col gap-8 ${WELCOME_COLUMN}`}>
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<img src={iconUrl} alt="" className="h-6 w-6" />
					<h1 className="text-md font-semibold text-foreground">Vayu</h1>
				</div>
				<p className="text-sm text-muted-foreground">
					Send requests and run load tests on a fast native engine, with a built-in MCP
					server for coding agents, and your data stays on this machine.
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
						description="Start from an empty request, or paste a cURL command."
						onClick={onNewRequest}
					/>
				</div>
				<DemoApiTile onClick={onOpenDemo} />
				<ActionTile
					icon={Plug}
					label="Connect your coding agent"
					description="Let Claude Code, Cursor, or Codex send requests and run load tests through Vayu's MCP server."
					onClick={onConnectAgent}
				/>
			</section>

			<FooterLinks />
		</div>
	);
}
