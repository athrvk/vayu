/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AuthInheritBanner
 *
 * Shown in the request AuthPanel when authType === "inherit". Walks the
 * ancestor chain of the request's collection, finds the nearest collection
 * with auth.mode !== "none", and renders:
 *   - a summary line: effective auth type + resolved source name
 *   - the ancestor chain root → leaf with a SOURCE tag on the resolved row
 *   - `{{variable}}` references in the accent color
 *
 * Per handoff §"Auth inherit resolution banner".
 */

import { Folder, Info, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCollectionAncestors } from "@/queries/collections";
import type { Collection } from "@/types";
import { VARIABLE_SPLIT_PATTERN, isVariableToken } from "@/constants/variables";

interface AuthInheritBannerProps {
	collectionId: string | null | undefined;
}

function describeAuth(c: Collection): { label: string; secret: string | null } {
	const auth = c.auth;
	switch (auth.mode) {
		case "none":
			return { label: "No Auth", secret: null };
		case "bearer":
			return { label: "Bearer Token", secret: auth.token || null };
		case "basic":
			return { label: "Basic Auth", secret: auth.username || null };
		case "apikey":
			return { label: "API Key", secret: auth.key || null };
		case "oauth2":
		case "digest":
		case "aws":
		case "ntlm":
			return { label: auth.mode.toUpperCase(), secret: null };
		default:
			return { label: "No Auth", secret: null };
	}
}

function renderWithVariables(text: string) {
	return text.split(VARIABLE_SPLIT_PATTERN).map((part, i) =>
		isVariableToken(part) ? (
			<span key={i} className="text-variable font-mono">
				{part}
			</span>
		) : (
			<span key={i}>{part}</span>
		)
	);
}

export default function AuthInheritBanner({ collectionId }: AuthInheritBannerProps) {
	const ancestors = useCollectionAncestors(collectionId ?? null);

	if (!collectionId) {
		return (
			<div className="flex items-start gap-2 p-3 rounded-md border border-border bg-card text-xs text-muted-foreground">
				<Info className="w-3.5 h-3.5 shrink-0 mt-px" />
				<p className="m-0 leading-relaxed">
					This request isn't in a collection, so there's nothing to inherit from.{" "}
					<span className="text-foreground">No auth will be sent.</span>
				</p>
			</div>
		);
	}

	// Nearest non-none ancestor wins (leaf-closest precedence per data-model PRD).
	const source = [...ancestors].reverse().find((c) => c.auth.mode !== "none") ?? null;

	if (!source) {
		return (
			<div className="flex items-start gap-2 p-3 rounded-md border border-border bg-card text-xs text-muted-foreground">
				<Lock className="w-3.5 h-3.5 shrink-0 mt-px" />
				<p className="m-0 leading-relaxed">
					No ancestor collection defines auth - this request will send{" "}
					<span className="text-foreground font-medium">no authentication</span>.
				</p>
			</div>
		);
	}

	const { label: authLabel, secret } = describeAuth(source);

	return (
		<div className="rounded-md border border-primary/30 bg-primary/10">
			{/* Summary */}
			<div className="flex items-start gap-2 px-3 py-2.5 border-b border-primary/20">
				<Info className="w-3.5 h-3.5 text-primary shrink-0 mt-px" />
				<div className="flex-1 min-w-0">
					<p className="m-0 text-xs leading-relaxed text-foreground">
						Inheriting <span className="font-semibold text-primary">{authLabel}</span>{" "}
						from <span className="font-mono font-medium">{source.name}</span>.
					</p>
					{secret && (
						<p className="mt-1 m-0 text-[11px] text-muted-foreground font-mono truncate">
							{renderWithVariables(secret)}
						</p>
					)}
				</div>
			</div>

			{/* Chain */}
			<div className="px-3 py-2">
				<div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground mb-1.5">
					Resolution chain
				</div>
				{ancestors.map((c, i) => {
					const isSource = c.id === source.id;
					const isLast = i === ancestors.length - 1;
					const indent = i * 12;
					const { label } = describeAuth(c);

					return (
						<div
							key={c.id}
							className={cn(
								"flex items-center gap-2 py-1",
								!isLast && "border-b border-primary/10"
							)}
						>
							<span
								style={{ paddingLeft: indent }}
								className="flex items-center gap-1.5 flex-1 min-w-0"
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
										isSource
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
								{label}
							</span>

							{isSource && (
								<span className="text-[10px] font-bold bg-primary/15 text-primary px-1.5 py-px rounded-sm shrink-0">
									SOURCE
								</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
