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
import { validateRampDuration, validateStartConcurrency } from "../../utils/loadTestValidation";
import {
	LOAD_TEST_DEFAULTS,
	clampToRange,
	resolveLoadTestLimits,
	successSamplePeriod,
} from "@/constants/load-test";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { useClientSettingsStore } from "@/stores";
import {
	Button,
	Input,
	Label,
	Switch,
	Textarea,
	ToggleGroup,
	ToggleGroupItem,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { Callout, SEVERITY_ORDER, type Severity } from "@/components/shared";
import { ProfilePicker } from "./ProfilePicker";
import { summarise } from "./summary";
import {
	BUDGET_FIELDS,
	type BudgetDraft,
	budgetError,
	buildThresholds,
	emptyBudgetDraft,
} from "./budgets";
import {
	MONITOR_INTERVAL_MS,
	type MonitorDraft,
	buildMonitor,
	emptyMonitorDraft,
	monitorError,
} from "./monitor";

interface SavedLoadTestConfig {
	mode: LoadTestConfig["mode"];
	duration: number;
	rps: number;
	concurrency: number;
	iterations: number;
	rampDuration: number;
	startConcurrency: number;
	maxInFlight: number | null;
	sampleRate: number;
	slowThreshold: number;
	saveTimingBreakdown: boolean;
	/**
	 * Budgets are memoed as typed, blanks included, so a cleared field stays
	 * cleared. A restored draft is also what tells the p99 prefill it has
	 * already had its turn - without it, declining the SLO budget once would be
	 * undone by the next dialog open.
	 */
	budgets: BudgetDraft;
	/**
	 * The monitoring endpoint, memoed for the same reason the budgets are: it is
	 * a property of the *target* rather than of one run, so retyping a
	 * `/metrics` URL and its metric names for every run is the same friction the
	 * memo exists to remove.
	 */
	monitor: MonitorDraft;
}

function loadSavedConfig(): Partial<SavedLoadTestConfig> {
	try {
		const saved = localStorage.getItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG);
		if (saved) return JSON.parse(saved);
	} catch {
		// Corrupt or unavailable storage - fall back to defaults.
	}
	return {};
}

function saveConfig(config: SavedLoadTestConfig): void {
	try {
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify(config));
	} catch {
		// Quota or private mode - losing the memo is not worth failing the run.
	}
}

/**
 * A labelled number input with its unit inside the field.
 *
 * The unit used to live in the label - "Duration (seconds)", "Target RPS
 * (Requests per second)" - which made labels long and repeated the mode name
 * back at the user. `htmlFor`/`id` are wired because these were bare `<Label>`s
 * next to inputs, associated by proximity only.
 */
function NumberField({
	id,
	label,
	unit,
	value,
	onChange,
	min,
	max,
	placeholder,
	hint,
	optional,
}: {
	id: string;
	label: string;
	unit?: string;
	value: number | string;
	onChange: (raw: string) => void;
	min?: number;
	max?: number;
	placeholder?: string;
	hint?: string;
	optional?: boolean;
}) {
	const hintId = hint ? `${id}-hint` : undefined;
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id} className="text-xs">
				{label}
				{optional && (
					<span className="ml-1 font-normal text-muted-foreground">(optional)</span>
				)}
			</Label>
			<div className="relative">
				<Input
					id={id}
					type="number"
					inputMode="numeric"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					min={min}
					max={max}
					placeholder={placeholder}
					aria-describedby={hintId}
					className={cn("h-9 text-sm", unit && "pr-14")}
				/>
				{unit && (
					<span
						className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground"
						aria-hidden="true"
					>
						{unit}
					</span>
				)}
			</div>
			{hint && (
				<p id={hintId} className="text-[11px] leading-relaxed text-muted-foreground">
					{hint}
				</p>
			)}
		</div>
	);
}

