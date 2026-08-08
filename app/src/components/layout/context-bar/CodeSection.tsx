/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy this request as a runnable command.
 *
 * **Resolved is the default, and it is the differentiator.** The snippet is
 * generated from `POST /compose`'s output - the request with `{{variables}}`
 * substituted and `inherit` auth walked by the engine that will send it - so
 * what you paste into a terminal is what Vayu would put on the wire.
 * Template-based generators cannot promise that; they emit the request as
 * written, variables and all. Templated is still offered, because "the request
 * as written" is what you paste into a bug report.
 *
 * **Secrets are the leak vector here**, so resolved output is masked by
 * default and revealing is an explicit act. Masked values are every variable
 * the resolver marks secret plus the credential the auth mode carries - a
 * bearer token typed literally is exactly as sensitive as one that came from a
 * `{{token}}`.
 *
 * Composing happens when the section is expanded and when the user asks for it
 * again, never per keystroke: the section is only mounted while expanded (see
 * `Section.tsx`) and the query is `staleTime: Infinity` behind an explicit
 * refresh.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, Eye, EyeOff } from "lucide-react";
import { apiService } from "@/services/api";
import { queryKeys } from "@/queries/keys";
import { useRequestQuery, useCollectionAncestors } from "@/queries";
import { useSessionStore } from "@/stores";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	ToggleGroup,
	ToggleGroupItem,
	TooltipIconButton,
} from "@/components/ui";
import { TIMING } from "@/config/timing";
import { CODE_TARGETS, authSecrets, generateSnippet, type CodeTargetId } from "@/services/codegen";
import type { SnippetRequest } from "@/services/codegen";
import { SectionEmpty, SectionLoading } from "./Section";
import { templatedRequest } from "./templated-request";
import type { ContextBarSectionProps } from "./types";

type Mode = "resolved" | "templated";

export function CodeSection({ tab }: ContextBarSectionProps) {
	const [target, setTarget] = useState<CodeTargetId>("curl");
	const [mode, setMode] = useState<Mode>("resolved");
	const [revealed, setRevealed] = useState(false);
	const [copied, setCopied] = useState(false);

	const { data: request } = useRequestQuery(tab.entityId);
	const ancestors = useCollectionAncestors(request?.collectionId ?? null);
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	const composed = useQuery({
		queryKey: queryKeys.compose.forRequest(request?.id ?? "", activeEnvironmentId),
		queryFn: () =>
			apiService.composeRequest({
				requestId: request!.id,
				...(activeEnvironmentId ? { environmentId: activeEnvironmentId } : {}),
			}),
		enabled: mode === "resolved" && !!request?.id,
		// The request does not change under us while the bar is open - the user
		// asks for a recompose with the refresh button when they have edited it.
		staleTime: Infinity,
		retry: false,
	});

	if (!request) return <SectionEmpty>No request loaded</SectionEmpty>;

	const source: SnippetRequest | null =
		mode === "templated"
			? templatedRequest(request, ancestors)
			: ((composed.data as SnippetRequest | undefined) ?? null);

	const secrets = [
		...Object.values(getAllVariables())
			.filter((v) => v.secret)
			.map((v) => v.value),
		...authSecrets(source?.auth),
	];

	// Templated output holds `{{token}}`, not the value behind it, so there is
	// nothing to reveal and nothing to hide - the toggle would be a control that
	// changes nothing.
	const maskable = mode === "resolved";
	const snippet = source
		? generateSnippet(target, source, { secrets, mask: maskable && !revealed })
		: null;

	const handleCopy = async () => {
		if (!snippet) return;
		await navigator.clipboard.writeText(snippet.code);
		setCopied(true);
		setTimeout(() => setCopied(false), TIMING.STATUS_RESET_MS);
	};

	return (
		<div className="space-y-2">
			{/* A Select rather than a segmented control: `ToggleGroup` is an
			    `inline-flex` with no wrap, and five target names do not fit the
			    bar's 252px. The mode switch below stays a ToggleGroup - two
			    segments do fit, and both choices being visible is the point of
			    it. */}
			<Select value={target} onValueChange={(v) => setTarget(v as CodeTargetId)}>
				<SelectTrigger className="h-7 text-xs" aria-label="Snippet language">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{CODE_TARGETS.map((t) => (
						<SelectItem key={t.id} value={t.id} className="text-xs">
							{t.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<div className="flex items-center gap-1 flex-wrap">
				<ToggleGroup
					value={mode}
					onValueChange={(v) => v && setMode(v as Mode)}
					aria-label="Snippet values"
				>
					<ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
					<ToggleGroupItem value="templated">Templated</ToggleGroupItem>
				</ToggleGroup>
				{maskable && (
					<TooltipIconButton
						label={revealed ? "Hide secrets" : "Reveal secrets"}
						className="h-6 w-6"
						icon={
							revealed ? (
								<EyeOff className="w-3.5 h-3.5" />
							) : (
								<Eye className="w-3.5 h-3.5" />
							)
						}
						onClick={() => setRevealed((r) => !r)}
					/>
				)}
				{mode === "resolved" && (
					<TooltipIconButton
						label="Recompose"
						className="h-6 w-6"
						icon={<RefreshCw className="w-3.5 h-3.5" />}
						onClick={() => void composed.refetch()}
					/>
				)}
			</div>

			{mode === "resolved" && composed.isLoading && <SectionLoading />}
			{mode === "resolved" && composed.isError && (
				<SectionEmpty>
					Couldn't compose this request
					{composed.error instanceof Error ? `: ${composed.error.message}` : ""}
				</SectionEmpty>
			)}

			{snippet && (
				<>
					<div className="relative">
						<pre className="surface-sunken border border-rule rounded-md p-2 pr-8 text-[11px] font-mono whitespace-pre-wrap break-all overflow-x-auto m-0">
							{snippet.code}
						</pre>
						<div className="absolute top-1 right-1">
							<TooltipIconButton
								label="Copy snippet"
								className="h-6 w-6"
								icon={
									copied ? (
										<Check className="w-3.5 h-3.5 text-status-success-text" />
									) : (
										<Copy className="w-3.5 h-3.5" />
									)
								}
								onClick={() => void handleCopy()}
							/>
						</div>
					</div>
					{snippet.masked && (
						<p className="text-[11px] text-muted-foreground m-0">
							Secrets are hidden. Reveal them before running this.
						</p>
					)}
					{snippet.notes.map((note) => (
						<p key={note} className="text-[11px] text-muted-foreground m-0">
							{note}
						</p>
					))}
					{/*
					 * The jar is applied by libcurl at transfer time, so it is not in
					 * the composed payload and cannot be in the snippet. Saying so is
					 * the difference between a snippet that is incomplete and one that
					 * is wrong.
					 */}
					<p className="text-[11px] text-muted-foreground m-0">
						Cookies from the jar are attached when the request is sent and are not part
						of this snippet.
					</p>
				</>
			)}

			{mode === "templated" && !snippet && <SectionEmpty>Nothing to generate</SectionEmpty>}
		</div>
	);
}
