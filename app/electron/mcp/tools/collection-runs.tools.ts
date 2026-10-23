/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file collection-runs.tools.ts
 * @brief Running a collection: the smoke matrix and the design-mode scenario run.
 */

import { z } from "zod";
import { checkComposedTarget, targetPolicyRefusal } from "../safety.js";
import { ENVIRONMENT_DEFAULT_SENTENCE, VARIABLE_RESOLUTION_URI } from "../variable-origins.js";
import { runOutputShape, withheldPointer } from "../withhold.js";
import type { EngineClient } from "../engine-client.js";
import type { McpTool } from "./contract.js";
import {
	engineErrorResult,
	errorResult,
	jsonResult,
	optionalOffset,
	optionalPageLimit,
	requireStr,
	str,
	structuredResult,
	ToolArgError,
	watchedRun,
	withCaveat,
} from "./kit.js";
import { asMcpSend, composeViaEngine, resolveEnvironmentId } from "./compose.js";
import {
	elementsTimersInput,
	ENGINE_DEFAULT_HEADERS_POINTER,
	failOnSchemaErrorInput,
	scenarioDataInput,
	dataFileNameInput,
	dataFileHashInput,
	dataFileCastNumbersInput,
	scenarioRecursiveInput,
	thresholdsInput,
} from "./input-schemas.js";
import {
	childCollectionNames,
	DEFAULT_SMOKE_LIMIT,
	MAX_SMOKE_LIMIT,
	readSchemaVerdict,
	readTestVerdict,
	smokeResultSchema,
	smokePageFields,
	smokeRowUrl,
	smokeScopeCaveat,
} from "./output-schemas.js";
import { startedRunNextStep } from "./run-status.js";
import { preflightScenarioSteps, scenarioBlock, walkCollectionRequests } from "./scenario-runs.js";

/** One saved request a smoke run sends, and - on a `recursive` run - the collections it sits under. */
interface SmokeTarget {
	item: unknown;
	folder?: string;
}

/** How a row's `folder` joins the collection names from the root down. */
const FOLDER_SEPARATOR = " / ";

/**
 * What a smoke run sends: the collection's direct requests, or - `recursive` -
 * the whole tree in the order `run_collection` runs it.
 */
async function smokeTargets(
	client: EngineClient,
	collectionId: string,
	recursive: boolean,
	signal?: AbortSignal
): Promise<SmokeTarget[]> {
	if (!recursive) {
		const direct = await client.listRequests(collectionId, signal);
		return (Array.isArray(direct) ? direct : []).map((item) => ({ item }));
	}
	const walked = await walkCollectionRequests(client, collectionId, true, signal);
	return walked.map(({ request, folder }) => ({
		item: request,
		folder: folder.join(FOLDER_SEPARATOR),
	}));
}

