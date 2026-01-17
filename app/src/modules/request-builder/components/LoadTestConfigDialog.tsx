import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { LoadTestConfig } from "@/types";
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
	DialogFooter,
} from "@/components/ui";

const LOAD_TEST_CONFIG_KEY = "vayu:lastLoadTestConfig";

interface SavedLoadTestConfig {
	mode: LoadTestConfig["mode"];
	duration: number;
	rps: number;
	concurrency: number;
	iterations: number;
	rampDuration: number;
	sampleRate: number;
	slowThreshold: number;
	saveTimingBreakdown: boolean;
}

function loadSavedConfig(): Partial<SavedLoadTestConfig> {
	try {
		const saved = localStorage.getItem(LOAD_TEST_CONFIG_KEY);
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
		localStorage.setItem(LOAD_TEST_CONFIG_KEY, JSON.stringify(config));
	} catch (e) {
		console.warn("Failed to save load test config:", e);
	}
}

interface LoadTestConfigDialogProps {
	onClose: () => void;
	onStart: (config: LoadTestConfig) => void;
	isStarting?: boolean;
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
	isStarting = false,
}: LoadTestConfigDialogProps) {
	// Load saved config or use defaults
	const saved = loadSavedConfig();

	const [mode, setMode] = useState<LoadTestConfig["mode"]>(saved.mode ?? "constant_rps");
	const [duration, setDuration] = useState(saved.duration ?? 60);
	const [rps, setRps] = useState(saved.rps ?? 100);
	const [concurrency, setConcurrency] = useState(saved.concurrency ?? 10);
	const [iterations, setIterations] = useState(saved.iterations ?? 1000);
	const [rampDuration, setRampDuration] = useState(saved.rampDuration ?? 30);
	// Data capture options
	const [sampleRate, setSampleRate] = useState(saved.sampleRate ?? 10);
	const [slowThreshold, setSlowThreshold] = useState(saved.slowThreshold ?? 1000);
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(
		saved.saveTimingBreakdown ?? true
	);
	const [comment, setComment] = useState(""); // Don't persist comment

	const handleStart = () => {
		// Save current config for next time (excluding comment which is per-run)
		saveConfig({
			mode,
			duration,
			rps,
			concurrency,
			iterations,
			rampDuration,
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
				</DialogHeader>

				{/* Content */}
				<div className="space-y-4">
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
							min={1}
							max={3600}
						/>
					</div>

					{/* Mode-specific fields */}
					{mode === "constant_rps" && (
						<div className="space-y-2">
							<Label>Target RPS (Requests per second)</Label>
							<Input
								type="number"
								value={rps}
								onChange={(e) => setRps(Number(e.target.value))}
								min={1}
								max={50000}
							/>
						</div>
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
								min={1}
								max={1000}
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
								min={1}
								max={1000000}
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
								min={1}
								max={3600}
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
									min="0"
									max="100"
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
									min={0}
									max={60000}
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
								{rampDuration}s, then maintain for {duration}s
							</p>
						)}
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={isStarting}>
						Cancel
					</Button>
					<Button
						onClick={handleStart}
						disabled={isStarting}
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
