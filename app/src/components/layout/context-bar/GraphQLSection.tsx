/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The glanceable half of GraphQL: is there a schema, how old is it, and what
 * does this document actually define.
 *
 * **Status here, browsing in the editor.** The bar clamps to 220-480px
 * (`layout-store`), which is enough for a freshness line and a short outline
 * and is not enough for a schema tree with docs - that is why the explorer
 * (#387 phase 1) docks beside the query editor instead. The split is the whole
 * design decision: at-a-glance state belongs in the bar, and browsing belongs
 * next to the cursor it inserts at.
 *
 * **The outline reads the stored request, not the editor's live buffer.** The
 * bar sits outside `RequestBuilderProvider`, so the in-flight draft is not
 * reachable from here; what it shows is the last saved document, which autosave
 * keeps a second or two behind the editor. Reaching into the builder for the
 * live buffer would mean a cross-module channel that does not exist yet, and
 * the section would not be worth it - the outline answers "what is in this
 * request", which does not change per keystroke.
 *
 * Like every section, this introspects nothing of its own: it renders whatever
 * the schema cache holds, and its Refresh is the store's own `refreshSchema` on
 * the target the request builder registered.
 */

import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useRequestQuery } from "@/queries";
import { TooltipIconButton } from "@/components/ui";
import { useSchemaCache } from "@/lib/graphql/schema-cache";
import { documentOutline, parseGraphQLBody } from "@/lib/graphql/graphql-body";
import { formatRelativeTime } from "@/utils/helpers";
import { cn } from "@/lib/utils";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";

/** The one-word state, and the colour that goes with it. */
const STATUS_LABEL = {
	idle: "Not loaded",
	loading: "Loading",
	ready: "Loaded",
	error: "Failed",
} as const;

export function GraphQLSection({ tab }: ContextBarSectionProps) {
	const { data: request, isLoading } = useRequestQuery(tab.entityId);
	const entry = useSchemaCache((s) => s.getActiveEntry());
	const activeTarget = useSchemaCache((s) => s.activeTarget);

	if (isLoading) return <SectionLoading />;
	if (!request || request.bodyType !== "graphql") {
		return <SectionEmpty>This request does not send a GraphQL body</SectionEmpty>;
	}

	const content = request.body.mode === "graphql" ? request.body.content : "";
	const operations = documentOutline(parseGraphQLBody(content).query);

	const status = entry?.status ?? "idle";
	const age = entry?.fetchedAt ? formatRelativeTime(entry.fetchedAt) : null;

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-1">
				<span
					className={cn(
						"flex items-center gap-1 text-xs",
						status === "ready" && "text-success-text",
						status === "error" &&
							(entry?.schema ? "text-warning-text" : "text-destructive-text"),
						(status === "idle" || status === "loading") && "text-muted-foreground"
					)}
				>
					{status === "loading" ? (
						<Loader2 className="w-3 h-3 animate-spin" />
					) : status === "ready" ? (
						<CheckCircle2 className="w-3 h-3" />
					) : status === "error" ? (
						<AlertCircle className="w-3 h-3" />
					) : null}
					Schema {STATUS_LABEL[status].toLowerCase()}
				</span>
				{activeTarget && (
					<TooltipIconButton
						label="Refresh schema"
						className="h-6 w-6 ml-auto"
						icon={<RefreshCw className="w-3.5 h-3.5" />}
						onClick={() => void useSchemaCache.getState().refreshSchema(activeTarget)}
					/>
				)}
			</div>

			{/*
			 * The age of the schema in hand, whatever the status says about the
			 * last attempt. A failed refresh over a schema that loaded earlier is
			 * not "no schema" - the editors still complete against it, and the age
			 * is the only thing that says how much to trust it.
			 */}
			{age && <p className="text-[11px] text-muted-foreground m-0">Fetched {age}</p>}
			{status === "error" && entry?.error && (
				<p className="text-[11px] text-warning-text m-0">{entry.error.message}</p>
			)}

			<p className="text-[11px] text-muted-foreground m-0 break-all">
				{request.url || "No URL"}
			</p>

			<div>
				<p className="text-[11px] text-muted-foreground m-0 mb-1">
					{operations.length === 0
						? "No operation in this document"
						: `${operations.length} ${operations.length === 1 ? "operation" : "operations"}`}
				</p>
				<ul className="list-none p-0 m-0 space-y-0.5">
					{operations.map((operation, index) => (
						<li
							key={`${operation.kind}:${operation.name ?? ""}:${index}`}
							className="text-[11px] font-mono truncate"
						>
							<span className="text-muted-foreground">{operation.kind} </span>
							{/* An anonymous operation is the shorthand `{ … }` form,
							    which is legal exactly when it is the only one. */}
							<span
								className={
									operation.name ? "text-foreground" : "text-muted-foreground"
								}
							>
								{operation.name ?? "(anonymous)"}
							</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}
