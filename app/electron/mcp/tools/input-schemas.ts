/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file input-schemas.ts
 * @brief Zod input fragments more than one tool declares, so an argument
 *        reads the same on every tool that takes it.
 */

import { z } from "zod";
import { DATA_FILE_HASH_PATTERN } from "../../data-file.js";
import { HTTP_VERSIONS } from "../http-versions.js";
import { TRUST_AUTHORITY_TOKEN } from "../remedy.js";
import { ENVIRONMENT_DEFAULT_SENTENCE } from "../variable-origins.js";
import {
	DEFAULT_STREAM_BUDGET_MS,
	DEFAULT_STREAM_MAX_EVENTS,
	MAX_REDIRECTS_BOUND,
	MAX_STREAM_BUDGET_MS,
} from "./compose.js";

/** Optional resolution scope shared by the ad-hoc execute/load tools. */
export const collectionIdInput = z
	.string()
	.optional()
	.describe(
		"Optional collection ID. Scopes variable resolution to that collection's variable chain and lets auth mode 'inherit' resolve against it."
	);

export const environmentIdInput = z
	.string()
	.optional()
	.describe(
		`Environment whose variables resolve {{templates}} in this request. ${ENVIRONMENT_DEFAULT_SENTENCE}`
	);

/**
 * The refusal an ad-hoc send gets for `verifySSL: false`, and with it the
 * answer to the per-call TLS question issue #795 posed.
 *
 * The stored field is writable (`create_request` / `update_request`) and a
 * per-call one is not, because the two differ in what survives the call. A
 * stored `verifySSL: false` is a document: the app's Settings tab shows the box
 * unticked and prints a warning under it, `list_requests` reads it back, and a
 * user can undo it. An argument on one send is visible only inside the agent's
 * own transcript - nothing in Vayu records that a certificate went unchecked,
 * so nobody can find it afterwards or take it back.
 *
 * The alternative considered was the `allowInsecureTls` safety toggle #795
 * sketched. Rejected: it would be a *global* permission - every allowlisted host
 * for the rest of the session, granted once for one dev box and then forgotten -
 * where the stored field is per request, and it would need a Settings control of
 * its own to be reachable at all, which is a second way to weaken TLS for a case
 * the first one already covers.
 *
 * `true` is accepted rather than refused alongside it: it is what the composed
 * payload already carries, so an agent restating the safe default should not be
 * argued with.
 */
/**
 * What the engine puts on a request nobody wrote it into (issue #1229).
 *
 * Every execute path adds these, so an agent comparing the response it got
 * against the request it wrote is otherwise looking at headers no tool
 * mentioned - and an agent testing "what does this endpoint do with no
 * `User-Agent`" had no way to find out that it cannot simply omit one.
 *
 * One sentence in one place, carried by the three tools that send traffic: three
 * paraphrases of the same rule are three things to keep in step with the engine.
 */
export const ENGINE_DEFAULT_HEADERS_SENTENCE =
	"Headers the engine adds itself: every request sent through Vayu that does not already name them gets a `User-Agent` (`Vayu/<version>`), an `Accept-Encoding` negotiating the compression this build can decode, and - only when the user has switched it on - a fresh per-request correlation id (`X-Vayu-Request-Id` by default). They are added at send time and never stored on a request, and a header you write under one of those names always wins, so setting `User-Agent` yourself is how you control what the target sees. Refusing one outright - sending no `User-Agent` at all - is the engine's `disabledDefaultHeaders` field, which names the headers a send declines; the app's Headers tab offers it as a tick per header, and run_request and start_load_run take it as an argument. run_collection_smoke does not: it replays each saved request exactly as stored, so a refusal there would be a per-send decision applied to requests the agent did not write.";

/**
 * The default headers one send refuses (issue #1337), as `disabledDefaultHeaders`.
 *
 * One fragment for the two tools that build a request payload: the field means
 * the same thing on `POST /execute` and `POST /runs`, and the engine reads it
 * off both through the same `read_default_header_opt_outs` (`utils/json.cpp`).
 *
 * Shape only. The engine owns what a usable header name is and refuses a bad
 * one by name, so a second copy of that rule here could only drift from it -
 * the same posture `thresholds` and the stream caps take.
 */
