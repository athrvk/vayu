/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ExamplesPanel - the request's saved example responses (issue #481).
 *
 * These are what an importer found next to the request and, until the engine
 * had a table for them, threw away: Postman's saved responses, an OpenAPI
 * operation's documented ones. This is the first surface that shows they
 * survived the import, and once the mock server lands it is also the list of
 * what that server will answer with - the first row of a matched request being
 * the one it serves, which is why the stored order is preserved rather than
 * re-sorted here.
 *
 * Read-only in this phase. Examples arrive by import; nothing in the app
 * creates or edits one yet, so there is no editor to hang off these rows and no
 * mutation hook behind them.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ResponseBody, StatusCodeBadge } from "@/components/shared/response-viewer";
import { useRequestExamplesQuery } from "@/queries";
import { useRequestBuilderContext } from "../../../context";
import type { RequestExample } from "@/types";

/**
 * The header map `ResponseBody` reads, from the example's stored entries.
 *
 * Disabled rows are dropped and a repeated name keeps its last value: this map
 * exists only so the viewer can pick a renderer, and it is deliberately not the
 * copy shown to the user - `ExampleRow` lists the stored entries themselves, so
 * duplicates stay visible where they matter.
 */
function headerMap(example: RequestExample): Record<string, string> {
	const out: Record<string, string> = {};
	for (const header of example.headers) {
		if (header.enabled) out[header.key] = header.value;
	}
	if (example.contentType && !("Content-Type" in out)) out["Content-Type"] = example.contentType;
	return out;
}

function ExampleRow({ example }: { example: RequestExample }) {
	const [open, setOpen] = useState(false);
	const Chevron = open ? ChevronDown : ChevronRight;

	return (
		<div className="rounded-md border border-rule surface-card">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
			>
				<Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<StatusCodeBadge status={example.status} />
				<span className="truncate font-medium">{example.name}</span>
			</button>

			{open && (
				<div className="flex flex-col gap-3 border-t border-rule px-3 py-3">
					{example.headers.length > 0 && (
						<div className="flex flex-col gap-1">
							<div className="text-[11px] uppercase tracking-wide text-subtle-foreground">
								Headers
							</div>
							{example.headers.map((header, i) => (
								<div key={i} className="flex gap-2 font-mono text-[11px]">
									<span className="text-muted-foreground">{header.key}</span>
									<span className="truncate">{header.value}</span>
								</div>
							))}
						</div>
					)}
					<div className="h-64">
						<ResponseBody
							body={example.body}
							headers={headerMap(example)}
							showModeToggle={false}
							compact
						/>
					</div>
				</div>
			)}
		</div>
	);
}

export default function ExamplesPanel() {
	const { request } = useRequestBuilderContext();
	const { data: examples, isLoading, isError } = useRequestExamplesQuery(request.id ?? null);

	// An unsaved request has no id, so there is nothing stored to list - said
	// plainly rather than shown as an empty list, which would read as "this
	// request has no examples" for a request that cannot have any yet.
	if (!request.id) {
		return (
			<p className="text-xs text-muted-foreground">
				Save this request to see the example responses stored against it.
			</p>
		);
	}
	if (isLoading) {
		return <p className="text-xs text-muted-foreground">Loading examples…</p>;
	}
	if (isError) {
		return <p className="text-xs text-status-error-text">Could not load example responses.</p>;
	}
	if (!examples || examples.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No example responses. Importing a Postman collection with saved responses, or an
				OpenAPI spec that documents them, stores them here.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{examples.map((example) => (
				<ExampleRow key={example.id} example={example} />
			))}
		</div>
	);
}
