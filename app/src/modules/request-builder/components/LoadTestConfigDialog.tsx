/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import type { LoadTestConfig, OAuth2Config } from "@/types";
import OAuth2LoadTestGuard from "./OAuth2LoadTestGuard";
import { validateRampDuration } from "../utils/loadTestValidation";
import { LOAD_TEST_DEFAULTS, LOAD_TEST_LIMITS } from "@/constants/load-test";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	Button,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui";

interface SavedLoadTestConfig {
	mode: LoadTestConfig["mode"];
	duration: number;
	rps: number;
	concurrency: number;
	iterations: number;
	rampDuration: number;
	maxInFlight: number | null;
	sampleRate: number;
	slowThreshold: number;
	saveTimingBreakdown: boolean;
}

function loadSavedConfig(): Partial<SavedLoadTestConfig> {
	try {
		const saved = localStorage.getItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG);
		if (saved) {
			return JSON.parse(saved);
		}
	} catch (e) {
		console.warn("Failed to load saved load test config:", e);
	}
	return {};
}

function saveConfig(config: SavedLoadTestConfig): void {
	try {
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify(config));
	} catch (e) {
		console.warn("Failed to save load test config:", e);
	}
}

interface LoadTestConfigDialogProps {
	onClose: () => void;
	onStart: (config: LoadTestConfig) => void;
	isStarting?: boolean;
	/** True when the pending request has a non-empty preRequestScript.
	 *  Surfaces a warning that pre-request scripts are not executed during
	 *  load tests (engine accepts them only on /request, not /run). */
	hasPreRequestScript?: boolean;
	/** Variable-resolved OAuth 2.0 config for the pending request, when its
	 *  effective auth is oauth2. Enables the token-expiry-vs-duration guard. */
	oauth2Config?: OAuth2Config;
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting = false,
	hasPreRequestScript = false,
	oauth2Config,
}: LoadTestConfigDialogProps) {
	// Load saved config or use defaults
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
	// Max in-flight cap (constant_rps only). Empty string = auto (engine derives
	// a per-strategy default). Kept as a string so the field can be left blank.
	const [maxInFlight, setMaxInFlight] = useState<string>(
		saved.maxInFlight != null ? String(saved.maxInFlight) : ""
	);
	// Data capture options
	const [sampleRate, setSampleRate] = useState(
		saved.sampleRate ?? LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT
	);
	const [slowThreshold, setSlowThreshold] = useState(
		saved.slowThreshold ?? LOAD_TEST_DEFAULTS.SLOW_THRESHOLD_MS
	);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(
		saved.saveTimingBreakdown ?? LOAD_TEST_DEFAULTS.SAVE_TIMING_BREAKDOWN
	);
	const [comment, setComment] = useState(""); // Don't persist comment
	const [oauthGated, setOauthGated] = useState(false);

	const rampDurationError = validateRampDuration(mode, duration, rampDuration);

	const handleStart = () => {
		if (rampDurationError) return;

		const maxInFlightValue = maxInFlight.trim() !== "" ? Number(maxInFlight) : null;

		// Save current config for next time (excluding comment which is per-run)
		saveConfig({
			mode,
			duration,
			rps,
			concurrency,
			iterations,
			rampDuration,
			maxInFlight: maxInFlightValue,
			sampleRate,
			slowThreshold,
			saveTimingBreakdown,
		});

		const config: LoadTestConfig = {
			mode,
			duration_seconds: duration,
			// Data capture options
			data_sample_rate: sampleRate,
			slow_threshold_ms: slowThreshold,
			save_timing_breakdown: saveTimingBreakdown,
			comment: comment || undefined,
		};

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
		}

		onStart(config);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Load Test Configuration</DialogTitle>
					<DialogDescription>
						Choose a load profile and set its parameters before starting the run.
					</DialogDescription>
				</DialogHeader>

				{/* Content */}
				<div className="space-y-4">
					{/* Pre-request script gap warning — engine accepts pre-request
					    scripts on /request but not on /run, so the script will be
					    silently skipped during the load test. */}
					{hasPreRequestScript && (
						<div className="flex gap-2.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] text-warning-text">
							<AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
							<div className="space-y-1">
								<p className="font-semibold">Pre-request script will not run</p>
								<p className="text-[11.5px] text-warning-text/85 leading-relaxed">
									Vayu's load test engine doesn't execute pre-request scripts
									(running JS per request would cap throughput). Your test script
									will still run once after the test, against sampled responses.
								</p>
							</div>
						</div>
					)}

					{/* Mode Selection */}
					<div className="space-y-2">
						<Label>Test Mode</Label>
						<Select
							value={mode}
							onValueChange={(value) => setMode(value as LoadTestConfig["mode"])}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="constant_rps">
									Constant RPS (Requests per second)
								</SelectItem>
								<SelectItem value="constant_concurrency">
									Constant Concurrency
								</SelectItem>
								<SelectItem value="iterations">Fixed Iterations</SelectItem>
								<SelectItem value="ramp_up">Ramp-Up</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{/* Duration */}
					<div className="space-y-2">
						<Label>Duration (seconds)</Label>
						<Input
							type="number"
							value={duration}
							onChange={(e) => setDuration(Number(e.target.value))}
							min={LOAD_TEST_LIMITS.DURATION_S.MIN}
							max={LOAD_TEST_LIMITS.DURATION_S.MAX}
						/>
					</div>

					{/* Mode-specific fields */}
					{mode === "constant_rps" && (
						<>
							<div className="space-y-2">
								<Label>Target RPS (Requests per second)</Label>
								<Input
									type="number"
									value={rps}
									onChange={(e) => setRps(Number(e.target.value))}
									min={LOAD_TEST_LIMITS.RPS.MIN}
									max={LOAD_TEST_LIMITS.RPS.MAX}
								/>
							</div>
							<div className="space-y-2">
								<Label>
									Max in-flight requests{" "}
									<span className="text-muted-foreground font-normal">
										(optional)
									</span>
								</Label>
								<Input
									type="number"
									value={maxInFlight}
									onChange={(e) => setMaxInFlight(e.target.value)}
									min={LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MIN}
									max={LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MAX}
									placeholder="Auto (derived from target RPS)"
								/>
								<p className="text-[11.5px] text-muted-foreground leading-relaxed">
									Hard cap on concurrent in-flight requests. Leave blank to
									auto-derive. Lowering it makes the engine drop requests sooner
									under backpressure; raising it queues instead.
								</p>
							</div>
						</>
					)}

					{(mode === "constant_concurrency" ||
						mode === "iterations" ||
						mode === "ramp_up") && (
						<div className="space-y-2">
							<Label>Concurrency (Concurrent connections)</Label>
							<Input
								type="number"
								value={concurrency}
								onChange={(e) => setConcurrency(Number(e.target.value))}
								min={LOAD_TEST_LIMITS.CONCURRENCY.MIN}
								max={LOAD_TEST_LIMITS.CONCURRENCY.MAX}
							/>
						</div>
					)}

					{mode === "iterations" && (
						<div className="space-y-2">
							<Label>Total Iterations</Label>
							<Input
								type="number"
								value={iterations}
								onChange={(e) => setIterations(Number(e.target.value))}
								min={LOAD_TEST_LIMITS.ITERATIONS.MIN}
								max={LOAD_TEST_LIMITS.ITERATIONS.MAX}
							/>
						</div>
					)}

					{mode === "ramp_up" && (
						<div className="space-y-2">
							<Label>Ramp Duration (seconds)</Label>
							<Input
								type="number"
								value={rampDuration}
								onChange={(e) => setRampDuration(Number(e.target.value))}
								min={LOAD_TEST_LIMITS.RAMP_DURATION_S.MIN}
								max={LOAD_TEST_LIMITS.RAMP_DURATION_S.MAX}
							/>
						</div>
					)}

					{/* Data Capture Options */}
					<div className="border-t pt-4 mt-4">
						<h3 className="text-sm font-semibold text-foreground mb-3">
							Data Capture Options
						</h3>

						<div className="space-y-3">
							<div className="space-y-2">
								<Label>
									Success Sample Rate (%) - Save {sampleRate}% of successful
									responses
								</Label>
								<input
									type="range"
									value={sampleRate}
									onChange={(e) => setSampleRate(Number(e.target.value))}
									min={LOAD_TEST_LIMITS.SAMPLE_RATE_PCT.MIN}
									max={LOAD_TEST_LIMITS.SAMPLE_RATE_PCT.MAX}
									className="w-full accent-primary"
								/>
								<div className="flex justify-between text-xs text-muted-foreground">
									<span>0% (errors only)</span>
									<span>{sampleRate}%</span>
									<span>100% (all requests)</span>
								</div>
							</div>

							<div className="space-y-2">
								<Label>Slow Request Threshold (ms)</Label>
								<Input
									type="number"
									value={slowThreshold}
									onChange={(e) => setSlowThreshold(Number(e.target.value))}
									min={LOAD_TEST_LIMITS.SLOW_THRESHOLD_MS.MIN}
									max={LOAD_TEST_LIMITS.SLOW_THRESHOLD_MS.MAX}
									placeholder="e.g., 1000 (1 second)"
								/>
								<p className="text-xs text-muted-foreground">
									Requests slower than this will be flagged and saved
								</p>
							</div>

							<div className="flex items-center">
								<input
									type="checkbox"
									id="save-timing"
									checked={saveTimingBreakdown}
									onChange={(e) => setSaveTimingBreakdown(e.target.checked)}
									className="mr-2 accent-primary"
								/>
								<Label htmlFor="save-timing" className="font-normal">
									Save detailed timing breakdown (DNS, TLS, Connect, etc.)
								</Label>
							</div>

							<div className="space-y-2">
								<Label>Comment (optional)</Label>
								<Input
									type="text"
									value={comment}
									onChange={(e) => setComment(e.target.value)}
									placeholder="Description for this test run..."
								/>
							</div>
						</div>
					</div>

					{/* Ramp duration validation — total duration must include the ramp. */}
					{rampDurationError && (
						<div className="flex gap-2.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-[12px] text-warning-text">
							<AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
							<p className="leading-relaxed">{rampDurationError}</p>
						</div>
					)}

					{/* Info Box */}
					<div className="p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-200">
						<p className="font-medium mb-1">What will happen:</p>
						{mode === "constant_rps" && (
							<p>
								Maintain {rps} requests/sec for {duration} seconds
							</p>
						)}
						{mode === "constant_concurrency" && (
							<p>
								Keep {concurrency} concurrent connections for {duration} seconds
							</p>
						)}
						{mode === "iterations" && (
							<p>
								Execute {iterations} requests with {concurrency} concurrent
								connections
							</p>
						)}
						{mode === "ramp_up" && (
							<p>
								Gradually increase to {concurrency} concurrent connections over{" "}
								{rampDuration}s, within a total run of {duration}s (the ramp is
								included in the total).
							</p>
						)}
					</div>
				</div>

				{oauth2Config && (
					<div className="mt-4">
						<OAuth2LoadTestGuard
							config={oauth2Config}
							durationSeconds={mode === "iterations" ? null : duration}
							onGateChange={setOauthGated}
						/>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={isStarting}>
						Cancel
					</Button>
					<Button
						onClick={handleStart}
						disabled={isStarting || rampDurationError !== null || oauthGated}
						className="bg-purple-600 hover:bg-purple-700"
					>
						{isStarting ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin mr-2" />
								Starting...
							</>
						) : (
							"Start Load Test"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
