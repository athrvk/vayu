import { Zap, AlertCircle, CheckCircle } from "lucide-react";
import { useAppStore } from "@/stores";

export default function ConnectionStatus() {
	const { isEngineConnected, engineError } = useAppStore();

	if (isEngineConnected) {
		return (
			<div className="bg-green-50 dark:bg-green-950/50 border-b border-green-200 dark:border-green-900 px-4 py-2 flex items-center gap-2 text-sm">
				<CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
				<span className="text-green-800 dark:text-green-200">Connected to Vayu Engine</span>
			</div>
		);
	}

	return (
		<div className="bg-destructive/10 border-b border-destructive/20 px-4 py-3 flex items-center gap-2">
			<AlertCircle className="w-5 h-5 text-destructive" />
			<div className="flex-1">
				<p className="text-sm font-medium text-destructive">
					Cannot connect to Vayu Engine
				</p>
				<p className="text-xs text-destructive/80 mt-0.5">
					{engineError || "Make sure the engine is running on port 9876"}
				</p>
			</div>
			<Zap className="w-5 h-5 text-destructive/50" />
		</div>
	);
}
