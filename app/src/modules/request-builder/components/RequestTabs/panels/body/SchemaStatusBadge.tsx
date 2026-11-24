/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The GraphQL body's one-line schema status, and the text tier the body's other badges build on. A
 * module of its own so no copy misses its fixes (#455). It renders once, in the Query header's
 * schema control, wherever the explorer is (#1224); `BadgeText` has other callers. The sentence is
 * `lib/graphql/schema-status.ts`, pure, beside the store it reads.
 */

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button, LabelSwap } from "@/components/ui";
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
 * Every word the badge can say. A finite set is what makes the width reservation below correct, and
 * why `LabelSwap` fits here but not `TabCount` (see `docs/design-system/motion.md`, `LabelSwap`).
 */
const SCHEMA_WORDS = ["Schema", "Schema stale", "No schema", "Load schema"] as const;

type SchemaBadgeFace = {
	tone: string;
	word: (typeof SCHEMA_WORDS)[number];
	/** `null` for `idle` only: the slot stays, the glyph is what is absent. */
	glyph: React.ReactNode;
};

function schemaBadgeFace(entry: SchemaEntry | null, awaitingLoad: boolean): SchemaBadgeFace {
	const status = entry?.status ?? "idle";

	// The action is the face while nothing loaded and the cache is holding off; once an entry says
	// anything else, that is the truth.
	if (awaitingLoad && status === "idle") {
		return { tone: "text-muted-foreground", word: "Load schema", glyph: null };
	}

	// No status yet, and inventing one reads as a claim: the one face with no glyph and a neutral
	// word.
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
	 * A failed refresh over an earlier schema is not "no schema": the editors still complete
	 * against the last good one, so the badge says stale.
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
 * The schema's state, in a badge of constant width. `SchemaControls` puts the explorer toggle, this
 * badge and Refresh in one row, Refresh *after* the badge, so any width change moves Refresh: the
 * idle face had no glyph, "Schema stale" and "No schema" are longer than "Schema", and a refresh
 * walks idle/ready -> loading -> ready, sliding the button from under the pointer, so a second
 * press hits the toggle. This is what makes `SchemaControls`' "one row that does not move" true.
 *
 * Two genuine reservations, not animations (unlike `TabCount`'s `MARK_TRACK` or the Dock's
 * `SaveStatusLine`): a track growing into place would still slide Refresh under a second click. The
 * glyph has a fixed `size-icon-sm` box, empty for `idle`; the word goes through `LabelSwap`, sized
 * to the widest of `SCHEMA_WORDS` (the `TabLabel` trick), right here because the set is four known
 * strings, not a number. **Rendered unconditionally**, `TabCount`'s contract: never `null` for
 * `idle`, so no call site needs a fallback.
 */
export function SchemaStatusBadge({
	entry,
	awaitingLoad = false,
	onLoad,
}: {
	entry: SchemaEntry | null;
	/**
	 * The cache declined to load this schema itself (an endpoint the user has not contacted): the
	 * badge says **Load schema** as a button running `onLoad`, its one target state; Refresh beside
	 * it stays the other way to ask.
	 */
	awaitingLoad?: boolean;
	onLoad?: () => void;
}) {
	const { tone, word, glyph } = schemaBadgeFace(entry, awaitingLoad);
	const face = (
		<>
			<span
				data-slot="schema-status-glyph"
				aria-hidden="true"
				className="grid size-icon-sm shrink-0 place-items-center"
			>
				{glyph}
			</span>
			<LabelSwap label={word} states={SCHEMA_WORDS} />
		</>
	);

	return (
		<BadgeText
			slot="schema-status-badge"
			className={tone}
			title={schemaStatusTitle(entry, awaitingLoad)}
		>
			{word === "Load schema" && onLoad ? (
				<Button
					variant="link"
					className="h-auto gap-1 p-0 text-micro font-semibold"
					onClick={onLoad}
				>
					{face}
				</Button>
			) : (
				face
			)}
		</BadgeText>
	);
}

export default SchemaStatusBadge;
