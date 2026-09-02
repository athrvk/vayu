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
 *   - The nearest ancestor (inclusive of this collection) that defines auth is
 *     the resolved source, unless an ancestor explicitly set to No Auth
 *     (`noauth`) blocks inheriting first - see `resolveAuthSource`.
 *   - The current collection is tagged THIS.
 *   - If a request explicitly overrides auth, that's noted in the row.
 */

import { Folder } from "lucide-react";
import { Eyebrow } from "@/components/ui";
import { useCollectionAncestors } from "@/queries/collections";
import { AUTH_MODE_LABELS } from "@/constants/auth-modes";
import { cn } from "@/lib/utils";
import { resolveAuthSource } from "@/modules/request-builder/utils/auth-resolution";
import type { Collection } from "@/types";

interface InheritanceChainProps {
	collectionId: string;
}

/**
 * The auth *type*, never its value.
 *
 * This cell is `shrink-0` - it is meant to hold a short constant, and the row's
 * name is what yields. It used to interpolate the credential itself
 * (`Bearer ${auth.token}`), so one imported JWT put several hundred unbreakable
 * mono characters into a flex child that had been told not to shrink: the row
 * pushed past the card's border and scrolled the whole tab sideways. It also put
 * the bearer token in plain sight in a summary panel that nobody opened to read
 * a secret.
 *
 * The request-side twin of this component (request-builder's
 * AuthInheritBanner) already does it this way - a bounded type label in the
 * chain row, with the credential shown separately and truncated.
 */
function describeAuth(c: Collection): string {
	const auth = c.auth;
	switch (auth.mode) {
		case "none":
			return AUTH_MODE_LABELS.none;
		// Named from the registry rather than restated, because the point of the
		// row is that this label differs from plain "No Auth": it blocks inheriting.
		case "noauth":
			return AUTH_MODE_LABELS.noauth;
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
			return AUTH_MODE_LABELS.none;
	}
}

export default function InheritanceChain({ collectionId }: InheritanceChainProps) {
	const ancestors = useCollectionAncestors(collectionId);

	if (ancestors.length === 0) return null;

	// Resolution walks leaf → root and picks the nearest collection that defines
	// auth (nested folders take precedence, i.e. closer to leaf wins), stopping at
	// one explicitly set to No Auth. Shared with what execution actually sends, so
	// this panel cannot claim a SOURCE the request would not use.
	const { source, blockedBy } = resolveAuthSource(ancestors);
	const sourceId = source?.id;

	return (
		<div className="mt-7 p-3.5 px-4 bg-card border border-border rounded-md">
			{/* Was a hand-typed copy of the eyebrow that had drifted to
			    `tracking-[0.07em]`. At 11px that is 0.11px per character - not a
			    deliberate variant, just a copy nobody could diff against the
			    original. */}
			<Eyebrow className="mb-2.5">Inheritance chain</Eyebrow>

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
							<span className="text-[10px] font-semibold bg-primary/10 text-primary px-1.5 py-px rounded-sm shrink-0">
								THIS
							</span>
						)}
						{isSource && !isThis && (
							<span className="text-[10px] font-semibold bg-primary/10 text-primary px-1.5 py-px rounded-sm shrink-0">
								SOURCE
							</span>
						)}
					</div>
				);
			})}

			{blockedBy && (
				<p className="mt-2.5 m-0 text-[11px] text-muted-foreground">
					<span className="font-mono">{blockedBy.name}</span> is set to No Auth, so
					requests below it inherit nothing.
				</p>
			)}
		</div>
	);
}