export interface LoadTestConfigDialogProps {
	onClose: () => void;
	onStart: (config: LoadTestConfig) => void;
	isStarting: boolean;
	/** True when the pending request has a non-empty preRequestScript. */
	hasPreRequestScript: boolean;
	/**
	 * True when the request text contains a `{{$dynamic}}` variable. Interpolation
	 * happens app-side, once, before the payload is sent, so every iteration of
	 * the run carries the same generated value - see the notice below.
	 */
	hasDynamicVariables: boolean;
	/** Variable-resolved OAuth 2.0 config, when the effective auth is oauth2. */
	oauth2Config?: OAuth2Config;
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting,
	hasPreRequestScript,
	hasDynamicVariables,
	oauth2Config,
}: LoadTestConfigDialogProps) {
	const saved = loadSavedConfig();

	/**
	 * The ceilings are a user setting (Settings -> Load testing), so every
	 * range below is resolved rather than read off the constant. Restored
	 * values are clamped into it: the memo is written by a past run, and a
	 * ceiling lowered since then would otherwise seed a field above its own
	 * `max` - which a number input shows without complaint.
	 */
	const ceilings = useClientSettingsStore((s) => s.loadTestCeilings);
	const limits = useMemo(() => resolveLoadTestLimits(ceilings), [ceilings]);
	const restore = (value: number | undefined, fallback: number, key: keyof typeof limits) =>
		clampToRange(value ?? fallback, limits[key]);

	const [mode, setMode] = useState<LoadTestConfig["mode"]>(saved.mode ?? LOAD_TEST_DEFAULTS.MODE);
	const [duration, setDuration] = useState(() =>
		restore(saved.duration, LOAD_TEST_DEFAULTS.DURATION_S, "DURATION_S")
	);
	const [rps, setRps] = useState(() => restore(saved.rps, LOAD_TEST_DEFAULTS.RPS, "RPS"));
	const [concurrency, setConcurrency] = useState(() =>
		restore(saved.concurrency, LOAD_TEST_DEFAULTS.CONCURRENCY, "CONCURRENCY")
	);
	const [iterations, setIterations] = useState(() =>
		restore(saved.iterations, LOAD_TEST_DEFAULTS.ITERATIONS, "ITERATIONS")
	);
	const [rampDuration, setRampDuration] = useState(() =>
		restore(saved.rampDuration, LOAD_TEST_DEFAULTS.RAMP_DURATION_S, "RAMP_DURATION_S")
	);
	const [startConcurrency, setStartConcurrency] = useState(() =>
		restore(saved.startConcurrency, LOAD_TEST_DEFAULTS.START_CONCURRENCY, "START_CONCURRENCY")
	);
	const [maxInFlight, setMaxInFlight] = useState<string>(
		saved.maxInFlight != null ? String(saved.maxInFlight) : ""
	);
	// Clamped like the rest, and load-bearing for a second reason: a config
	// saved when the slider's floor was 0 restores that 0, because
	// `saved.sampleRate ?? DEFAULT` keeps a present 0.
	const [sampleRate, setSampleRate] = useState(() =>
		restore(saved.sampleRate, LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT, "SAMPLE_RATE_PCT")
	);
	const [slowThreshold, setSlowThreshold] = useState(
		saved.slowThreshold ?? LOAD_TEST_DEFAULTS.SLOW_THRESHOLD_MS
	);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(
		saved.saveTimingBreakdown ?? LOAD_TEST_DEFAULTS.SAVE_TIMING_BREAKDOWN
	);
	/**
	 * Pass/fail budgets. The p99 field is seeded from the capacity SLO the user
	 * already set (Settings -> `sloThresholdMs`), which until now only annotated
	 * a chart - so the setting becomes the run's default budget rather than a
	 * second, parallel notion of "too slow". Seeded only on a first run: once a
	 * draft has been memoed, a cleared p99 stays cleared.
	 */
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const [budgets, setBudgets] = useState<BudgetDraft>(
		() =>
			saved.budgets ?? {
				...emptyBudgetDraft(),
				latencyP99Ms: String(sloThresholdMs),
			}
	);
	const [budgetsOpen, setBudgetsOpen] = useState(false);
	const [monitor, setMonitor] = useState<MonitorDraft>(
		() => saved.monitor ?? emptyMonitorDraft()
	);
	const [monitorOpen, setMonitorOpen] = useState(false);
	const [comment, setComment] = useState(""); // Per-run: never restored.
	const [oauthGated, setOauthGated] = useState(false);
	const [recordingOpen, setRecordingOpen] = useState(false);

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

	const rampDurationError = validateRampDuration(mode, duration, rampDuration);
	const startConcurrencyError = validateStartConcurrency(mode, startConcurrency, concurrency);
	const budgetsError = budgetError(budgets);
	const monitoringError = monitorError(monitor);
	const blockingError =
		rampDurationError ?? startConcurrencyError ?? budgetsError ?? monitoringError;

	const notices = useMemo(() => {
		const list: { key: string; severity: Severity; node: React.ReactNode }[] = [];

		if (rampDurationError) {
			list.push({
				key: "ramp",
				severity: "blocking",
				node: (
					<Callout severity="blocking" title="Ramp is longer than the run">
						{rampDurationError}
					</Callout>
				),
			});
		}

		if (budgetsError) {
			list.push({
				key: "budgets",
				severity: "blocking",
				node: (
					<Callout severity="blocking" title="A budget is out of range">
						{budgetsError}
					</Callout>
				),
			});
		}

		if (monitoringError) {
			list.push({
				key: "monitor",
				severity: "blocking",
				node: (
					<Callout severity="blocking" title="Server monitoring is incomplete">
						{monitoringError}
					</Callout>
				),
			});
		}

		if (startConcurrencyError) {
			list.push({
				key: "start-concurrency",
				severity: "blocking",
				node: (
					<Callout severity="blocking" title="Ramp would run downwards">
						{startConcurrencyError}
					</Callout>
				),
			});
		}

		if (hasPreRequestScript) {
			list.push({
				key: "pre-script",
				severity: "warning",
				node: (
					<Callout severity="warning" title="Pre-request script will not run">
						Running JS per request would cap throughput, so the load engine skips it.
						Your test script still runs once afterwards, against sampled responses.
					</Callout>
				),
			});
		}

		if (hasDynamicVariables) {
			list.push({
				key: "dynamic-variables",
				severity: "warning",
				node: (
					<Callout severity="warning" title="Dynamic variables are generated once">
						<code>{"{{$guid}}"}</code> and friends are resolved here, before the run
						starts, so every request in it sends the same value. A single Send generates
						a fresh one each time.
					</Callout>
				),
			});
		}

		return list.sort(
			(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		);
	}, [
		rampDurationError,
		startConcurrencyError,
		budgetsError,
		monitoringError,
		hasPreRequestScript,
		hasDynamicVariables,
	]);

	const handleStart = () => {
		if (blockingError) return;

		const maxInFlightValue = maxInFlight.trim() !== "" ? Number(maxInFlight) : null;

		saveConfig({
			mode,
			duration,
			rps,
			concurrency,
			iterations,
			rampDuration,
			startConcurrency,
			maxInFlight: maxInFlightValue,
			sampleRate,
			slowThreshold,
			saveTimingBreakdown,
			budgets,
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
			thresholds: buildThresholds(budgets),
			// Absent when no endpoint was given, for the same reason.
			monitor: buildMonitor(monitor),
		};

		// Omitted in `iterations` - see `usesDuration`. Sending a value the engine
		// discards makes the stored run config claim something untrue about it.
		if (usesDuration) config.duration_seconds = duration;

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
		}

		onStart(config);
	};

	const num = (set: (n: number) => void) => (raw: string) => set(Number(raw));

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Run a load test</DialogTitle>
					<DialogDescription>
						Pick a profile, set its parameters, then start the run.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{notices.map((n) => (
						<div key={n.key}>{n.node}</div>
					))}

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
								label={mode === "ramp_up" ? "Target connections" : "Connections"}
								value={concurrency}
								onChange={num(setConcurrency)}
								min={limits.CONCURRENCY.MIN}
								max={limits.CONCURRENCY.MAX}
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
								label={mode === "ramp_up" ? "Total duration" : "Duration"}
								unit="sec"
								value={duration}
								onChange={num(setDuration)}
								min={limits.DURATION_S.MIN}
								max={limits.DURATION_S.MAX}
							/>
						)}

						{mode === "ramp_up" && (
							<NumberField
								id="lt-start-concurrency"
								label="Start from"
								value={startConcurrency}
								onChange={num(setStartConcurrency)}
								min={limits.START_CONCURRENCY.MIN}
								max={limits.START_CONCURRENCY.MAX}
								hint="Connections at the start of the ramp. The engine climbs from here to the target."
							/>
						)}

						{mode === "ramp_up" && (
							<NumberField
								id="lt-ramp"
								label="Ramp duration"
								unit="sec"
								value={rampDuration}
								onChange={num(setRampDuration)}
								min={limits.RAMP_DURATION_S.MIN}
								max={limits.RAMP_DURATION_S.MAX}
							/>
						)}
					</div>

					<p className="rounded-md border border-border bg-panel px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
						{summarise(
							{
								mode,
								duration,
								rps,
								concurrency,
								iterations,
								rampDuration,
								startConcurrency,
							},
							blockingError !== null
						)}
					</p>

					{/*
					 * Header and contents are one card, not a bordered header with
					 * loose fields under it. The surface used to sit on the trigger,
					 * so opening the disclosure dropped five controls onto the dialog
					 * background with nothing tying them to the row that revealed
					 * them. The card is the design system's panel pattern (`bg-card`
					 * + `border-border` + `rounded-md`, docs/design-system.md
					 * "Cards"), at the same `px-3` inset as the summary box above so
					 * the two read as one column. `panel-clip` is required by the
					 * `overflow-hidden` that keeps the trigger's hover fill inside the
					 * rounded corners - it tucks focus rings inward so the clip cannot
					 * eat them.
					 */}
					<Collapsible
						open={recordingOpen}
						onOpenChange={setRecordingOpen}
						className="panel-clip overflow-hidden rounded-md border border-border surface-card"
					>
						<CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent">
							<span>Recording &amp; limits</span>
							<span className="text-[11px] font-normal text-muted-foreground">
								{recordingOpen ? "Hide" : "Show"}
							</span>
						</CollapsibleTrigger>
						{/*
						    `border-rule`: a divider *inside* the card, so the surface
						    decides its colour rather than this line doing so. `--border`
						    is tuned for the canvas and is the same colour as `--card` in
						    dark (1.003), which is why the divider was not there at all;
						    `surface-card` above resolves it to 1.278 dark / 1.304 light.

						    The card's own outline stays `border-border` - that edge faces
						    the dialog background, where the canvas token is correct.
						 */}
						<CollapsibleContent className="space-y-4 border-t border-rule px-3 py-3">
							<div className="space-y-1.5">
								<Label htmlFor="lt-sample" className="text-xs">
									Success sample rate
									<span className="ml-1.5 font-normal text-muted-foreground">
										keeping {sampleRate}% of successful responses
									</span>
								</Label>
								<input
									id="lt-sample"
									type="range"
									value={sampleRate}
									onChange={(e) => setSampleRate(Number(e.target.value))}
									min={limits.SAMPLE_RATE_PCT.MIN}
									max={limits.SAMPLE_RATE_PCT.MAX}
									className="w-full accent-primary"
								/>
								{/*
								    The left stop is 1%, not 0%. The value is
								    converted to the engine's sampling period, and
								    no period expresses "none" - that is the Save
								    timing breakdown toggle below, which gates
								    storage outright. Errors are never sampled
								    either way; they are always kept.
								 */}
								<div className="flex justify-between text-[11px] text-muted-foreground">
									<span>1% - a trickle</span>
									<span>100% - everything</span>
								</div>
							</div>

							<NumberField
								id="lt-slow"
								label="Slow request threshold"
								unit="ms"
								value={slowThreshold}
								onChange={num(setSlowThreshold)}
								min={limits.SLOW_THRESHOLD_MS.MIN}
								max={limits.SLOW_THRESHOLD_MS.MAX}
								// Outlier capture has its own budget, so it neither spends
								// nor is spent by the sample rate above - but it is still
								// bounded (max_slow_results, 1000), because under
								// saturation nearly every request crosses the threshold.
								// 0 disables the capture rather than flagging everything.
								hint="Requests slower than this are flagged and saved whatever the sample rate, up to a retention limit. 0 turns the capture off."
							/>

							{mode === "constant_rps" && (
								<NumberField
									id="lt-max-inflight"
									label="Max in-flight requests"
									optional
									value={maxInFlight}
									onChange={setMaxInFlight}
									min={limits.MAX_IN_FLIGHT.MIN}
									max={limits.MAX_IN_FLIGHT.MAX}
									placeholder="Auto"
									hint="Hard cap on concurrent in-flight requests. Blank derives it from the target rate. Lowering it drops requests sooner under backpressure; raising it queues instead."
								/>
							)}

							<div className="flex items-start justify-between gap-3">
								<Label
									htmlFor="lt-timing"
									className="text-xs font-normal leading-snug"
								>
									Save timing breakdown
									<span className="block text-[11px] text-muted-foreground">
										DNS, TLS, connect and first-byte, per sampled request.
									</span>
								</Label>
								<Switch
									id="lt-timing"
									checked={saveTimingBreakdown}
									onCheckedChange={setSaveTimingBreakdown}
								/>
							</div>

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
									placeholder="What are you testing?"
									className="h-9 text-sm"
								/>
							</div>
						</CollapsibleContent>
					</Collapsible>

					{/*
					 * Budgets, in the same card treatment as "Recording & limits"
					 * above and for the same reason - a disclosure whose contents
					 * sit on the dialog background reads as loose fields rather
					 * than as the section that revealed them.
					 */}
					<Collapsible
						open={budgetsOpen}
						onOpenChange={setBudgetsOpen}
						className="panel-clip overflow-hidden rounded-md border border-border surface-card"
					>
						<CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent">
							<span>Pass/fail budgets</span>
							<span className="text-[11px] font-normal text-muted-foreground">
								{budgetsOpen ? "Hide" : "Show"}
							</span>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-4 border-t border-rule px-3 py-3">
							<p className="text-[11px] leading-relaxed text-muted-foreground">
								The run is judged against whatever you declare here and reports a
								verdict. Leave a field blank to skip that budget; leave them all
								blank and the run is measured but not judged, as before.
							</p>
							{BUDGET_FIELDS.map((field) => (
								<NumberField
									key={field.key}
									id={field.id}
									label={field.label}
									unit={field.unit}
									optional
									value={budgets[field.key]}
									onChange={(raw) =>
										setBudgets((prev) => ({ ...prev, [field.key]: raw }))
									}
									min={field.min}
									max={field.max}
									placeholder="No budget"
									hint={field.hint}
								/>
							))}
						</CollapsibleContent>
					</Collapsible>

					{/*
					 * Server monitoring, in the same card treatment as the two
					 * disclosures above. Last of the three because it is about the
					 * *target* rather than about the load: a run is fully specified
					 * without it, and it adds a second series to the charts rather
					 * than changing what is sent.
					 */}
					<Collapsible
						open={monitorOpen}
						onOpenChange={setMonitorOpen}
						className="panel-clip overflow-hidden rounded-md border border-border surface-card"
					>
						<CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent">
							<span>Server monitoring</span>
							<span className="text-[11px] font-normal text-muted-foreground">
								{monitorOpen ? "Hide" : "Show"}
							</span>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-4 border-t border-rule px-3 py-3">
							<p className="text-[11px] leading-relaxed text-muted-foreground">
								Scrape the target&apos;s own metrics during the run and chart them
								on the same timeline as p99 and throughput - so a climb in latency
								can be read against the server&apos;s CPU or memory. Leave the URL
								blank to run without it.
							</p>
							<div className="space-y-1.5">
								<Label htmlFor="lt-monitor-url" className="text-xs">
									Metrics endpoint
									<span className="ml-1 font-normal text-muted-foreground">
										(optional)
									</span>
								</Label>
								<Input
									id="lt-monitor-url"
									type="text"
									value={monitor.url}
									onChange={(e) =>
										setMonitor((prev) => ({ ...prev, url: e.target.value }))
									}
									placeholder="http://localhost:9100/metrics"
									className="h-9 text-sm"
								/>
							</div>

							<NumberField
								id="lt-monitor-interval"
								label="Scrape interval"
								unit="ms"
								value={monitor.intervalMs}
								onChange={(raw) =>
									setMonitor((prev) => ({ ...prev, intervalMs: Number(raw) }))
								}
								min={MONITOR_INTERVAL_MS.MIN}
								max={MONITOR_INTERVAL_MS.MAX}
								hint="Each scrape is one request to the endpoint, on its own thread - it never delays the run's own metrics."
							/>

							<div className="space-y-1.5">
								<Label className="text-xs">Response format</Label>
								{/*
								    A segmented control rather than a two-row select:
								    it is a binary choice, and `ToggleGroup` is the
								    app's primitive for one (roving focus and the
								    `data-[state=]` variants come with it).
								 */}
								<ToggleGroup
									size="sm"
									value={monitor.format}
									onValueChange={(value) => {
										// Radix emits "" when the active item is
										// clicked again; a format is not optional, so
										// that deselection is ignored rather than
										// leaving the draft with no format at all.
										if (value === "prometheus" || value === "json") {
											setMonitor((prev) => ({ ...prev, format: value }));
										}
									}}
								>
									<ToggleGroupItem value="prometheus">
										Prometheus text
									</ToggleGroupItem>
									<ToggleGroupItem value="json">Flat JSON</ToggleGroupItem>
								</ToggleGroup>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="lt-monitor-series" className="text-xs">
									Metrics to chart
									<span className="ml-1.5 font-normal text-muted-foreground">
										one name per line, up to 8
									</span>
								</Label>
								<Textarea
									id="lt-monitor-series"
									value={monitor.series}
									onChange={(e) =>
										setMonitor((prev) => ({ ...prev, series: e.target.value }))
									}
									rows={3}
									placeholder={
										"node_cpu_seconds_total\nprocess_resident_memory_bytes"
									}
									className="font-mono text-xs"
								/>
								<p className="text-[11px] text-muted-foreground">
									A Prometheus name is matched across its labels and the values
									summed, so a whole family charts as one line.
								</p>
							</div>
						</CollapsibleContent>
					</Collapsible>

					{/* Sits last because it gates Start, so it reads immediately above it. */}
					{oauth2Config && (
						<OAuth2LoadTestGuard
							config={oauth2Config}
							durationSeconds={usesDuration ? duration : null}
							onGateChange={setOauthGated}
						/>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={isStarting}>
						Cancel
					</Button>
					<Button
						onClick={handleStart}
						disabled={isStarting || blockingError !== null || oauthGated}
					>
						{isStarting ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin mr-2" />
								Starting…
							</>
						) : (
							"Start"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
