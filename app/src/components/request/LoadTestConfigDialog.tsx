import { useState } from "react";
import { X } from "lucide-react";
import type { LoadTestConfig } from "@/types";

interface LoadTestConfigDialogProps {
	onClose: () => void;
	onStart: (config: LoadTestConfig) => void;
}

export default function LoadTestConfigDialog({
	onClose,
	onStart,
}: LoadTestConfigDialogProps) {
	const [mode, setMode] = useState<LoadTestConfig["mode"]>("constant_rps");
	const [duration, setDuration] = useState(60);
	const [rps, setRps] = useState(100);
	const [concurrency, setConcurrency] = useState(10);
	const [iterations, setIterations] = useState(1000);
	const [rampDuration, setRampDuration] = useState(30);

	const handleStart = () => {
		const config: LoadTestConfig = {
			mode,
			duration_seconds: duration,
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
						onClick={onClose}
						className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={handleStart}
						className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
					>
						Start Load Test
					</button>
				</div>
			</div>
		</div>
	);
}