export const defaultHeaderOptOutsInput = z
	.array(z.string())
	.optional()
	.describe(
		'Default headers this send refuses, by name (e.g. ["User-Agent", "Accept-Encoding"]). This is the only way to send a request with **no** User-Agent at all - writing one yourself replaces the value but still sends the header. Only the engine\'s own defaults are refusable; a name it adds nothing under is accepted and does nothing, and a name that cannot be a header name is refused by the engine. Nothing is stored: the refusal applies to this send alone.'
	);

export const INSECURE_TLS_REFUSAL = `verifySSL: false is not accepted on a one-off send - a skipped certificate check has to leave a record, and an argument on a single call leaves none. Two ways forward: ask the user to ${TRUST_AUTHORITY_TOKEN}, which keeps verification on for every request; or save the request with create_request/update_request \`verifySSL: false\` and send it by id (run_request with \`requestId\` and no \`url\` sends a saved request exactly as stored). The app then shows that request as accepting any certificate, and the user can untick it.`;

/**
 * `run_request`'s TLS argument: declared so that asking for the downgrade gets
 * {@link INSECURE_TLS_REFUSAL} - naming the two supported routes - rather than a
 * stripped unknown key and a handshake failure the agent has to guess at.
 */
export const verifySSLSendInput = z
	.boolean()
	.optional()
	.describe(
		`Verify the server's TLS certificate (default true). Only \`true\` is accepted here: \`false\` is refused, because skipping the certificate check for one agent-issued send leaves no trace in Vayu afterwards. Save the request with \`verifySSL: false\` (create_request / update_request) if the user wants an internal or self-signed host reachable, or have the user ${TRUST_AUTHORITY_TOKEN}.`
	);

/**
 * The post-response validation script, declared identically on `run_request` and
 * `start_load_run` so one script an agent writes carries between them - the way
 * the app's single **Tests** tab drives both Send and a load run. See
 * `readValidationScript` for why the `tests` alias exists and stays.
 */
export const validationScriptInput = z
	.string()
	.optional()
	.describe(
		"JavaScript run after a response arrives; use pm.test(...) for assertions, returned as test results. This is the same script the app's Tests tab holds - under load it runs against sampled responses, not every one. Read the `vayu://scripting/completions` resource for the sandbox's full surface (pm.expect chains, pm.response.to.*, the variable scopes) rather than assuming what exists. Refused while Reveal secrets to agents is off."
	);

export const validationScriptAliasInput = z
	.string()
	.optional()
	.describe(
		"Alias for `postRequestScript` (the engine's own name for it on a load run). Pass one or the other, not both."
	);

/**
 * One data row bound to a single send (issue #601).
 *
 * The agent-facing half of what the app's Send-with-row does: `{{data.column}}`
 * tokens substitute against this row and both scripts read it as
 * `pm.iterationData`, without a collection run existing. `run_collection_smoke`
 * deliberately stays out of it - it has no scenario path at all (see mcp.md).
 *
 * The failure shape is named in the description because it is the useful half:
 * a column the row does not carry is a `400` naming the token and the row's
 * columns, and *nothing is sent* - so an agent reading the error can fix the
 * request rather than wondering what went out.
 *
 * Credentials bind too (issue #642), and the description says which mode does
 * not: an agent that is told "auth cannot bind" writes the token somewhere else
 * for no reason, and one told nothing writes it into an oauth2 config and gets
 * a 400 it cannot explain.
 */
export const dataRowInput = z
	.record(z.string(), z.unknown())
	.optional()
	.describe(
		'One data row to bind, as an object of name/value pairs (e.g. {"id": "7", "email": "a@b.c"}). Every {{data.column}} in the URL, headers, body and auth credentials is substituted against it, and pre-request and post-response scripts read it as pm.iterationData (pm.info.iteration is 0). A column the row does not carry is an error naming the token and the row\'s columns, and nothing is sent. A credential binds before it is encoded, so basic auth base64s the row\'s values; the exception is OAuth 2.0, whose token comes from the token endpoint rather than the request, so a {{data.*}} in an oauth2 config is refused by name. Omit this to send without a row, which leaves {{data.*}} tokens written as they stand.'
	);

