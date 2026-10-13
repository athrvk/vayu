/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Load test configuration.
 *
 * Re-cut from a single 450-line scrolling column. Three things drove it:
 *
 *   - **Fields now follow the profile.** Each mode is a different form, and
 *     they used to share one column with Duration pinned second regardless -
 *     which hid a field that does nothing (see NumberField "duration" below).
 *   - **Recording options fold away.** Sampling, slow threshold, timing
 *     breakdown, in-flight cap and comment are five controls most runs never
 *     touch, and they sat between the profile and the Start button.
 *   - **One notice component.** Up to four notices can be on screen at once and
 *     they had four different designs; now severity is a prop and blocking ones
 *     sort above advisory ones, because with a stack that is the only thing
 *     saying which one is stopping you.
 *
 * Every field is kept, along with the defaults, the persistence and the
 * validation. The exception is documented where it happens.
 */

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LoadTestConfig, OAuth2Config } from "@/types";
import OAuth2LoadTestGuard from "../OAuth2LoadTestGuard";
import {
	validateCapacityRange,
	validateRampDuration,
	validateStartConcurrency,
	validateStartConcurrencyFloor,
} from "../../utils/loadTestValidation";
import { resolveLoadTestLimits, successSamplePeriod } from "@/constants/load-test";
import { useClientSettingsStore } from "@/stores";
import {
	Button,
	Input,
	Label,
	ToggleGroup,
	ToggleGroupItem,
	Dialog,
	DialogContent,
	DialogBody,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	DialogCancelButton,
	DisabledHint,
} from "@/components/ui";
import { Callout, NumberField } from "@/components/shared";
import DataFilePicker, { type SelectedDataFile } from "@/modules/collections/DataFilePicker";
import { describeDataSchemaDiff, describeUnboundReferences } from "@/services/data-files";
import { useDeclaredDataFile } from "@/hooks/useDeclaredDataFile";
import { runDataFileName } from "@/lib/run-data-file";
import { useDataContractWriter } from "@/hooks/useDataContractWriter";
import { useColumnAudit, type ColumnAuditRequest } from "@/hooks/useColumnAudit";
import { useRequestDefaultsQuery } from "@/queries";
import { useSavedLoadTestConfig } from "./useSavedLoadTestConfig";
import { buildNotices } from "./notices";
import { RecordingSection } from "./RecordingSection";
import { BudgetsSection } from "./BudgetsSection";
import { MonitoringSection } from "./MonitoringSection";
import { ProfilePicker } from "./ProfilePicker";
import { summarise } from "./summary";
import { describeDefaultHeaderDifference } from "./default-headers";
import { budgetError, buildThresholds, customBudgetsError } from "./budgets";
import { buildMonitor, monitorError } from "./monitor";
import { useMonitorSettings } from "@/hooks/useMonitorSettings";

/**
 * The `elements.scripts` run override (issue #1594), the same three values
 * and the same default `RunCollectionDialog`'s Scripts toggle uses - "As
 * marked" leaves each inherited `script.*` element's own `config.inline` to
 * decide, the other two force every one of this run's elements regardless.
 */
const SCRIPTS_DEFAULT = "asMarked";

const NO_COLUMNS: string[] = [];

