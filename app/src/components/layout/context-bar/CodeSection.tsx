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
 * A request a pre-request script runs before composes with its `{{templates}}`
 * intact (#2521), so a `{{token}}` in the resolved snippet is not a failure to
 * resolve; the engine lists the names as `deferredVariables` and a note under
 * the snippet says the script sets them at send.
 *
 * **Secrets are the leak vector here**, so resolved output is masked by
 * default and revealing is an explicit act. Masked values are every variable
 * the resolver marks secret plus the credential the auth mode carries - a
 * bearer token typed literally is exactly as sensitive as one that came from a
 * `{{token}}`.
 *
 * **It composes the editor, not the saved row** (#2638), the way Send does:
 * see `code-composition.ts`. Templated mode stays on the saved row - there is
 * no RequestState-to-Request mapping to feed it the draft without a second
 * field list - and both saved-row cases say so under the snippet.
 *
 * Composing happens when the section is expanded, when the user asks for it
 * again, when a builder takes the request on (a new key), and when a committed
 * write (the renderer's own PUT or an MCP agent's) lands on this request, never
 * per keystroke: the section is only mounted while expanded (see `Section.tsx`)
 * and the query is `staleTime: Infinity` behind an explicit refresh or an
 * invalidation (see `queries/compose-invalidation.ts`). The autosave PUT's
 * invalidation runs the same query function, which reads the draft again, so
 * an editor-composed snippet follows the editor to within the autosave delay.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, Eye, EyeOff } from "lucide-react";
import { queryKeys } from "@/queries/keys";
import { useRequestQuery, useCollectionAncestors } from "@/queries";
import { useSessionStore } from "@/stores";
import { useLiveCommandSurfaceStore } from "@/lib/commands/live-surfaces";
import { useCopy } from "@/hooks/useCopy";
import { pickByCount } from "@/modules/dashboard/utils/format";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import {
	ICON_MOTION,
	IconSwap,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	ToggleGroup,
	ToggleGroupItem,
	TooltipIconButton,
} from "@/components/ui";
import {
	CODE_TARGETS,
	collectSecrets,
	generateSnippet,
	type CodeTargetId,
} from "@/services/codegen";
import type { SnippetRequest } from "@/services/codegen";
import { SectionEmpty, SectionLoading } from "./Section";
import { composeForCode } from "./code-composition";
import { templatedRequest } from "./templated-request";
import type { ContextBarSectionProps } from "./types";

type Mode = "resolved" | "templated";

/** Shown under a snippet built from the saved row, which trails the editor. */
const SAVED_ROW_NOTE = "From the saved request. Unsaved changes are not in this snippet.";

/**
 * Names the tokens left written in a resolved snippet because a pre-request
 * script runs before the send (#2521), so a `{{token}}` in the command reads as
 * deliberate rather than as a variable that failed to resolve.
 */
function deferredNote(names: string[]): string {
	const tokens = names.map((name) => `{{${name}}}`).join(", ");
	return pickByCount(names.length, {
		one: `${tokens} is set by a pre-request script at send.`,
		other: `${tokens} are set by a pre-request script at send.`,
	});
}

export function CodeSection({ tab }: ContextBarSectionProps) {
	const [target, setTarget] = useState<CodeTargetId>("curl");
	const [mode, setMode] = useState<Mode>("resolved");
	const [revealed, setRevealed] = useState(false);
	const { copy, copied } = useCopy({ feedback: "icon" });

	const { data: request } = useRequestQuery(tab.entityId);
	const ancestors = useCollectionAncestors(request?.collectionId ?? null);
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	const requestId = request?.id ?? "";
	// Flips when a builder takes this request on or lets it go, not per keystroke:
	// the slot is rewritten only when the builder's request id changes.
	const editorHeld = useLiveCommandSurfaceStore(
		(s) => !!requestId && s.editorDraft?.requestId === requestId
	);

	const composed = useQuery({
		queryKey: queryKeys.compose.forRequest(
			requestId,
			activeEnvironmentId,
			editorHeld ? "editor" : "saved"
		),
		queryFn: () => composeForCode(requestId, activeEnvironmentId),
		enabled: mode === "resolved" && !!requestId,
		// Never refetched on its own: a compose is a round trip, and the section
		// would otherwise pay one per keystroke behind it (#1310). It is refreshed
		// by an explicit act instead - the user's refresh button, or an
		// invalidation from a committed write, the renderer's own PUT or an MCP
		// agent's, to this request, its collection chain, an environment or the
		// globals (`invalidateCompositions`, #1438, #1877). `invalidateQueries`
		// refetches a mounted observer whatever its `staleTime`, so this value
		// gates the cost without gating correctness.
		staleTime: Infinity,
		// The section only mounts while expanded, so this is one compose per
		// expand, not per keystroke. A snippet cached from the editor goes stale
		// at the next edit until autosave invalidates it; recomposing on mount
		// keeps a collapse, edit, re-expand from serving it unlabelled.
		refetchOnMount: editorHeld ? "always" : true,
		retry: false,
	});

	if (!request) return <SectionEmpty>No request loaded</SectionEmpty>;

	/*
	 * `stream` is laid over the composed payload rather than read out of it,
	 * because `POST /compose` deliberately does not carry the flag (see the
	 * `stream` column in engine types.hpp): a composed payload is handed
	 * straight to `/execute` by callers that would then get a `202` they never
	 * asked to parse. It comes from whatever the payload was composed from -
	 * the draft, or else the row - and the jar note below reads the same.
	 */
	const editorSettings = mode === "resolved" ? composed.data?.editorSettings : null;
	const settings = editorSettings ?? request;
	const source: SnippetRequest | null =
		mode === "templated"
			? templatedRequest(request, ancestors)
			: composed.data
				? { ...(composed.data.payload as SnippetRequest), stream: settings.stream }
				: null;

	const deferredVariables = (mode === "resolved" && composed.data?.deferredVariables) || [];

	const secrets = collectSecrets(getAllVariables(), source?.auth);

	// Templated output holds `{{token}}`, not the value behind it, so there is
	// nothing to reveal and nothing to hide - the toggle would be a control that
	// changes nothing.
	const maskable = mode === "resolved";
	const snippet = source
		? generateSnippet(target, source, { secrets, mask: maskable && !revealed })
		: null;

	const handleCopy = async () => {
		if (!snippet) return;
		await copy(snippet.code, "Snippet");
	};

	return (
		<div className="space-y-2">
			{/* A Select rather than a segmented control: `ToggleGroup` is an
			    `inline-flex` with no wrap, and five target names do not fit the
			    bar's 252px. The mode switch below stays a ToggleGroup - two
			    segments do fit, and both choices being visible is the point of
			    it. */}
			<Select value={target} onValueChange={(v) => setTarget(v as CodeTargetId)}>
				<SelectTrigger className="h-control-sm text-xs" aria-label="Snippet language">
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
						icon={
							revealed ? (
								<EyeOff className="size-icon-sm" />
							) : (
								<Eye className="size-icon-sm" />
							)
						}
						onClick={() => setRevealed((r) => !r)}
					/>
				)}
				{mode === "resolved" && (
					<TooltipIconButton
						label="Recompose"
						icon={
							<RefreshCw
								className="size-icon-sm"
								data-icon-motion={ICON_MOTION.spinOnce}
							/>
						}
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
						<pre className="surface-sunken border border-rule rounded-md p-2 pr-8 text-label font-mono whitespace-pre-wrap break-all overflow-x-auto m-0">
							{snippet.code}
						</pre>
						<div className="absolute top-1 right-1">
							<TooltipIconButton
								label="Copy snippet"
								icon={
									<IconSwap
										state={copied ? "copied" : "copy"}
										icons={{
											copy: <Copy className="size-icon-sm" />,
											copied: (
												<Check className="size-icon-sm text-status-success-text" />
											),
										}}
									/>
								}
								onClick={() => void handleCopy()}
							/>
						</div>
					</div>
					{!editorSettings && (
						<p className="text-label text-muted-foreground m-0">{SAVED_ROW_NOTE}</p>
					)}
					{snippet.masked && (
						<p className="text-label text-muted-foreground m-0">
							Secrets are hidden. Reveal them before running this.
						</p>
					)}
					{deferredVariables.length > 0 && (
						<p className="text-label text-muted-foreground m-0 break-words">
							{deferredNote(deferredVariables)}
						</p>
					)}
					{snippet.notes.map((note) => (
						<p key={note} className="text-label text-muted-foreground m-0">
							{note}
						</p>
					))}
					{/*
					 * The jar is applied by libcurl at transfer time, so it is not in
					 * the composed payload and cannot be in the snippet. Saying so is
					 * the difference between a snippet that is incomplete and one that
					 * is wrong - and a request that skips the jar (#1765) sends
					 * exactly what the snippet shows, so it says that instead.
					 */}
					<p className="text-label text-muted-foreground m-0">
						{settings.disableCookies
							? "The cookie jar is off for this request, so Vayu attaches no cookies beyond the headers shown."
							: "Cookies from the jar are attached when the request is sent and are not part of this snippet."}
					</p>
				</>
			)}

			{mode === "templated" && !snippet && <SectionEmpty>Nothing to generate</SectionEmpty>}
		</div>
	);
}