/**
 * Whether the bound contract is a gate, worded for the surface asking (issues
 * #720, #766).
 *
 * One fragment rather than a copy per tool, because the flag means the same
 * thing wherever it is offered - does a schema failure fail the unit - while
 * two things about it are genuinely per-surface: which unit one verdict
 * decides, and which way it defaults.
 *
 * **`run_collection_smoke` defaults to `true`, where the engine's `POST /runs`
 * flag defaults to `false`**, and the divergence is deliberate rather than an
 * oversight: that tool has folded a checked-and-failed schema verdict into `ok`
 * since #681, says so in its own description, and an agent that has been
 * reading its matrix would silently start seeing contract failures pass if the
 * default moved. Each surface keeps the default its readers already have. Off,
 * the verdict still rides every row: it stops deciding pass/fail, it is never
 * withheld.
 */
export function failOnSchemaErrorInput(surface: {
	/** What one verdict decides here: a smoke row's request, or a run's step. */
	unit: string;
	/** This surface's default, stated in the description rather than implied. */
	defaultsOn: boolean;
	/** What the non-default setting buys, in this surface's own terms. */
	guidance: string;
}) {
	return z
		.boolean()
		.optional()
		.describe(
			`Whether a response that does not match the schema the collection's bound OpenAPI document declares fails its ${surface.unit} (default ${surface.defaultsOn}). ${surface.guidance} Only a checked verdict is ever folded in: a status or content type the document declares no schema for is reported unchecked and never fails a ${surface.unit}, with or without this.`
		);
}

/**
 * Why a schema gate cannot ride a load run, in the executor's own terms rather
 * than a bare "unsupported" (issue #766).
 *
 * `failOnSchemaError` is *declared* on `start_load_run` so this refusal can
 * reach an agent at all: the MCP SDK validates a call against the tool's schema
 * and **strips** what the schema does not declare, so an undeclared key would
 * be dropped before the handler ran and the run would start with the agent
 * believing a gate applied. Declared and refused, the answer names the flag and
 * the surface that honours it. It is refused on both of this tool's paths - a
 * scenario is not the reason, the executor is: `read_fail_on_schema_error` is
 * the scenario *runner*'s, and no load path reads it.
 */
export const LOAD_RUN_SCHEMA_GATE_REFUSAL =
	`"failOnSchemaError" does not apply to a load run: the load executor validates sampled ` +
	`responses once the run has drained and never demotes a step, so a gate here would decide ` +
	`nothing. Nothing was started - the flag would have been read as shaping this run while ` +
	`no load path looks at it. The schema verdict rides the report's \`schemaValidation\` ` +
	`block either way. Remove it, or run the same collection in design mode with ` +
	`run_collection, which is where the gate takes effect.`;

/**
 * `elements.timers`'s two enum values (issue #1495), shared between
 * `run_collection` and `start_load_run` because it takes effect on every run
 * shape both tools can start: `execute_scenario_run` (the design-mode runner
 * `run_collection` drives) wires `RunContext::timers_override` into the same
 * `ExchangeInputs` a scenario load run does (`scenario_runner.cpp`'s two call
 * sites, `scenario_load.cpp`'s three), so a `timer.pacing`/`timer.think` wait
 * fires - and can be silenced - during a plain `run_collection` call exactly
 * as it does under load; a single target's own `requestElements` reads the
 * same override now too (issue #1594, `load_strategy.cpp`'s pipeline hooks).
 * `scripts_override` reaches the same three: `replay_scenario_steps` (the
 * load path's post-run replay, `run_manager.cpp`) and, since #1594, a single
 * target's own inline-vs-deferred dispatch.
 */
export function elementsTimersInput() {
	return z
		.enum(["asConfigured", "off"])
		.optional()
		.describe(
			'"off" silences every timer.pacing/timer.think wait for this run, across every element, without editing the collection. "asConfigured" (default) leaves each element\'s own configuration in effect. The engine also accepts a {fixedMs} or {minMs, maxMs} override replacing every timer\'s own span, not offered here - no control sends it yet.'
		);
}

