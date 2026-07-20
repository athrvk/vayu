/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ActionTile
 *
 * One action on the welcome screen. `description` is passed only in the
 * first-run state — on the populated launcher the labels stand alone, since a
 * returning user does not need "Create your first API request" explained.
 */

import type { LucideIcon } from "lucide-react";

interface ActionTileProps {
	icon: LucideIcon;
	label: string;
	description?: string;
	onClick: () => void;
}

export function ActionTile({ icon: Icon, label, description, onClick }: ActionTileProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group flex flex-col items-start gap-2 rounded-md border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
			<span className="text-[13px] font-medium text-foreground">{label}</span>
			{description && (
				<span className="text-[13px] leading-snug text-muted-foreground">
					{description}
				</span>
			)}
		</button>
	);
}
