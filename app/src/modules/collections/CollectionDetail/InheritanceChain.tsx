/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * InheritanceChain
 *
 * Renders the root→leaf ancestor chain for a collection and indicates which
 * ancestor's auth would be inherited if a descendant request used
 * `Inherit from collection`.
 *
 * Rules:
 *   - The nearest ancestor (inclusive of this collection) with auth.mode !== "none"
 *     is the resolved source.
 *   - The current collection is tagged THIS.
 *   - If a request explicitly overrides auth, that's noted in the row.
 */

import { Folder } from "lucide-react";
import { useCollectionAncestors } from "@/queries/collections";
import { cn } from "@/lib/utils";
import type { Collection } from "@/types";

interface InheritanceChainProps {
	collectionId: string;
}

/**
 * The auth *type*, never its value.
 *
 * This cell is `shrink-0` — it is meant to hold a short constant, and the row's
 * name is what yields. It used to interpolate the credential itself
 * (`Bearer ${auth.token}`), so one imported JWT put several hundred unbreakable
 * mono characters into a flex child that had been told not to shrink: the row
 * pushed past the card's border and scrolled the whole tab sideways. It also put
 * the bearer token in plain sight in a summary panel that nobody opened to read
 * a secret.
 *
 * The request-side twin of this component (request-builder's
 * AuthInheritBanner) already does it this way — a bounded type label in the
 * chain row, with the credential shown separately and truncated.
 */
function describeAuth(c: Collection): string {
	const auth = c.auth;
	switch (auth.mode) {
		case "none":
			return "No Auth";
		case "bearer":
			return "Bearer Token";
		case "basic":
			return "Basic Auth";
		case "apikey":
			return "API Key";
		case "oauth2":
			return "OAuth 2.0";
		case "digest":
		case "aws":
		case "ntlm":
			return auth.mode.toUpperCase();
		default:
			return "No Auth";
	}
}

export default function InheritanceChain({ collectionId }: InheritanceChainProps) {
	const ancestors = useCollectionAncestors(collectionId);

	if (ancestors.length === 0) return null;

	// Resolution walks root → leaf and picks the nearest non-none auth (handoff
	// says nested folders take precedence, i.e. closer to leaf wins).
	const sourceId = [...ancestors].reverse().find((c) => c.auth.mode !== "none")?.id;

	return (
		<div className="mt-7 p-3.5 px-4 bg-card border border-border rounded-md">
			<div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-2.5">
				Inheritance chain
			</div>

			{ancestors.map((c, i) => {
				const isThis = c.id === collectionId;
				const isSource = c.id === sourceId;
				const isLast = i === ancestors.length - 1;
				const indent = i * 14;

				return (
					<div
						key={c.id}
						className={cn(
							"flex items-center gap-2 py-1.5",
							!isLast && "border-b border-border"
						)}
					>
						<span
							style={{ paddingLeft: indent }}
							className="flex items-center gap-2 flex-1 min-w-0"
						>
							<Folder
								className={cn(
									"w-3 h-3 shrink-0",
									isSource ? "text-primary" : "text-muted-foreground"
								)}
							/>
							<span
								className={cn(
									"text-[11px] font-mono truncate",
									isThis
										? "text-foreground font-semibold"
										: "text-muted-foreground"
								)}
							>
								{c.name}
							</span>
						</span>

						<span
							className={cn(
								"text-[10px] font-mono shrink-0",
								isSource ? "text-primary" : "text-muted-foreground"
							)}
						>
							{describeAuth(c)}
						</span>

						{isThis && (
							<span className="text-[10px] font-bold bg-primary/10 text-primary px-1.5 py-px rounded-sm shrink-0">
								THIS
							</span>
						)}
						{isSource && !isThis && (
							<span className="text-[10px] font-bold bg-primary/10 text-primary px-1.5 py-px rounded-sm shrink-0">
								SOURCE
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}