/**
 * The two fields a scenario block carries besides its collection id, declared
 * here because both scenario surfaces take them and they must mean the same
 * thing on each (issue #754): `run_collection` runs the plan once through the
 * design runner, `start_load_run` drives the same plan with virtual users.
 *
 * `iterations` is deliberately not among them - see the scenario block on
 * `start_load_run` for why a load run reads the top-level one instead.
 *
 * Whether to descend into sub-collections, and in which order that happens.
 */
export const scenarioRecursiveInput = z
	.boolean()
	.optional()
	.describe(
		"Descend into sub-collections (default false). The order is the sidebar's: at every level each sub-collection's whole subtree runs before that level's own requests."
	);

/**
 * The inline data set, in the shape `POST /runs` reads it.
 *
 * Inline because the engine never opens a file - the app parses CSV/TSV/JSON and
 * sends rows, and a path an agent chose would be a trust boundary neither side
 * wants. The engine's own `maxScenarioDataRows` / `maxScenarioDataBytes` bound
 * the array and its 400 is surfaced verbatim rather than re-derived here, which
 * would be a second copy of a limit the user can raise in Settings.
 */
export const scenarioDataInput = z
	.array(z.record(z.string(), z.unknown()))
	.optional()
	.describe(
		'Data rows, one flat object per row (e.g. [{"id":"1"},{"id":"2"}]). Every {{data.column}} in a step\'s URL, headers, body and auth credentials is bound per iteration, and both scripts read the row as pm.iterationData. A step carrying a {{data.*}} token with no data set is refused by the engine before anything is sent, as is a present-but-empty array. The columns a collection declares for its data file are its `dataSchema.columns` in list_collections. The row set is not persisted - only its count is recorded on the run, with `dataFileName` / `dataFileHash` when given - but a bound value travels in the request that carried it, and the run stores each step\'s request and response until the run is pruned.'
	);

/**
 * Which file a run's rows came from (issue #2051), declared once for every
 * place a data set is accepted: `run_collection`'s `data`, and `start_load_run`'s
 * top-level `data` and `scenario.data`. Stored verbatim on the run and served
 * back on `list_runs` and the report, so an agent re-running "with the same
 * file" can check it before it sends the rows. A name, never a path: the engine
 * opens nothing, and refuses a separator in it as this schema does. Either one
 * without rows is refused engine-side, by name.
 */
export const dataFileNameInput = z
	.string()
	.regex(
		/^[^/\\]*$/,
		"dataFileName is the file's name, never a path: send list_collections' `dataFile.fileName`, not `dataFile.path`"
	)
	.optional()
	.describe(
		"The data file's display name (e.g. \"users.csv\", list_collections' `dataFile.fileName`), recorded on the run beside its row count. A name, never a path: one holding a `/` or `\\` is refused - Vayu opens nothing. Only beside data rows; sent alone it is refused."
	);

/** The SHA-256 of that file's bytes, in the one spelling the engine accepts. */
export const dataFileHashInput = z
	.string()
	.regex(DATA_FILE_HASH_PATTERN, "dataFileHash must be 64 lowercase hex characters (SHA-256)")
	.optional()
	.describe(
		"SHA-256 of the data file's raw bytes as 64 lowercase hex characters, recorded on the run so a later run can be checked against the same content (list_collections' `dataFile.hash` is the declared file's digest as it is on disk now). Only beside data rows; sent alone it is refused."
	);

/**
 * Pass/fail budgets, declared once and forwarded verbatim by both
 * `run_collection` and `start_load_run` (issue #1564): the engine judges a
 * design-mode collection run against them exactly as it always has a load
 * run, so the schema and the report shape are the same on both tools rather
 * than two hand-written copies that could drift. The bounds mirror the
 * engine's, so a value this schema accepts is one `POST /runs` accepts; an
 * empty object is rejected there rather than starting a run nothing will
 * judge, so it is rejected here too, by name.
 */