export const COLLECTION_RUN_TOOLS: McpTool[] = [
	{
		name: "run_collection_smoke",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description: (config) =>
			"Execute a collection's own saved requests once each and return a pass/fail matrix (a request passes on a 2xx/3xx status with all its tests passing and, when the collection is bound to an OpenAPI document, a response matching the schema that document declares - a response the document declares no schema for is reported as unchecked and never fails the request; pass failOnSchemaError: false to keep that verdict on every row without letting it decide pass/fail). A row whose request ran assertions carries `tests` - `total`, `failed`, and the failing `name: message` lines (at most 10; `failed` is the true count) - so a request that failed on its tests says which, not just ok:false. Scope is the collection's DIRECT requests, and the result discloses the sub-collections left out; `recursive: true` runs them too (an OpenAPI import files its operations there). Requests run one at a time, so a collection takes as long as its requests added together: past about 25 requests or on a slow API use run_collection (one stored run with a run id, `recursive` available, read with get_run_report), and keep this for a bounded pass/fail matrix. Runs 25 requests a call by default (`limit`, max 100): page with `offset` from the result's `next` (a collection edited between pages shifts the window). Reports progress when the client asks. Each request is composed exactly as the app would send it: {{variables}} resolved in the order " +
			VARIABLE_RESOLUTION_URI +
			" states, the request's stored auth applied (inheriting from the collection chain, incl. OAuth2), and its collection-chain + own pre/post scripts run. Each request's resolved host must be on the allowlist; requests whose host still cannot be verified (e.g. a variable did not resolve and allow-all is off) are skipped. Sends real traffic and, as the app's Send does, saves back any variables its scripts or extractors set (environment, globals, collection variables); it changes no other Vayu data. " +
			ENGINE_DEFAULT_HEADERS_POINTER +
			" There is no `disabledDefaultHeaders` here: each saved request is replayed exactly as stored." +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Run collection smoke test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests to run."),
			environmentId: z
				.string()
				.optional()
				.describe(
					`Environment whose variables resolve {{templates}} in every request, and whose cookie jar they share. ${ENVIRONMENT_DEFAULT_SENTENCE}`
				),
			recursive: z
				.boolean()
				.optional()
				.describe("Also run sub-collections; each row names its `folder`."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_SMOKE_LIMIT)
				.optional()
				.describe(
					`Requests to run this call (default ${DEFAULT_SMOKE_LIMIT}, max ${MAX_SMOKE_LIMIT}). A larger value is refused.`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Requests to skip, for paging (default 0). Pass `next.offset` from the last result."
				),
			failOnSchemaError: failOnSchemaErrorInput({
				unit: "request",
				defaultsOn: true,
				guidance:
					"Set false to report the schema verdict on each row without letting it decide pass/fail - useful against a document known to lag its API.",
			}),
		},
		outputSchema: smokeResultSchema,
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			// Absent means the gate stays on - this tool's behaviour since #681.
			// Read once, before any traffic: it decides how every row is judged,
			// and a per-row read of one argument could only ever be wrong twice.
			const failOnSchemaError = args.failOnSchemaError !== false;
			const recursive = args.recursive === true;
			// Refused before any traffic, like every bound in this registry.
			const limit = optionalPageLimit(args, "limit", DEFAULT_SMOKE_LIMIT, MAX_SMOKE_LIMIT);
			const offset = optionalOffset(args, "offset");
			// Before the per-row loop: inside it, an unknown id would be one failed
			// row per request rather than the one refusal it is.
			let environmentId: string | undefined;
			let targets: SmokeTarget[];
			try {
				environmentId = await resolveEnvironmentId(args, ctx, signal);
				targets = await smokeTargets(ctx.client, collectionId, recursive, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}
			// Read before any traffic flows: after the loop this call competes with
			// a cancellation the run itself may have raised, and the disclosure has
			// to survive that. A recursive run left nothing out to disclose.
			const children = recursive
				? []
				: await childCollectionNames(ctx.client, collectionId, signal);
			// The whole list is read once, in the engine's stable order, and the page
			// cut from it: a window re-read per call would shift under the run.
			const list = targets.slice(offset, offset + limit);
			let cancelled = false;
			const results: Array<Record<string, unknown>> = [];
			let passed = 0;
			let failed = 0;
			let skipped = 0;

			// One tick per row, whatever became of it. The message is an index and a
			// status word only: the masking that covers a row's url and error text
			// (`runOutputShape`) can run only once the loop is over, so nothing a
			// request resolved to may ride a mid-run string (#2451).
			const tick = () => {
				const row = results[results.length - 1];
				const status = row.skipped === true ? "skipped" : row.ok === true ? "ok" : "failed";
				ctx.progress?.(
					results.length,
					list.length,
					`${results.length}/${list.length} ${status}`
				);
			};
			if (list.length > 0) ctx.progress?.(0, list.length);

			for (const { item, folder } of list) {
				// A cancellation ends the run with the rows finished so far. It is
				// told from a row's own send error by the signal, not the error: the
				// aborted fetch rejects like any other failure.
				if (signal?.aborted) {
					cancelled = true;
					break;
				}
				const req = (item ?? {}) as {
					id?: string;
					name?: string;
					method?: string;
					url?: string;
					auth?: unknown;
				};
				const name = String(req.name ?? req.id ?? "request");
				const where = folder === undefined ? {} : { folder };
				// Compose the request the same way the app's Send does - engine-side
				// (`POST /compose`): variables resolved, stored/inherited auth
				// applied, and the chain's + its own scripts attached.
				let outgoing: Record<string, unknown>;
				try {
					outgoing = await composeViaEngine(
						ctx.client,
						{ requestId: String(req.id ?? ""), environmentId },
						signal
					);
				} catch (err) {
					if (signal?.aborted) {
						cancelled = true;
						break;
					}
					results.push({
						name,
						...where,
						method: String(req.method ?? "GET"),
						url: smokeRowUrl(ctx, req.url, req.auth),
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
					tick();
					continue;
				}
				const method = String(outgoing.method ?? "GET");
				const url = String(outgoing.url ?? "");
				// Only what the row echoes is projected; the gate and the send read `url`.
				const shownUrl = smokeRowUrl(ctx, url, outgoing.auth ?? req.auth);

				const gate = checkComposedTarget(outgoing, ctx.config, ctx.host);
				if (!gate.ok) {
					results.push({
						name,
						...where,
						method,
						url: shownUrl,
						ok: false,
						skipped: true,
						reason: gate.error,
					});
					skipped++;
					tick();
					continue;
				}
				try {
					const resp = ((await ctx.client.executeRequest(
						asMcpSend(outgoing, ctx),
						signal
					)) ?? {}) as Record<string, unknown>;
					// The engine's own allowlist refusal of where a script
					// moved the request (#2521), reported as the gate's is.
					const refused = targetPolicyRefusal(resp, ctx.host);
					if (refused) {
						results.push({
							name,
							...where,
							method,
							url: shownUrl,
							ok: false,
							skipped: true,
							reason: refused,
						});
						skipped++;
						continue;
					}
					const code =
						typeof resp.status === "number"
							? resp.status
							: typeof resp.statusCode === "number"
								? resp.statusCode
								: 0;
					// One reading of the assertions decides `ok` *and* rides the
					// row (issue #733): a row that fails on tests has to be able
					// to say which, and a second walk here could disagree with
					// the list the agent is shown.
					const tests = readTestVerdict(resp);
					const testsOk = !tests || tests.failed === 0;
					// The contract's own verdict, folded in the way `testResults`
					// folds (issue #681): a response the document declares a
					// schema for and that does not match it is a failed request.
					// Only a *checked* verdict can fail one - `checked: false`
					// says the response could not be judged, which is not the
					// same as judged and wrong, and failing a smoke run on it
					// would make an undocumented status look like a broken API.
					//
					// `failOnSchemaError: false` unfolds it (issue #720): the
					// verdict still rides the row, it just stops deciding `ok`.
					const schema = readSchemaVerdict(resp);
					const schemaOk =
						!failOnSchemaError || !(schema?.checked === true && schema.valid === false);
					const ok = code >= 200 && code < 400 && testsOk && schemaOk;
					results.push({
						name,
						...where,
						method,
						url: shownUrl,
						ok,
						statusCode: code,
						...(schema ? { schema } : {}),
						...(tests ? { tests } : {}),
					});
					if (ok) passed++;
					else failed++;
				} catch (err) {
					if (signal?.aborted) {
						cancelled = true;
						break;
					}
					results.push({
						name,
						...where,
						method,
						url: shownUrl,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
				}
				tick();
			}

			// A row's `url`, `reason`, `error` and failing test lines are what the
			// composed request resolved to, secrets included, so the matrix is run
			// output (#1809); read after the sends, so a secret a script set is known.
			// A cancelled call reads the masking scopes unsignalled: its own signal is
			// already aborted, and a masking read that fails closes the call on the
			// rows it was meant to hand back. The client's budget still bounds it.
			const withhold = await runOutputShape(ctx, cancelled ? undefined : signal);
			return withCaveat(
				structuredResult({
					collectionId,
					total: results.length,
					passed,
					failed,
					skipped,
					...smokePageFields({
						requestTotal: targets.length,
						offset,
						ran: results.length,
						planned: list.length,
						cancelled,
					}),
					results: withhold(results),
				}),
				smokeScopeCaveat(children)
			);
		},
	},
	{
		name: "run_collection",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description:
			"Run a collection as the product means collections to be run: its saved requests executed as an ordered sequence, one step at a time, by the engine's design-mode runner. Unlike run_collection_smoke this is ONE run with a run id - steps share a cookie jar, `pm.execution` flow control (setNextRequest, skipRequest) works, pre-request scripts run, and passing `data` repeats the sequence once per row with {{data.column}} bound and pm.iterationData set. Pass recursive: true to include sub-collections, in the sidebar's order. The collection tree IS the sequence: there is no step list to give. Every step's resolved host must be on the allowlist - unlike the smoke matrix, which skips an off-allowlist request and runs the rest, a scenario is one run, so a single step the allowlist does not cover refuses the whole run and nothing is sent. Returns the run id immediately; the run continues engine-side and get_run_report reads its outcome. For a collection bound to an OpenAPI document, pass failOnSchemaError: true to make that contract a gate, as the app's Run Collection checkbox does - off by default, the verdict is reported without deciding pass/fail. A script error in a step does not end its iteration, as in Postman; pass stopOnError: true to end it at every errored step, and read `stepsNotRun` in the report to see what errors cost. Pass `thresholds` to judge the run against pass/fail budgets, the same way a load run can. Sends real traffic and, as the app's Run Collection does, saves back any variables its scripts or extractors set (environment, globals, collection variables); it changes no other Vayu data. For a load test over the same sequence, use start_load_run's `scenario` argument.",
		annotations: {
			title: "Run collection",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests make up the sequence."),
			environmentId: z
				.string()
				.optional()
				.describe(
					`Environment whose variables resolve {{templates}} in every step, and whose cookie jar the run uses. ${ENVIRONMENT_DEFAULT_SENTENCE}`
				),
			recursive: scenarioRecursiveInput,
			// Positive: the engine reads the count as a pass total, so a zero is a
			// run with nothing to do and a negative is not a count at all. Named
			// rather than clamped, like every other count in this registry.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"How many passes over the sequence (default 1, or the row count when `data` is given). With more passes than rows the row index wraps."
				),
			data: scenarioDataInput,
			dataFileName: dataFileNameInput,
			dataFileHash: dataFileHashInput,
			dataFileCastNumbers: dataFileCastNumbersInput,
			// The Run Collection dialog's checkbox, which had no MCP writer at all
			// (issue #766). Design-mode only, because only this runner demotes a
			// step on a schema failure - see the refusal on `start_load_run`.
			failOnSchemaError: failOnSchemaErrorInput({
				unit: "step",
				defaultsOn: false,
				guidance:
					"Set true to make the bound contract a gate, the way the app's Run Collection checkbox does: a step whose response does not match its schema fails, and the run's report records that it was judged that way. Only a step that passed everything else is demoted - one already failing keeps the error that named it. Left off, the verdict still rides every step and the report's schemaValidation totals; it just does not decide pass/fail.",
			}),
			// The Run Collection dialog's switch (issue #2526). Design-mode only,
			// so `start_load_run` declares and refuses it.
			stopOnError: z
				.boolean()
				.optional()
				.describe(
					"Set true to end an iteration at every errored step, a script error and a transport failure included. Left off (the default), an errored step (a script that threw, a request that got no response, an unbindable data row) stays `errored` with its message and the iteration moves on to the next request, as in Postman and Newman; the runner's own refusals (an unresolved setNextRequest target, the maxStepsPerIteration cap) end the iteration either way. What an error cost is counted in `stepsNotRun`."
				),
			// Only `timers` - not `scripts` - from #1495's override block
			// (issue #1559): unlike a scenario load run, this design-mode
			// runner has no inline/deferred distinction for script.pre/
			// script.post to make, but it does run timer.pacing/timer.think
			// waits (`execute_scenario_run` wires `RunContext::timers_override`
			// exactly as the load path does - see `elementsTimersInput`'s doc
			// comment), so silencing them here is real, not a no-op control.
			elements: z
				.object({ timers: elementsTimersInput() })
				.optional()
				.describe(
					"Silence this run's timer.pacing/timer.think waits without editing the collection (`timers: \"off\"`); \"asConfigured\" (default) leaves each element's own configuration in effect. Only `timers` applies to a design-mode run - `scripts`'s inline-vs-deferred distinction is a load-run concept only, so it belongs on start_load_run's `scenario` branch instead."
				),
			// The engine now judges a design-mode run against declared budgets
			// exactly as it always has a load run (issue #1564), so this tool
			// takes the same `thresholds` argument `start_load_run` does.
			thresholds: thresholdsInput,
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const recursive = args.recursive === true;
			const iterations = typeof args.iterations === "number" ? args.iterations : undefined;
			const data = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;
			const dataFileName = str(args, "dataFileName");
			const dataFileHash = str(args, "dataFileHash");
			const dataFileCastNumbers =
				typeof args.dataFileCastNumbers === "boolean"
					? args.dataFileCastNumbers
					: undefined;

			let environmentId: string | undefined;
			let plannedSteps: number;
			try {
				environmentId = await resolveEnvironmentId(args, ctx, signal);
				plannedSteps = await preflightScenarioSteps(
					{ collectionId, recursive, environmentId },
					ctx,
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}

			const payload: Record<string, unknown> = {
				scenario: scenarioBlock(
					{ collectionId, data, dataFileName, dataFileHash, dataFileCastNumbers },
					recursive,
					iterations
				),
				...(environmentId !== undefined ? { environmentId } : {}),
				// Top-level, beside `scenario` rather than inside it: that is where
				// `read_fail_on_schema_error` looks, and where the app's dialog puts
				// it. Omitted when off - the engine's default - so a run snapshot
				// carries the key exactly when it changed what "failed" meant, which
				// is what keeps a payload written before the flag existed reading the
				// way it always did.
				...(args.failOnSchemaError === true ? { failOnSchemaError: true } : {}),
				// Top-level and omitted when off, on the same terms: the engine's
				// default is false, and a snapshot carries the key exactly when it
				// changed what ended an iteration.
				...(args.stopOnError === true ? { stopOnError: true } : {}),
				// Also top-level, beside `scenario`, for the same reason -
				// `validate_elements_run_override` reads it there on every
				// `POST /runs` payload regardless of mode.
				...(args.elements && typeof args.elements === "object"
					? { elements: args.elements }
					: {}),
			};
			// Forwarded verbatim - the keys are the engine's own metric names,
			// and they come back unchanged in get_run_report's
			// `thresholdValidation`. Zod has already bounded every value.
			if (args.thresholds && typeof args.thresholds === "object") {
				payload.thresholds = args.thresholds;
			}

			let started: unknown;
			try {
				started = await ctx.client.startRun(asMcpSend(payload, ctx), signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			// The engine's 202 body is the answer; anything else is handed back as
			// it came rather than dressed up as a started run.
			if (!started || typeof started !== "object" || Array.isArray(started)) {
				return jsonResult(started);
			}
			return watchedRun(
				structuredResult({
					...(started as Record<string, unknown>),
					plannedSteps,
					nextStep:
						`The run executes engine-side. ${startedRunNextStep(undefined, undefined)} ` +
						`The report's \`scenario\` section carries the iteration and pass/fail/skip totals plus ` +
						`\`stepsStored\`/\`stepsDropped\`, and \`results\` returns every stored step row ` +
						`(a run past the step cap keeps non-passing steps first; \`stepsDropped\` and ` +
						`\`resultsStored\`/\`resultsCap\` say whether it did). Each row's \`trace\` carries that step's ` +
						`request and response bodies inline, so a long plan against large responses ` +
						`makes for a large report - read the totals first and the rows when you need ` +
						`them. A script error does not end an iteration unless \`stopOnError\` was set: ` +
						`the report's \`scenario.stepsNotRun\` counts the plan positions that errors that ` +
						`did end one cost, and the step row that ended it carries its own \`stepsNotRun\` ` +
						`in its \`trace\`.`,
				}),
				"collection",
				started
			);
		},
	},
];