export interface LoadTestConfigDialogProps {
	onClose: () => void;
	onStart: (config: LoadTestConfig) => void;
	isStarting: boolean;
	/** True when the pending request has a non-empty preRequestScript. */
	hasPreRequestScript: boolean;
	/** Variable-resolved OAuth 2.0 config, when the effective auth is oauth2. */
	oauth2Config?: OAuth2Config;
	/**
	 * True when the pending request has its `stream` setting on (issue #576).
	 *
	 * It gates the two cap fields rather than being set here: whether a request
	 * streams belongs to the request (its Settings tab), and only *how much of
	 * each stream this run measures* belongs to the run. Showing the caps for a
	 * request that does not stream would offer bounds on something that is not
	 * happening.
	 */
	isStreamingRequest: boolean;
	/**
	 * The collection the request being load-tested belongs to, for the data
	 * file's contract (issues #993, #2050).
	 *
	 * Only the *contract* is resolved from it - the nearest declaring ancestor,
	 * the rule every other surface applies (`resolveDataContract`) - so a file
	 * missing a column the collection declares is said here rather than at the
	 * first bind, and a picked file declares for that ancestor. Undefined for a
	 * request that belongs to no collection, which has no contract: a pick there
	 * declares nothing and stays a plain run input.
	 */
	collectionId?: string;
	/**
	 * The request being load-tested, as the editor holds it - the draft, not the
	 * stored row - for the audit of which `{{data.*}}` columns it references
	 * that a picked file lacks (issue #2050). Memoise it: it is a dependency of
	 * the audit.
	 */
	request?: ColumnAuditRequest;
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting,
	hasPreRequestScript,
	oauth2Config,
	isStreamingRequest,
	collectionId,
	request,
}: LoadTestConfigDialogProps) {
	/**
	 * The ceilings are a user setting (Settings -> Load testing), so every range
	 * below is resolved rather than read off the constant.
	 */
	const ceilings = useClientSettingsStore((s) => s.loadTestCeilings);
	const limits = useMemo(() => resolveLoadTestLimits(ceilings), [ceilings]);
	/**
	 * The p99 budget and Capacity Discovery's latency budget both start from the
	 * capacity SLO the user already set (Settings -> `sloThresholdMs`), which
	 * until now only annotated a chart.
	 */
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	/**
	 * Server monitoring. The cadence and the metric cap are engine settings
	 * (`monitorIntervalMs` / `monitorMaxSeries`), so the dialog seeds and bounds
	 * itself from them rather than from its own numbers - otherwise the cadence
	 * setting would never apply to a run started here (this dialog always sends
	 * an explicit interval) and a raised cap would still be refused locally.
	 */
	const monitorSettings = useMonitorSettings();
	const { initial, save } = useSavedLoadTestConfig(limits, {
		sloThresholdMs,
		monitorIntervalMs: monitorSettings.defaultIntervalMs,
	});

	const [mode, setMode] = useState(initial.mode);
	const [duration, setDuration] = useState(initial.duration);
	const [rps, setRps] = useState(initial.rps);
	const [concurrency, setConcurrency] = useState(initial.concurrency);
	const [iterations, setIterations] = useState(initial.iterations);
	const [rampDuration, setRampDuration] = useState(initial.rampDuration);
	const [startConcurrency, setStartConcurrency] = useState(initial.startConcurrency);
	const [stepDuration, setStepDuration] = useState(initial.stepDuration);
	const [streamDuration, setStreamDuration] = useState(initial.streamDuration);
	const [streamMaxEvents, setStreamMaxEvents] = useState(initial.streamMaxEvents);
	const [maxInFlight, setMaxInFlight] = useState(initial.maxInFlight);
	const [sampleRate, setSampleRate] = useState(initial.sampleRate);
	const [slowThreshold, setSlowThreshold] = useState(initial.slowThreshold);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(initial.saveTimingBreakdown);
	const [sloMs, setSloMs] = useState(initial.sloMs);
	const [budgets, setBudgets] = useState(initial.budgets);
	const [customBudgets, setCustomBudgets] = useState(initial.customBudgets);
	const [failRun, setFailRun] = useState(initial.failRun);
	const [monitor, setMonitor] = useState(initial.monitor);
	const [comment, setComment] = useState(""); // Per-run: never restored.
	/**
	 * The data set this run binds (issue #993), and the parse failure that
	 * blocks starting one.
	 *
	 * Per-run and deliberately not memoed like the numbers above: rows are user
	 * data of unknown sensitivity, and neither side stores the set - the same
	 * rule the collection run dialog keeps. Picking a file again is the whole
	 * cost of that - which is what the declared-file pre-fill below spares the
	 * user, without the rows ever being what is remembered.
	 */
	const [dataFileError, setDataFileError] = useState<string | null>(null);
	const [oauthGated, setOauthGated] = useState(false);
	const [scriptsOverride, setScriptsOverride] = useState<
		"asMarked" | "allInline" | "allDeferred"
	>(SCRIPTS_DEFAULT);

	/**
	 * Duration is meaningless in `iterations`: the engine stops on
	 * `requests_sent < iterations` and its branch in `load_strategy.cpp` never
	 * reads duration - `docs/engine/api-reference.md` documents the field as
	 * "constant_rps / constant_concurrency / ramp_up". The old dialog showed it
	 * anyway, second on screen, and persisted whatever you typed. It already
	 * half-knew: the OAuth guard is handed `null` in this mode precisely because
	 * a duration-based warning would be nonsense.
	 */
	const usesDuration = mode !== "iterations";

	/*
	 * The chosen file against the contract in scope for this request's
	 * collection - the nearest declaring ancestor, as everywhere else in the
	 * feature (issue #729). A mismatch is a warning and never blocks: a missing
	 * column fails loudly engine-side at bind time, and a file carrying extra
	 * columns is simply a file with extra columns. What it buys is hearing about
	 * it here rather than at the first submission.
	 */
	/*
	 * ...and the file that contract was last run with, pre-filled (issue #1039).
	 *
	 * The same hook the Run collection dialog reads, so the two cannot drift on
	 * which ancestor is consulted or on what a moved file says. What does *not*
	 * come across with it is that dialog's iterations coupling: a load run's
	 * length is its profile's, so nothing about a data file may touch the fields
	 * below. `contract` comes back from the same call because the audit and the
	 * pre-fill are answers about the same declaration.
	 */
	const {
		file: dataFile,
		setFile: setDataFile,
		note: prefillNote,
		contract,
		dismissNote,
		declaringCollectionId,
	} = useDeclaredDataFile(collectionId);
	const writer = useDataContractWriter(declaringCollectionId);

	/*
	 * A pick declares the contract from the picked file (issue #2050), the same
	 * rule as the Run collection dialog and the Data tab: for the collection whose
	 * contract this request binds against, and for nothing when the request is in
	 * no collection. Remove clears it through the picker's `onRemove`, never
	 * here, because a file the picker refuses also arrives as `null`. A declare
	 * that fails leaves the selection alone, so Start still sends the rows.
	 *
	 * Picking by hand also replaces whatever was pre-filled, so the note about a
	 * file that could not be re-read has nothing left to say. And no
	 * `onPrefill`: a load run's length is its profile's, so a file arriving
	 * changes no field of it.
	 */
	const handleSelectDataFile = (next: SelectedDataFile | null) => {
		setDataFile(next);
		if (next) {
			dismissNote();
			writer.declare(next);
		}
	};

	/*
	 * The one request this run sends, audited under its collection's chain (its
	 * `inherit` auth and the chain's scripts are part of what it sends) against
	 * the picked file's columns. The contract diff beside it is for a pre-filled
	 * file that drifted on disk; once a pick's declare lands it is empty by
	 * construction, and the request is what is left to compare against.
	 */
	const auditSubject = useMemo(
		() => ({ collectionId: collectionId ?? null, requests: request ? [request] : [] }),
		[collectionId, request]
	);
	const { audit } = useColumnAudit(auditSubject, dataFile?.parsed.columns ?? NO_COLUMNS);
	const fileWarnings = dataFile
		? [
				...describeDataSchemaDiff(contract?.columns ?? [], dataFile.parsed.columns),
				...describeUnboundReferences(audit.undeclared),
			]
		: [];

	/*
	 * The Headers tab renders the design answer, and it is the tab a user reads
	 * right before opening this dialog (issue #1338). `negotiateCompression`
	 * and `loadNegotiateCompression` are two config keys, so the two scopes can
	 * disagree on `Accept-Encoding` - reading both here is what lets the notice
	 * below say so, rather than the dialog silently starting a run that sends
	 * something different from what the tab just showed.
	 */
	const { data: designDefaults } = useRequestDefaultsQuery("design");
	const { data: loadDefaults } = useRequestDefaultsQuery("load");
	const defaultHeaderDifference = describeDefaultHeaderDifference(designDefaults, loadDefaults);

	const rampDurationError = validateRampDuration(mode, duration, rampDuration);
	// Checked before the two range rules, which both compare the start against
	// the target: a start below the floor is wrong on its own terms, and saying
	// so is more useful than "this would ramp down".
	const startFloorError = validateStartConcurrencyFloor(mode, startConcurrency);
	const startConcurrencyError = validateStartConcurrency(mode, startConcurrency, concurrency);
	const capacityRangeError = validateCapacityRange(mode, startConcurrency, concurrency);
	// One message slot for both budget families: a custom row is refused on the
	// same terms a fixed field is, so the notice below reads the same either way.
	const budgetsError = budgetError(budgets) ?? customBudgetsError(customBudgets);
	const monitoringError = monitorError(monitor, monitorSettings.maxSeries);
	const blockingError =
		rampDurationError ??
		startFloorError ??
		startConcurrencyError ??
		capacityRangeError ??
		budgetsError ??
		monitoringError ??
		// A file the parser refused leaves no rows behind, so starting the run
		// would send the request with its `{{data.*}}` tokens written as they
		// stand - the failure the whole namespace exists to prevent. The picker
		// prints the reason; this is what stops the Start button.
		dataFileError;

	const notices = useMemo(
		() =>
			buildNotices({
				rampDurationError,
				startFloorError,
				startConcurrencyError,
				capacityRangeError,
				budgetsError,
				monitoringError,
				hasPreRequestScript,
				scriptsOverride,
				defaultHeaderDifference,
			}),
		[
			rampDurationError,
			startFloorError,
			startConcurrencyError,
			capacityRangeError,
			budgetsError,
			monitoringError,
			hasPreRequestScript,
			scriptsOverride,
			defaultHeaderDifference,
		]
	);

	const handleStart = () => {
		if (blockingError) return;

		const maxInFlightValue = maxInFlight.trim() !== "" ? Number(maxInFlight) : null;

		save({
			mode,
			duration,
			rps,
			concurrency,
			iterations,
			rampDuration,
			startConcurrency,
			stepDuration,
			sloMs,
			maxInFlight: maxInFlightValue,
			sampleRate,
			slowThreshold,
			saveTimingBreakdown,
			streamDuration,
			streamMaxEvents,
			budgets,
			customBudgets,
			failRun,
			monitor,
		});

		const config: LoadTestConfig = {
			mode,
			// The slider is a percentage; the engine's field is a period. The
			// memo above keeps the percentage, so the control restores to what
			// the user set rather than to a converted number.
			success_sample_period: successSamplePeriod(sampleRate),
			slow_threshold_ms: slowThreshold,
			save_timing_breakdown: saveTimingBreakdown,
			comment: comment || undefined,
			// Absent when nothing was declared - the engine rejects an empty
			// object rather than starting a run no verdict can be computed for.
			thresholds: buildThresholds(budgets, failRun, customBudgets),
			// Absent when no endpoint was given, for the same reason.
			monitor: buildMonitor(monitor),
			// Absent at the default, the same "absent already means what the
			// user asked for" rule `failOnSchemaError` follows on the
			// collection-run dialog (issue #1594).
			...(scriptsOverride !== SCRIPTS_DEFAULT
				? { elements: { scripts: scriptsOverride } }
				: {}),
		};

		// Omitted in `iterations` - see `usesDuration`. Sending a value the engine
		// discards makes the stored run config claim something untrue about it.
		if (usesDuration) config.duration_seconds = duration;

		// The parsed rows themselves - the same array the preview showed, never
		// a re-parse (issue #993). Absent when no file was picked, which is what
		// keeps a run without data on exactly the path it took before.
		//
		// Their column names travel with them (issue #1007): the run composes
		// before it starts, and composition has to be told which bare names a row
		// will bind or it resolves them from the variable scopes first.
		if (dataFile) {
			config.data = dataFile.parsed.rows;
			config.dataColumns = dataFile.parsed.columns;
			config.dataFileName = runDataFileName(dataFile.fileName);
			config.dataFileHash = dataFile.hash;
		}

		// Streaming requests only. Always sent when the request streams, never
		// elided as "the engine has defaults": the engine's default is the
		// user's `sseMaxStreamDurationMs` setting, which the dialog does not
		// show, so eliding would mean the run is bounded by a number the user
		// was never told about while the dialog displayed two others.
		if (isStreamingRequest) {
			config.stream_duration_seconds = streamDuration;
			config.stream_max_events = streamMaxEvents;
		}

		if (mode === "constant_rps") {
			config.rps = rps;
			if (maxInFlightValue != null && maxInFlightValue > 0) {
				config.max_in_flight = maxInFlightValue;
			}
		} else if (mode === "constant_concurrency") {
			config.concurrency = concurrency;
		} else if (mode === "iterations") {
			config.iterations = iterations;
			config.concurrency = concurrency;
		} else if (mode === "ramp_up") {
			config.concurrency = concurrency;
			config.ramp_duration_seconds = rampDuration;
			config.start_concurrency = startConcurrency;
		} else if (mode === "capacity") {
			// `concurrency` is the ceiling the search will not climb past and
			// `start_concurrency` is where it begins - the same two fields the
			// ramp owns, reused rather than respelled, so one cap in Settings
			// bounds both modes.
			config.concurrency = concurrency;
			config.start_concurrency = startConcurrency;
			config.slo_ms = sloMs;
			config.step_duration_seconds = stepDuration;
		}

		onStart(config);
	};

	const num = (set: (n: number) => void) => (raw: string) => set(Number(raw));

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Run a load test</DialogTitle>
					<DialogDescription>
						Pick a profile, set its parameters, then start the run.
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4">
					{notices.map((n) => (
						<div key={n.key}>{n.node}</div>
					))}

					{/*
					 * First field in the dialog, not the last one inside "Recording
					 * & limits": naming the run is what a user does before picking
					 * its profile, not an afterthought behind a collapsed advanced
					 * section - a comment written after the run started is a comment
					 * about a run already forgotten which one it was.
					 */}
					<div className="space-y-1.5">
						<Label htmlFor="lt-comment" className="text-xs">
							Comment
							<span className="ml-1 font-normal text-muted-foreground">
								(optional)
							</span>
						</Label>
						<Input
							id="lt-comment"
							type="text"
							value={comment}
							onChange={(e) => setComment(e.target.value)}
							placeholder="Checkout after the cache change"
							className="text-sm"
						/>
					</div>

					<div className="space-y-1.5">
						<Label className="text-xs">Load profile</Label>
						<ProfilePicker value={mode} onChange={setMode} disabled={isStarting} />
					</div>

					{/* Only the fields this profile actually uses. */}
					<div className="grid grid-cols-2 gap-3">
						{mode === "constant_rps" && (
							<NumberField
								id="lt-rps"
								label="Target rate"
								unit="req/s"
								value={rps}
								onChange={num(setRps)}
								min={limits.RPS.MIN}
								max={limits.RPS.MAX}
							/>
						)}

						{mode !== "constant_rps" && (
							<NumberField
								id="lt-concurrency"
								label={
									mode === "ramp_up"
										? "Target connections"
										: mode === "capacity"
											? "Stop climbing at"
											: "Connections"
								}
								value={concurrency}
								onChange={num(setConcurrency)}
								min={limits.CONCURRENCY.MIN}
								max={limits.CONCURRENCY.MAX}
								hint={
									mode === "capacity"
										? "The ceiling the search will not climb past. Reaching it ends the run."
										: undefined
								}
							/>
						)}

						{mode === "iterations" && (
							<NumberField
								id="lt-iterations"
								label="Requests"
								value={iterations}
								onChange={num(setIterations)}
								min={limits.ITERATIONS.MIN}
								max={limits.ITERATIONS.MAX}
							/>
						)}

						{usesDuration && (
							<NumberField
								id="lt-duration"
								label={
									mode === "ramp_up"
										? "Total duration"
										: mode === "capacity"
											? "Give up after"
											: "Duration"
								}
								unit="s"
								value={duration}
								onChange={num(setDuration)}
								min={limits.DURATION_S.MIN}
								max={limits.DURATION_S.MAX}
							/>
						)}

						{mode === "capacity" && (
							<NumberField
								id="lt-slo"
								label="Latency budget"
								unit="ms"
								value={sloMs}
								onChange={num(setSloMs)}
								min={limits.SLO_MS.MIN}
								max={limits.SLO_MS.MAX}
								hint="The p99 the search looks for the edge of. Prefilled from your SLO setting."
							/>
						)}

						{mode === "capacity" && (
							<NumberField
								id="lt-step-duration"
								label="Hold each level for"
								unit="s"
								value={stepDuration}
								onChange={num(setStepDuration)}
								min={limits.STEP_DURATION_S.MIN}
								max={limits.STEP_DURATION_S.MAX}
								hint="Longer steps measure each level more steadily; shorter ones search faster."
							/>
						)}

						{(mode === "ramp_up" || mode === "capacity") && (
							<NumberField
								id="lt-start-concurrency"
								label="Start from"
								value={startConcurrency}
								onChange={num(setStartConcurrency)}
								min={limits.START_CONCURRENCY.MIN}
								max={limits.START_CONCURRENCY.MAX}
								hint={
									mode === "capacity"
										? "The first level the search measures. It steps up from here while latency holds."
										: "Connections at the start of the ramp. The engine climbs from here to the target."
								}
							/>
						)}

						{mode === "ramp_up" && (
							<NumberField
								id="lt-ramp"
								label="Ramp duration"
								unit="s"
								value={rampDuration}
								onChange={num(setRampDuration)}
								min={limits.RAMP_DURATION_S.MIN}
								max={limits.RAMP_DURATION_S.MAX}
							/>
						)}

						{/*
						 * The stream caps sit with the other run parameters, not
						 * under Advanced: for a streaming request they are what
						 * decides when each transfer ends, which is the same kind
						 * of decision Duration makes for the run. Reaching either
						 * is a *completed* stream, so the hints say so - a user
						 * who read them as timeouts would read the run's 0% error
						 * rate as luck.
						 */}
						{isStreamingRequest && (
							<>
								<NumberField
									id="lt-stream-duration"
									label="Stop each stream after"
									unit="s"
									value={streamDuration}
									onChange={num(setStreamDuration)}
									min={limits.STREAM_DURATION_S.MIN}
									max={limits.STREAM_DURATION_S.MAX}
									hint="A stream that reaches this counts as completed, not as a timeout."
								/>
								<NumberField
									id="lt-stream-events"
									label="Or after this many events"
									value={streamMaxEvents}
									onChange={num(setStreamMaxEvents)}
									min={limits.STREAM_MAX_EVENTS.MIN}
									max={limits.STREAM_MAX_EVENTS.MAX}
									hint="Whichever comes first ends the stream. Under load a stream is always bounded."
								/>
							</>
						)}
					</div>

					<p className="rounded-md border border-border bg-panel px-3 py-2 text-label leading-relaxed text-muted-foreground">
						{summarise(
							{
								mode,
								duration,
								rps,
								concurrency,
								iterations,
								rampDuration,
								startConcurrency,
								stepDuration,
								sloMs,
							},
							blockingError !== null
						)}
					</p>

					{/*
					 * The `elements.scripts` run override (issue #1594), the same
					 * control and the same three values `RunCollectionDialog`'s
					 * Scripts toggle offers. No Timers control here, unlike that
					 * dialog - not because the engine ignores `elements.timers` on
					 * this path (it applies it the same way, `load_strategy.cpp`'s
					 * `step.before` / `step.between` contexts), but because this
					 * dialog offers nothing to override it with yet: a single
					 * request's own `timer.think` is the only timer kind
					 * `requestElements` accepts, and there is no UI here for it at
					 * all, marked or not.
					 *
					 * After the profile summary, not before it: the summary is
					 * still describing the profile fields directly above it, and
					 * Scripts is the first control that is not about the profile.
					 */}
					<div className="flex items-center justify-between gap-4">
						<Label className="leading-snug">
							Scripts
							<span className="block text-xs font-normal text-muted-foreground">
								As marked runs a script inline only where its own element says to;
								the other two override every script this run.
							</span>
						</Label>
						<ToggleGroup
							size="sm"
							aria-label="Scripts"
							value={scriptsOverride}
							onValueChange={(value) => {
								// Radix emits "" when the active segment is clicked
								// again; a choice is not optional here.
								if (
									value === "asMarked" ||
									value === "allInline" ||
									value === "allDeferred"
								) {
									setScriptsOverride(value);
								}
							}}
						>
							<ToggleGroupItem value="asMarked">As marked</ToggleGroupItem>
							<ToggleGroupItem value="allInline">All inline</ToggleGroupItem>
							<ToggleGroupItem value="allDeferred">All deferred</ToggleGroupItem>
						</ToggleGroup>
					</div>

					{/*
					    A data file, for a run that parameterises its request
					    (issue #993). Beside the profile rather than under
					    Recording & limits: rows change what each submission
					    *sends*, which is the same kind of decision the profile
					    fields are, while everything folded away below changes
					    only what the run keeps.

					    `loadTest` is set, so the picker describes what a row
					    means here - one per submission off a shared cursor that
					    wraps - rather than the design-mode "one row is one
					    iteration" reading, which would be wrong for every run
					    this dialog starts.
					 */}
					{/* A file that could not be re-read is a warning, not a blocker -
					    the run is startable without one, and picking the file again
					    is the whole remedy. Same rule, same words, as the Run
					    collection dialog (issue #1039). */}
					{prefillNote && (
						<Callout severity="warning" title="The remembered data file">
							{prefillNote}
						</Callout>
					)}

					{writer.isError && (
						<Callout severity="warning" title="Couldn't update the data contract">
							{writer.error?.message ?? "The engine did not accept the change."}
							<span className="block">
								The run is unaffected. Pick the file again to retry.
							</span>
						</Callout>
					)}

					<DataFilePicker
						selected={dataFile}
						onSelect={handleSelectDataFile}
						// Only with a contract to clear: Remove on a collection that
						// declares nothing has nothing to write.
						onRemove={contract ? writer.clear : undefined}
						error={dataFileError}
						onError={setDataFileError}
						iterations={undefined}
						loadTest
						additionalWarnings={fileWarnings}
						disabled={isStarting}
					/>

					<RecordingSection
						mode={mode}
						limits={limits}
						sampleRate={sampleRate}
						onSampleRateChange={setSampleRate}
						slowThreshold={slowThreshold}
						onSlowThresholdChange={setSlowThreshold}
						maxInFlight={maxInFlight}
						onMaxInFlightChange={setMaxInFlight}
						saveTimingBreakdown={saveTimingBreakdown}
						onSaveTimingBreakdownChange={setSaveTimingBreakdown}
					/>

					<BudgetsSection
						budgets={budgets}
						onBudgetsChange={setBudgets}
						customBudgets={customBudgets}
						onCustomBudgetsChange={setCustomBudgets}
						failRun={failRun}
						onFailRunChange={setFailRun}
						disabled={isStarting}
					/>

					<MonitoringSection
						monitor={monitor}
						onMonitorChange={setMonitor}
						maxSeries={monitorSettings.maxSeries}
					/>

					{/* Sits last because it gates Start, so it reads immediately above it. */}
					{oauth2Config && (
						<OAuth2LoadTestGuard
							config={oauth2Config}
							durationSeconds={usesDuration ? duration : null}
							onGateChange={setOauthGated}
						/>
					)}
				</DialogBody>

				<DialogFooter>
					<DialogCancelButton onClick={onClose} disabled={isStarting} />
					{/* The OAuth2 gate is the one worth a hint: the guard above says
					    what is wrong, but it collapses, and Start then reads as
					    broken. `blockingError` is already on screen beside the field
					    it belongs to, so the reason here only has to point at it. */}
					<DisabledHint
						reason={
							isStarting
								? "Starting the run…"
								: blockingError !== null
									? "Fix the highlighted setting above."
									: oauthGated && "The OAuth 2.0 token check above hasn't passed."
						}
					>
						<Button
							onClick={handleStart}
							disabled={isStarting || blockingError !== null || oauthGated}
						>
							{isStarting ? (
								<>
									<Loader2 className="size-icon animate-spin mr-2" />
									Starting…
								</>
							) : (
								"Start"
							)}
						</Button>
					</DisabledHint>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