export const thresholdsInput = z
	.object({
		latencyP50Ms: z.number().positive().max(86_400_000).optional(),
		latencyP95Ms: z.number().positive().max(86_400_000).optional(),
		latencyP99Ms: z.number().positive().max(86_400_000).optional(),
		maxErrorRatePct: z.number().min(0).max(100).optional(),
		minThroughputRps: z.number().positive().max(1_000_000_000).optional(),
		maxAssertionFailureRatePct: z.number().min(0).max(100).optional(),
		// Not a budget - whether a missed one fails the run, not itself
		// measured against anything, so it is excluded from the
		// at-least-one-budget refinement below.
		failRun: z
			.boolean()
			.optional()
			.describe(
				"When true, a missed budget sets this run's terminal status to failed rather than only reporting the verdict. Default false."
			),
	})
	// Zod's object() strips any key it doesn't name, which would
	// silently drop a `custom.<name>.<stat>` budget (issue #1500)
	// before it ever reached `POST /runs`. `catchall` accepts it
	// instead and forwards it as-is; the engine's own
	// `validate_thresholds` is the real gate on its shape.
	.catchall(z.number())
	.refine((t) => Object.keys(t).filter((key) => key !== "failRun").length > 0, {
		// `error`, not zod 3's `message`: v4 still reads the old key as a
		// deprecated alias, and a deprecated alias is what the next major
		// takes away.
		error: "Declare at least one budget, or omit `thresholds` entirely.",
	})
	.optional()
	.describe(
		"Pass/fail budgets for this run. The report comes back with `thresholdValidation`: one check per budget plus a verdict of passed/failed. Also accepts `custom.<name>.<stat>` for a declared metric.record name, `<stat>` one of p50/p95/p99/max/rate/value. Omit for a run that is measured but not judged."
	);

export const streamInput = z
	.boolean()
	.optional()
	.describe(
		`Consume the response as a text/event-stream instead of buffering it (default false). BOUNDED, ALWAYS: this tool does not stream to you - it reads the run's events for at most \`streamBudgetMs\` milliseconds (default ${DEFAULT_STREAM_BUDGET_MS}) and returns at most \`maxStreamEvents\` of them (default ${DEFAULT_STREAM_MAX_EVENTS}). The result says which bound it stopped at (\`completed\`, \`capReached\`, \`budgetExhausted\`) and carries \`totalEvents\` where the engine knows it, so a partial read is never mistaken for the whole stream. The run keeps going engine-side after this returns; read it later with get_run_report, or end it with stop_run.`
	);

export const maxStreamEventsInput = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		`Streaming only: how many events to return before stopping the read (default ${DEFAULT_STREAM_MAX_EVENTS}). Reaching it sets \`capReached\` - the stream itself is not stopped.`
	);

export const streamBudgetMsInput = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		`Streaming only: how long to read events for, in milliseconds (default ${DEFAULT_STREAM_BUDGET_MS}, maximum ${MAX_STREAM_BUDGET_MS}). Reaching it sets \`budgetExhausted\`.`
	);

/**
 * One entry of a request or collection's `elements` list (issue #1512):
 * extractors, assertions, timers, controllers and scripts, each a `kind` plus
 * its own `config`. `kind` is a bare string rather than a Zod enum - the
 * engine's registry is the authority on what kinds exist (`GET
 * /elements/kinds`, served here as the `vayu://elements/kinds` resource), and
 * enumerating them here would need a tool change every time the engine adds
 * one. `element-kinds.conformance.test.ts` is what keeps this schema and the
 * resource from silently drifting apart.
 */
export const elementSchema = z.object({
	id: z.string().optional().describe("Element id; omit to let the engine assign one."),
	kind: z
		.string()
		.describe(
			'Element kind, e.g. "script.pre", "extract.json", "assert.status" - read the `vayu://elements/kinds` resource for the current catalogue and each kind\'s config shape before writing one blind.'
		),
	enabled: z.boolean().optional().describe("Defaults to true."),
	name: z.string().optional().describe("Optional display name."),
	config: z
		.record(z.string(), z.unknown())
		.describe("Kind-specific configuration, validated engine-side against that kind's schema."),
});

/**
 * The `elements` argument every write tool that stores them declares -
 * `create_request` / `update_request` / `create_collection` /
 * `update_collection`. Whole-list semantics (`scope` names what "whole" means
 * for that tool): passing it replaces the stored list entirely, the same rule
 * `headers` and `auth` already follow, because there is no per-entry patch to
 * offer over a JSON column.
 */
