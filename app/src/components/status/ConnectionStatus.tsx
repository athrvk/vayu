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
			<div className="flex items-center gap-1.5 text-warning">
				<div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
				<span className="text-xs">Unsaved</span>
			</div>
		);
	}

	if (status === "saving") {
		return (
			<div className="flex items-center gap-1.5 text-primary">
				<Loader2 className="w-3.5 h-3.5 animate-spin" />
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
			<div className="bg-primary/10 dark:bg-primary/20 border-primary/30 dark:border-primary/40 px-4 py-2.5 flex items-center justify-between text-sm w-full">
				<div className="flex items-center gap-2">
					<CheckCircle className="w-4 h-4 text-primary shrink-0" />
					<span className="text-primary dark:text-primary-foreground font-medium">
						Connected to Vayu Engine
					</span>
				</div>
				<SaveStatusIndicator />
			</div>
		);
	}

	return (
		<div className="bg-destructive/10 dark:bg-destructive/20 border-destructive/30 dark:border-destructive/40 px-4 py-3 flex items-center gap-2 w-full">
			<AlertCircle className="w-5 h-5 text-destructive shrink-0" />
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-destructive">
					Cannot connect to Vayu Engine
				</p>
				<p className="text-xs text-destructive/70 dark:text-destructive/80 mt-0.5">
					{engineError || "Make sure the engine is running on port 9876"}
				</p>
			</div>
			<Zap className="w-5 h-5 text-destructive/50 shrink-0" />
		</div>
	);
}
