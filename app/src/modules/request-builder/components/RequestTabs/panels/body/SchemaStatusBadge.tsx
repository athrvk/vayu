/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the GraphQL body says about the schema in one line, and the text tier the
 * body's other badges are built from.
 *
 * Its own module because two surfaces render it: the schema explorer's header,
 * which is where every schema affordance lives, and the Query pane's chip for
 * when the explorer is closed. A second copy in one of them would be a copy that
 * does not receive the other's fixes - and the two used to say the same thing in
 * different words from different panes, which is the split #455 was filed about.
 *
 * The sentence itself lives in `lib/graphql/schema-status.ts`, pure and beside
 * the store it reads.
 */

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { SchemaEntry } from "@/lib/graphql/schema-cache";
import { schemaStatusTitle } from "@/lib/graphql/schema-status";
import { cn } from "@/lib/utils";

export function BadgeText({
	className,
	title,
	children,
}: {
	className: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<span
			className={cn("flex items-center gap-1 text-[10px] font-semibold", className)}
			title={title}
		>
			{children}
		</span>
	);
}

export function SchemaStatusBadge({ entry }: { entry: SchemaEntry | null }) {
	const status = entry?.status ?? "idle";
	// No status has been established yet, and inventing one reads as a claim.
	if (status === "idle") return null;

	const title = schemaStatusTitle(entry);

	if (status === "loading") {
		return (
			<BadgeText className="text-muted-foreground" title={title}>
				<Loader2 className="w-3 h-3 animate-spin" />
				Schema
			</BadgeText>
		);
	}

	if (status === "ready") {
		return (
			<BadgeText className="text-success-text" title={title}>
				<CheckCircle2 className="w-3 h-3" />
				Schema
			</BadgeText>
		);
	}

	/*
	 * A refresh that failed over a schema that loaded earlier is not "no schema":
	 * the editors still complete against the last good one, so the badge says it
	 * is stale rather than claiming there is nothing.
	 */
	if (entry?.schema) {
		return (
			<BadgeText className="text-warning-text" title={title}>
				<AlertCircle className="w-3 h-3" />
				Schema stale
			</BadgeText>
		);
	}

	return (
		<BadgeText className="text-destructive-text" title={title}>
			<AlertCircle className="w-3 h-3" />
			No schema
		</BadgeText>
	);
}

export default SchemaStatusBadge;