export function elementsInput(scope: string) {
	return z
		.array(elementSchema)
		.optional()
		.describe(
			`The complete elements list for ${scope} (extractors, assertions, timers, scripts…), replacing whatever is stored. Leave it out to keep the stored list, or use \`preRequestScript\`/\`postRequestScript\` for the common case of just a script - passing both here and one of those on the same call is refused, since a caller who states the whole list has already said what belongs in it.`
		);
}

/**
 * A saved request's `script.pre` / `script.post` elements, offered under
 * their pre-#1512 names so an agent that only knows scripts keeps working
 * (issue #1517). `create_request` and `update_request` translate a non-empty
 * string into a `script.pre` / `script.post` entry before calling the engine
 * - which now refuses `preRequestScript` / `postRequestScript` as wire fields
 * outright (issue #1514) - and fold it into whatever `elements` list is
 * already stored, via `upsertScriptElement`. On an update the two cannot both
 * be given: an explicit `elements` argument already states the whole list, so
 * folding a sugar script on top of it would leave one of the two silently
 * losing.
 *
 * One name per script here, deliberately. The `tests` alias exists on the
 * *run* tools because the engine spells an ad-hoc run body that way
 * (`readValidationScript`); a second name for a stored field would be a
 * second name to keep in step and a second way for an agent to half-write a
 * script.
 *
 * `clearable` appends the merge rule, which is `update_request`'s alone - on a
 * create there is no stored script to keep.
 */
export function storedScriptInput(which: "pre" | "post", clearable: boolean) {
	const what =
		which === "pre"
			? "JavaScript run before the request is sent - the app's Pre-request tab. Use it to sign or otherwise rewrite the request through pm.request."
			: "JavaScript run after its response arrives - the app's Tests tab. Use pm.test(...) for assertions. Same script `run_request` takes under this name, but stored as a script.post element rather than supplied per call.";
	return z
		.string()
		.optional()
		.describe(
			`${what} Stored as a \`script.${which}\` element. Read the \`vayu://scripting/completions\` resource for the sandbox's surface rather than assuming what exists.` +
				(clearable
					? " Leave it out to keep the stored script; pass an empty string to clear it."
					: "")
		);
}

/**
 * A collection's `script.pre` / `script.post` elements - the ones that run
 * around *every* request in it, not around one (issue #759). Same
 * elements-backed sugar {@link storedScriptInput} is for requests.
 *
 * A separate fragment from `storedScriptInput` rather than a parameter on it,
 * because what an agent has to know here is the scope: a script written onto a
 * collection runs for every request below it, including the ones in its
 * sub-collections, so the blast radius of a wrong one is a whole tree rather
 * than a row. Both take the same clearing rule the request scripts do on an
 * update - an empty string is a value, not an omission.
 */
export function collectionScriptInput(which: "pre" | "post") {
	const when =
		which === "pre"
			? "before each request in this collection is sent, ahead of that request's own pre-request script"
			: "after each response in this collection arrives, ahead of that request's own test script";
	return z
		.string()
		.optional()
		.describe(
			`JavaScript run ${when} - the app's collection-level scripts, stored as a \`script.${which}\` element. It runs for every request in the collection and in its sub-collections, so scope it accordingly. Read the \`vayu://scripting/completions\` resource for the sandbox's surface. Leave it out to keep the stored script; pass an empty string to clear it.`
		);
}

/**
 * Optional auth block. Callers can copy a saved request's `auth` object verbatim
 * (read via list_requests). The engine applies it - bearer/basic/apikey and
 * oauth2 (using its token cache) - after `{{variables}}` inside it are resolved;
 * `inherit` resolves against the collection chain (supply collectionId).
 */
export const authInput = z
	.object({ mode: z.string().describe("bearer | basic | apikey | oauth2 | inherit | none.") })
	.passthrough()
	.optional()
	.describe(
		"Optional auth block (e.g. { mode: 'bearer', token: '{{apiToken}}' }); the engine resolves and applies it."
	);

