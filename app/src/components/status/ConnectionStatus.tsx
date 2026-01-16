import { Zap, AlertCircle, CheckCircle, Loader2, Cloud, CloudOff } from "lucide-react";
import { useEngineConnectionStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";

function SaveStatusIndicator() {
	const { status, errorMessage } = useSaveStore();

	if (status === "idle") {
		return null;
	}

	if (status === "pending") {
		return (
			<div className="flex items-center gap-1.5 text-muted-foreground">
				<div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
				<span className="text-xs">Unsaved</span>
			</div>
		);
	}

	if (status === "saving") {
		return (
			<div className="flex items-center gap-1.5 text-muted-foreground">
				<Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
				<span className="text-xs">Saving...</span>
			</div>
		);
	}

	if (status === "saved") {
		return (
			<div className="flex items-center gap-1.5 text-success">
				<Cloud className="w-3.5 h-3.5" />
				<span className="text-xs">Saved</span>
			</div>
		);
	}

	if (status === "error") {
		return (
			<div
				className="flex items-center gap-1.5 text-destructive"
				title={errorMessage || "Save failed"}
			>
				<CloudOff className="w-3.5 h-3.5" />
				<span className="text-xs">Save failed</span>
			</div>
		);
	}

	return null;
}

export default function ConnectionStatus() {
	const { isEngineConnected, engineError } = useEngineConnectionStore();

	if (isEngineConnected) {
		return (
			<div className="bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-900 px-4 py-2 flex items-center justify-between text-sm">
				<div className="flex items-center gap-2">
					<CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
					<span className="text-green-800 dark:text-green-200">
						Connected to Vayu Engine
					</span>
				</div>
				<SaveStatusIndicator />
			</div>
		);
	}

	return (
		<div className="bg-destructive/10 border-destructive/20 px-4 py-3 flex items-center gap-2">
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
