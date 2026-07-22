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
import { LOAD_TEST_DEFAULTS, LOAD_TEST_LIMITS } from "@/constants/load-test";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	Button,
	Input,
	Label,
	Switch,
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
	/** Variable-resolved OAuth 2.0 config, when the effective auth is oauth2. */
	oauth2Config?: OAuth2Config;
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting,
	hasPreRequestScript,
	oauth2Config,
}: LoadTestConfigDialogProps) {
	const saved = loadSavedConfig();

	const [mode, setMode] = useState<LoadTestConfig["mode"]>(saved.mode ?? LOAD_TEST_DEFAULTS.MODE);
	const [duration, setDuration] = useState(saved.duration ?? LOAD_TEST_DEFAULTS.DURATION_S);
	const [rps, setRps] = useState(saved.rps ?? LOAD_TEST_DEFAULTS.RPS);
	const [concurrency, setConcurrency] = useState(
		saved.concurrency ?? LOAD_TEST_DEFAULTS.CONCURRENCY
	);
	const [iterations, setIterations] = useState(saved.iterations ?? LOAD_TEST_DEFAULTS.ITERATIONS);
	const [rampDuration, setRampDuration] = useState(
		saved.rampDuration ?? LOAD_TEST_DEFAULTS.RAMP_DURATION_S
	);
	const [startConcurrency, setStartConcurrency] = useState(
		saved.startConcurrency ?? LOAD_TEST_DEFAULTS.START_CONCURRENCY
	);
	const [maxInFlight, setMaxInFlight] = useState<string>(
		saved.maxInFlight != null ? String(saved.maxInFlight) : ""
	);
	const [sampleRate, setSampleRate] = useState(
		saved.sampleRate ?? LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT
	);
	const [slowThreshold, setSlowThreshold] = useState(
		saved.slowThreshold ?? LOAD_TEST_DEFAULTS.SLOW_THRESHOLD_MS
	);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(
		saved.saveTimingBreakdown ?? LOAD_TEST_DEFAULTS.SAVE_TIMING_BREAKDOWN
	);
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
	const blockingError = rampDurationError ?? startConcurrencyError;

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

		return list.sort(
			(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		);
	}, [rampDurationError, startConcurrencyError, hasPreRequestScript]);

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
		});

		const config: LoadTestConfig = {
			mode,
			data_sample_rate: sampleRate,
			slow_threshold_ms: slowThreshold,
			save_timing_breakdown: saveTimingBreakdown,
			comment: comment || undefined,
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
								min={LOAD_TEST_LIMITS.RPS.MIN}
								max={LOAD_TEST_LIMITS.RPS.MAX}
							/>
						)}

						{mode !== "constant_rps" && (
							<NumberField
								id="lt-concurrency"
								label={mode === "ramp_up" ? "Target connections" : "Connections"}
								value={concurrency}
								onChange={num(setConcurrency)}
								min={LOAD_TEST_LIMITS.CONCURRENCY.MIN}
								max={LOAD_TEST_LIMITS.CONCURRENCY.MAX}
							/>
						)}

						{mode === "iterations" && (
							<NumberField
								id="lt-iterations"
								label="Requests"
								value={iterations}
								onChange={num(setIterations)}
								min={LOAD_TEST_LIMITS.ITERATIONS.MIN}
								max={LOAD_TEST_LIMITS.ITERATIONS.MAX}
							/>
						)}

						{usesDuration && (
							<NumberField
								id="lt-duration"
								label={mode === "ramp_up" ? "Total duration" : "Duration"}
								unit="sec"
								value={duration}
								onChange={num(setDuration)}
								min={LOAD_TEST_LIMITS.DURATION_S.MIN}
								max={LOAD_TEST_LIMITS.DURATION_S.MAX}
							/>
						)}

						{mode === "ramp_up" && (
							<NumberField
								id="lt-start-concurrency"
								label="Start from"
								value={startConcurrency}
								onChange={num(setStartConcurrency)}
								min={LOAD_TEST_LIMITS.START_CONCURRENCY.MIN}
								max={LOAD_TEST_LIMITS.START_CONCURRENCY.MAX}
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
								min={LOAD_TEST_LIMITS.RAMP_DURATION_S.MIN}
								max={LOAD_TEST_LIMITS.RAMP_DURATION_S.MAX}
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
						className="panel-clip overflow-hidden rounded-md border border-border bg-card"
					>
						<CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent">
							<span>Recording &amp; limits</span>
							<span className="text-[11px] font-normal text-muted-foreground">
								{recordingOpen ? "Hide" : "Show"}
							</span>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-4 border-t border-border px-3 py-3">
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
									min={LOAD_TEST_LIMITS.SAMPLE_RATE_PCT.MIN}
									max={LOAD_TEST_LIMITS.SAMPLE_RATE_PCT.MAX}
									className="w-full accent-primary"
								/>
								<div className="flex justify-between text-[11px] text-muted-foreground">
									<span>0% - errors only</span>
									<span>100% - everything</span>
								</div>
							</div>

							<NumberField
								id="lt-slow"
								label="Slow request threshold"
								unit="ms"
								value={slowThreshold}
								onChange={num(setSlowThreshold)}
								min={LOAD_TEST_LIMITS.SLOW_THRESHOLD_MS.MIN}
								max={LOAD_TEST_LIMITS.SLOW_THRESHOLD_MS.MAX}
								hint="Requests slower than this are flagged and always saved, whatever the sample rate."
							/>

							{mode === "constant_rps" && (
								<NumberField
									id="lt-max-inflight"
									label="Max in-flight requests"
									optional
									value={maxInFlight}
									onChange={setMaxInFlight}
									min={LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MIN}
									max={LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MAX}
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