/**
 * The auth block as it is *stored* on a document, described for the resource
 * holding it (issue #759).
 *
 * The same schema `run_request` and `start_load_run` take - one definition, not
 * a copy - because a saved request's auth and an ad-hoc one are the same object
 * in the same shape, and an agent that read a request's `auth` over
 * `list_requests` must be able to write it back verbatim. What differs per
 * subject is only which modes are meaningful: a request may `inherit` (its
 * default), while a collection is the root of the chain and never does.
 */
export function storedAuthInput(subject: string, extra: string) {
	return authInput.describe(
		`Auth block stored on ${subject}, in the same shape run_request takes - e.g. { mode: 'bearer', token: '{{apiToken}}' }. It is stored as written and resolved when the request is sent, so {{variables}} inside it are fine. ${extra}`
	);
}

/**
 * The **Settings** tab's five per-request fields, as the engine stores them on
 * the row (issues #759, #795).
 *
 * One definition spread into both `create_request` and `update_request`: the
 * fields mean the same thing on either verb, and the merge-patch difference is
 * carried by the surrounding tool description rather than by two copies of five
 * schemas. Ranges are the engine's own (`apply_request_fields`) rather than new
 * numbers - `maxRedirects` is clamped to 0-100 there, and an unrecognized
 * `httpVersion` is a 400 rather than a coercion, which is why the enum is
 * closed here too.
 *
 * `verifySSL` is the one whose description has to say what the field *means*
 * rather than what it sets: it is the only setting here whose off position is a
 * security downgrade, and an agent that reads "certificate verification" as a
 * strictness knob would turn it off to make a handshake stop failing. The
 * merge-patch rule matters more for it than for the other four for the same
 * reason - a defaulted `true` on an unrelated update would silently re-enable
 * verification a user turned off, and the request would then fail against the
 * host it was written for.
 */
export function requestSettingsInput() {
	return {
		followRedirects: z
			.boolean()
			.optional()
			.describe(
				"Follow 3xx redirects when this request is sent (default true). The request builder's redirect option."
			),
		maxRedirects: z
			.number()
			.int()
			.min(0)
			.max(MAX_REDIRECTS_BOUND)
			.optional()
			.describe(
				`How many redirects to follow before giving up (default 10, 0-${MAX_REDIRECTS_BOUND}).`
			),
		httpVersion: z
			.enum(HTTP_VERSIONS)
			.optional()
			.describe(
				'Protocol to negotiate when this request is sent: "auto" | "http1.1" | "http2" (default "auto").'
			),
		stream: z
			.boolean()
			.optional()
			.describe(
				"Consume the response as a text/event-stream rather than buffering it (default false). Stored on the request, so a later send - from the app or from run_request - streams without being told to."
			),
		verifySSL: z
			.boolean()
			.optional()
			.describe(
				`Verify the server's TLS certificate when this request is sent (default true). Setting it false skips the certificate check entirely, hostname included, so an internal or self-signed host answers instead of failing - and anything on the network path can then read and rewrite the request. It is stored on the request and applies to every later send of it: the app's Send, a load run and a stream alike. Prefer keeping it on and having the user ${TRUST_AUTHORITY_TOKEN}; turn it off only when they have asked for exactly that, and say so in your reply, because the app shows this request as accepting any certificate from then on.`
			),
	};
}

/**
 * The stored settings a call named, forwarded verbatim; an unnamed one is absent.
 *
 * Every key {@link requestSettingsInput} declares appears here - the schema
 * declares the shape, this list is what the payload builder actually reads, so a
 * field added to one and not the other is an argument the engine never sees.
 */
export const REQUEST_SETTINGS_KEYS = [
	"followRedirects",
	"maxRedirects",
	"httpVersion",
	"stream",
	"verifySSL",
] as const;

/**
 * Lay the caller's stored-settings fields onto a request payload.
 *
 * Values pass through unvalidated on purpose: the schema above owns the shapes,
 * and the engine owns the ranges - re-deriving either here would be a second
 * copy that refuses what the engine accepts the moment one side moves. What
 * this owns is the *absent* rule, which is the merge-patch contract: a field the
 * caller did not name is never written, so an update cannot silently reset the
 * redirect policy a user set in the app.
 */
export function applyRequestSettings(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	for (const key of REQUEST_SETTINGS_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
}
