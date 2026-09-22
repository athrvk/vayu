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
 * Its own module because it once had two renderers - the schema explorer's
 * header and the Query pane's chip - and a second copy in one of them would be a
 * copy that does not receive the other's fixes; the two used to say the same
 * thing in different words from different panes, which is the split #455 was
 * filed about. The badge now renders once, in the Query header's schema control,
 * in the same place whether the explorer is open or shut (#1224). `BadgeText`,
 * the tier under it, still has other callers in the body.
 *
 * The sentence itself lives in `lib/graphql/schema-status.ts`, pure and beside
 * the store it reads.
 */

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { LabelSwap } from "@/components/ui";
import type { SchemaEntry } from "@/lib/graphql/schema-cache";
import { schemaStatusTitle } from "@/lib/graphql/schema-status";
import { cn } from "@/lib/utils";

export function BadgeText({
	className,
	title,
	slot,
	children,
}: {
	className: string;
	title: string;
	/** `data-slot`, for the badges a test has to address past their twins. */
	slot?: string;
	children: React.ReactNode;
}) {
	return (
		<span
			data-slot={slot}
			className={cn("flex items-center gap-1 text-micro font-semibold", className)}
			title={title}
		>
			{children}
		</span>
	);
}

/**
 * Every word this badge can say.
 *
 * The finite set is what makes the width reservation below correct, and there
 * being a finite set at all is why `LabelSwap` fits here and does not fit a
 * `TabCount` - see the `LabelSwap` paragraph in `docs/design-system.md`.
 */
const SCHEMA_WORDS = ["Schema", "Schema stale", "No schema"] as const;

type SchemaBadgeFace = {
	tone: string;
	word: (typeof SCHEMA_WORDS)[number];
	/** `null` for `idle` only: the slot stays, the glyph is what is absent. */
	glyph: React.ReactNode;
};

function schemaBadgeFace(entry: SchemaEntry | null): SchemaBadgeFace {
	const status = entry?.status ?? "idle";

	// No status has been established yet, and inventing one reads as a claim -
	// so this is the one face with no glyph and the neutral word.
	if (status === "idle") return { tone: "text-muted-foreground", word: "Schema", glyph: null };

	if (status === "loading") {
		return {
			tone: "text-muted-foreground",
			word: "Schema",
			glyph: <Loader2 className="size-icon-sm animate-spin" />,
		};
	}

	if (status === "ready") {
		return {
			tone: "text-success-text",
			word: "Schema",
			glyph: <CheckCircle2 className="size-icon-sm" />,
		};
	}

	/*
	 * A refresh that failed over a schema that loaded earlier is not "no schema":
	 * the editors still complete against the last good one, so the badge says it
	 * is stale rather than claiming there is nothing.
	 */
	if (entry?.schema) {
		return {
			tone: "text-warning-text",
			word: "Schema stale",
			glyph: <AlertCircle className="size-icon-sm" />,
		};
	}

	return {
		tone: "text-destructive-text",
		word: "No schema",
		glyph: <AlertCircle className="size-icon-sm" />,
	};
}

/**
 * What the schema is doing, in a badge that is always exactly as wide.
 *
 * **It used to change width four ways, and it is not alone in its row.**
 * `SchemaControls` puts the explorer toggle, this badge and Refresh in one
 * `flex` row - Refresh *after* the badge - and the row itself leads the Query
 * pane's header, with the pane title after it. So every state this badge took
 * moved the Refresh button: the idle face carried no glyph at all (`size-icon-sm`
 * plus the row's `gap-1`), and "Schema stale" and "No schema" are longer words
 * than "Schema". Pressing Refresh walks the badge idle/ready -> loading ->
 * ready, which is two width changes in a row, both of them sliding the button
 * out from under the pointer that just pressed it - and a user pressing it
 * twice hits the toggle beside it instead. `SchemaControls`' own doc comment
 * opens with "one row that does not move"; this is what makes that true.
 *
 * Two reservations, because there are two things that change. The glyph gets a
 * `MARK_SLOT`-style fixed box (`ui/tabs.tsx`) that is always there and empty for
 * `idle`, since a glyph is a mark that mounts. The word goes through
 * `LabelSwap`, which sizes its cell to the widest of `SCHEMA_WORDS` - the
 * `TabLabel` trick, and the right one here precisely because the set is three
 * known strings rather than a number.
 *
 * **Rendered unconditionally**, the contract `TabCount` states for the same
 * reason: it no longer returns `null` for `idle`, so no call site has to
 * remember a fallback, and the fallback the Query header used to hand-roll for
 * that case (a plain `Schema` label) is now this component's `idle` face.
 */
export function SchemaStatusBadge({ entry }: { entry: SchemaEntry | null }) {
	const { tone, word, glyph } = schemaBadgeFace(entry);

	return (
		<BadgeText slot="schema-status-badge" className={tone} title={schemaStatusTitle(entry)}>
			<span
				data-slot="schema-status-glyph"
				aria-hidden="true"
				className="grid size-icon-sm shrink-0 place-items-center"
			>
				{glyph}
			</span>
			<LabelSwap label={word} states={SCHEMA_WORDS} />
		</BadgeText>
	);
}

export default SchemaStatusBadge;
