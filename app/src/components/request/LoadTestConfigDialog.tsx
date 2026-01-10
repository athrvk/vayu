import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import type { LoadTestConfig } from "@/types";

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
	const [mode, setMode] = useState<LoadTestConfig["mode"]>("constant_rps");
	const [duration, setDuration] = useState(60);
	const [rps, setRps] = useState(100);
	const [concurrency, setConcurrency] = useState(10);
	const [iterations, setIterations] = useState(1000);
	const [rampDuration, setRampDuration] = useState(30);
	// Data capture options
	const [sampleRate, setSampleRate] = useState(10); // Default 10%
	const [slowThreshold, setSlowThreshold] = useState(1000); // Default 1000ms
	const [saveTimingBreakdown, setSaveTimingBreakdown] = useState(true);
	const [comment, setComment] = useState("");

	const handleStart = () => {
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
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
			<div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b border-gray-200">
					<h2 className="text-lg font-semibold text-gray-900">
						Load Test Configuration
					</h2>
					<button
						onClick={onClose}
						className="p-1 hover:bg-gray-100 rounded transition-colors"
					>
						<X className="w-5 h-5 text-gray-500" />
					</button>
				</div>

				{/* Content */}
				<div className="p-6 space-y-4">
					{/* Mode Selection */}
					<div>
						<label className="block text-sm font-medium text-gray-700 mb-2">
							Test Mode
						</label>
						<select
							value={mode}
							onChange={(e) =>
								setMode(e.target.value as LoadTestConfig["mode"])
							}
							className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
						>
							<option value="constant_rps">
								Constant RPS (Requests per second)
							</option>
							<option value="constant_concurrency">Constant Concurrency</option>
							<option value="iterations">Fixed Iterations</option>
							<option value="ramp_up">Ramp-Up</option>
						</select>
					</div>

					{/* Duration */}
					<div>
						<label className="block text-sm font-medium text-gray-700 mb-2">
							Duration (seconds)
						</label>
						<input
							type="number"
							value={duration}
							onChange={(e) => setDuration(Number(e.target.value))}
							min="1"
							max="3600"
							className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
						/>
					</div>

					{/* Mode-specific fields */}
					{mode === "constant_rps" && (
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-2">
								Target RPS (Requests per second)
							</label>
							<input
								type="number"
								value={rps}
								onChange={(e) => setRps(Number(e.target.value))}
								min="1"
								max="50000"
								className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
							/>
						</div>
					)}

					{(mode === "constant_concurrency" ||
						mode === "iterations" ||
						mode === "ramp_up") && (
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-2">
								Concurrency (Concurrent connections)
							</label>
							<input
								type="number"
								value={concurrency}
								onChange={(e) => setConcurrency(Number(e.target.value))}
								min="1"
								max="1000"
								className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
							/>
						</div>
					)}

					{mode === "iterations" && (
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-2">
								Total Iterations
							</label>
							<input
								type="number"
								value={iterations}
								onChange={(e) => setIterations(Number(e.target.value))}
								min="1"
								max="1000000"
								className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
							/>
						</div>
					)}

					{mode === "ramp_up" && (
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-2">
								Ramp Duration (seconds)
							</label>
							<input
								type="number"
								value={rampDuration}
								onChange={(e) => setRampDuration(Number(e.target.value))}
								min="1"
								max="3600"
								className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
							/>
						</div>
					)}

					{/* Data Capture Options */}
					<div className="border-t pt-4 mt-4">
						<h3 className="text-sm font-semibold text-gray-700 mb-3">Data Capture Options</h3>

						<div className="space-y-3">
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-2">
									Success Sample Rate (%) - Save {sampleRate}% of successful responses
								</label>
								<input
									type="range"
									value={sampleRate}
									onChange={(e) => setSampleRate(Number(e.target.value))}
									min="0"
									max="100"
									className="w-full"
								/>
								<div className="flex justify-between text-xs text-gray-500">
									<span>0% (errors only)</span>
									<span>{sampleRate}%</span>
									<span>100% (all requests)</span>
								</div>
							</div>

							<div>
								<label className="block text-sm font-medium text-gray-700 mb-2">
									Slow Request Threshold (ms)
								</label>
								<input
									type="number"
									value={slowThreshold}
									onChange={(e) => setSlowThreshold(Number(e.target.value))}
									min="0"
									max="60000"
									className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
									placeholder="e.g., 1000 (1 second)"
								/>
								<p className="text-xs text-gray-500 mt-1">
									Requests slower than this will be flagged and saved
								</p>
							</div>

							<div className="flex items-center">
								<input
									type="checkbox"
									id="save-timing"
									checked={saveTimingBreakdown}
									onChange={(e) => setSaveTimingBreakdown(e.target.checked)}
									className="mr-2"
								/>
								<label htmlFor="save-timing" className="text-sm text-gray-700">
									Save detailed timing breakdown (DNS, TLS, Connect, etc.)
								</label>
							</div>

							<div>
								<label className="block text-sm font-medium text-gray-700 mb-2">
									Comment (optional)
								</label>
								<input
									type="text"
									value={comment}
									onChange={(e) => setComment(e.target.value)}
									className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
									placeholder="Description for this test run..."
								/>
							</div>
						</div>
					</div>

					{/* Info Box */}
					<div className="p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800">
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

				{/* Footer */}
				<div className="flex justify-end gap-3 p-4 border-t border-gray-200">
					<button
						disabled={isStarting}
						className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={handleStart}
						disabled={isStarting}
						className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{isStarting ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin" />
								Starting...
							</>
						) : (
							"Start Load Test"
						)}
						Start Load Test
					</button>
				</div>
			</div>
		</div>
	);
}
