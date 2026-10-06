/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Save to request" for a run no saved request stands behind (issue #1817): an
 * agent's `send_request` runs inline and never touches the requests table, so
 * the run is the only record there is.
 *
 * Pure on purpose, like `save-run-to-request.ts` beside it: the view hands the
 * preset to `useNewRequest`, which owns where the request lands.
 */

import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { formatInstant, type FormatOptions } from "@/lib/time-value";
import { mcpClientDisplayName, UNNAMED_MCP_CLIENT } from "@/lib/mcp-client-names";
import type { RequestPreset } from "@/hooks/useNewRequest";
import type { Run } from "@/types";
import type { DesignRunSeed } from "./design-run-seed";
import { createFieldsFromRun } from "./save-run-to-request";

/**
 * Whether the run is one an agent sent and nothing saved - the only case this
 * flow is for. A run of the app's own, or a linked one, has a request to
 * write back to (or a deleted one, which is the user's to restore).
 */
export function isUnsavedAgentRun(run: Run): boolean {
	return run.origin?.kind === "mcp" && !run.requestId;
}

/**
 * The description stamped on the request a run is saved as, so the provenance
 * survives the save: `Saved from a run started by Claude Code on 10/5/26`.
 *
 * The product name, never the identifier the client sent, whenever the table
 * knows it - an identifier it does not know reads as sent, and an agent that
 * sent none is "an MCP client". The date is the day the run started, in the
 * app's one date format (`formatInstant`), not the day it was saved.
 */
export function savedFromRunDescription(run: Run, options: FormatOptions = {}): string {
	const client = mcpClientDisplayName(run.origin?.client);
	const who = client === UNNAMED_MCP_CLIENT ? `an ${UNNAMED_MCP_CLIENT}` : client;
	return `Saved from a run started by ${who} on ${formatInstant(run.startTime, "date", options)}`;
}

/**
 * The name a request saved from a run starts with: the one the agent gave it
 * when it was not the placeholder, else `METHOD url` without the query - which
 * can hold anything, and a name is shown on every surface. A url the engine
 * withheld names nothing, so the method alone stands in for it.
 */
export function requestNameFromRun(run: Run, seed: DesignRunSeed): string {
	const named = run.summary?.requestName?.trim();
	if (named && named !== DEFAULT_REQUEST_NAME) return named;
	const method = seed.request.method ?? "GET";
	const path = seed.withheld.url ? "" : (seed.request.url ?? "").split(/[?#]/)[0].trim();
	return path ? `${method} ${path}` : `${method} request`;
}

/** Everything `useNewRequest` needs to create the request this run describes. */
export function presetFromRun(
	run: Run,
	seed: DesignRunSeed,
	options: FormatOptions = {}
): RequestPreset {
	return {
		...createFieldsFromRun(seed),
		name: requestNameFromRun(run, seed),
		description: savedFromRunDescription(run, options),
	};
}
