/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One action on the welcome screen. `description` is passed only on first run: a returning user
 * needs no "Create your first API request" explained.
 */

import type { LucideIcon } from "lucide-react";

interface ActionTileProps {
	icon: LucideIcon;
	label: string;
	description?: string;
	onClick: () => void;
}

/*
 * `onClick` is wrapped so the handler gets no arguments: given the click event, a handler whose
 * first parameter is optional data (`newRequest(preset?)`) would read the event as that.
 */
export function ActionTile({ icon: Icon, label, description, onClick }: ActionTileProps) {
	return (
		<button
			type="button"
			onClick={() => onClick()}
			className="group flex flex-col items-start gap-2 rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Icon className="size-icon text-muted-foreground transition-colors group-hover:text-primary" />
			<span className="text-sm font-medium text-foreground">{label}</span>
			{description && (
				<span className="text-sm leading-snug text-muted-foreground">{description}</span>
			)}
		</button>
	);
}
