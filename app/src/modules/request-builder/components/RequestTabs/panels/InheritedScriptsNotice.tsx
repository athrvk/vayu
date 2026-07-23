/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * InheritedScriptsNotice
 *
 * Shown in PreScriptPanel and TestScriptPanel. Walks the ancestor chain of
 * the request's collection (root first, via `useCollectionAncestors` - the
 * same hook `AuthInheritBanner` uses for auth) and lists every collection
 * that carries a non-empty script of the given kind - the ones that will run
 * before the request's own. Read-only: it reports what will run, it edits
 * nothing.
 *
 * Renders nothing when no collection in the chain has a script of that kind.
 * That is most requests, so it must not leave an empty box behind.
 *
 * `entries` lets a caller supply the parts directly instead of reading the
 * live chain: a later view shows a past run, and that run's collection
 * scripts come from what was stored with it, not from `useCollectionAncestors`
 * (the live chain may have changed, or the request may no longer exist). When
 * `entries` is passed it wins outright and the hook is not consulted for
 * rendering - only `origin === "collection"` entries are shown either way, so
 * a caller that hands back the full script-part list (including the
 * request's own part) does not duplicate what the editor above already shows.
 */

import { Folder, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCollectionAncestors } from "@/queries/collections";
import type { Collection, ScriptPart } from "@/types";

export type InheritedScriptVariant = "pre" | "post";

interface InheritedScriptsNoticeProps {
	/** Which script field to look at: the pre-request one or the test one. */
	variant: InheritedScriptVariant;
	/** The request's own collection - root of the chain to walk. Ignored when `entries` is passed. */
	collectionId?: string | null;
	/** Script parts to render directly, bypassing `useCollectionAncestors` - e.g. from a stored run. */
	entries?: ScriptPart[];
}

const VARIANT_LABEL: Record<InheritedScriptVariant, string> = {
	pre: "pre-request script",
	post: "test script",
};

function scriptFor(collection: Collection, variant: InheritedScriptVariant): string {
	return variant === "pre" ? collection.preRequestScript : collection.postRequestScript;
}

function entriesFromChain(chain: Collection[], variant: InheritedScriptVariant): ScriptPart[] {
	return chain
		.filter((c) => scriptFor(c, variant).trim().length > 0)
		.map((c) => ({
			origin: "collection" as const,
			id: c.id,
			name: c.name,
			script: scriptFor(c, variant),
		}));
}

export default function InheritedScriptsNotice({
	variant,
	collectionId,
	entries,
}: InheritedScriptsNoticeProps) {
	// Only resolve the live chain when nothing was supplied - passing `null`
	// when `entries` is present skips the lookup rather than resolving a chain
	// nobody will render.
	const ancestors = useCollectionAncestors(entries ? null : collectionId);
	const source = entries ?? entriesFromChain(ancestors, variant);
	const rows = source.filter((e) => e.origin === "collection");

	if (rows.length === 0) return null;

	const label = VARIANT_LABEL[variant];

	return (
		<div className="rounded-md border border-primary/30 bg-primary/10">
			<div className="flex items-start gap-2 px-3 py-2.5 border-b border-primary/20">
				<Info className="w-3.5 h-3.5 text-primary shrink-0 mt-px" />
				<p className="m-0 text-xs leading-relaxed text-foreground">
					{rows.length === 1 ? "A collection" : `${rows.length} collections`} will run a{" "}
					<span className="font-semibold text-primary">{label}</span> before your own.
				</p>
			</div>

			<div className="px-3 py-2">
				<div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-1.5">
					Runs before your own
				</div>
				{rows.map((entry, i) => (
					<div
						key={entry.id ?? entry.name ?? i}
						className={cn(
							"flex items-center gap-2 py-1",
							i !== rows.length - 1 && "border-b border-primary/10"
						)}
					>
						<Folder className="w-3 h-3 shrink-0 text-primary" />
						<span className="text-[11px] font-mono truncate text-foreground font-semibold">
							{entry.name}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
