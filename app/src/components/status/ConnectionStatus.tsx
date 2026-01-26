
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useEffect } from "react";
import { Zap, AlertCircle, CheckCircle, Loader2, Cloud, CloudOff, ChevronDown, ChevronRight, Folder, Database, FileText } from "lucide-react";
import { useEngineConnectionStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

function SaveStatusIndicator() {
	const { status, errorMessage } = useSaveStore();

	if (status === "idle") {
		return null;
	}

	if (status === "pending") {
		return (
			<div className="flex items-center gap-1.5 text-warning">
				<div className="w-1.5 h-1.5 bg-warning animate-pulse" />
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
	const [isExpanded, setIsExpanded] = useState(false);
	const [paths, setPaths] = useState<{
		appDir: string;
		dataDir: string;
		logsPath: string;
		dbPath: string;
	} | null>(null);

	// Fetch paths when expanded
	useEffect(() => {
		if (isExpanded && !paths && window.electronAPI) {
			window.electronAPI
				.getAppPaths()
				.then(setPaths)
				.catch((err) => {
					console.error("Failed to get app paths:", err);
				});
		}
	}, [isExpanded, paths]);

	if (isEngineConnected) {
		return (
			<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
				<div className="bg-primary/10 dark:bg-primary/20 border-primary/30 dark:border-primary/40 w-full">
					<CollapsibleTrigger className="w-full px-4 py-2.5 flex items-center justify-between text-sm hover:bg-primary/5 transition-colors">
						<div className="flex items-center gap-2">
							<CheckCircle className="w-4 h-4 text-primary shrink-0" />
							<span className="text-primary dark:text-primary-foreground text-xs">
								Connected to Vayu Engine
							</span>
						</div>
						<div className="flex items-center gap-2">
							<SaveStatusIndicator />
							{isExpanded ? (
								<ChevronDown className="w-4 h-4 text-primary/70 shrink-0" />
							) : (
								<ChevronRight className="w-4 h-4 text-primary/70 shrink-0" />
							)}
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="px-4 pb-3 pt-1 space-y-2 border-t border-primary/20">
							{paths ? (
								<div className="space-y-1.5 text-xs">
									<div className="flex items-start gap-2">
										<Folder className="w-3.5 h-3.5 text-primary/70 mt-0.5 shrink-0" />
										<div className="flex-1 min-w-0">
											<div className="text-muted-foreground">Data Directory</div>
											<div className="font-mono text-foreground break-all">{paths.dataDir}</div>
										</div>
									</div>
									<div className="flex items-start gap-2">
										<FileText className="w-3.5 h-3.5 text-primary/70 mt-0.5 shrink-0" />
										<div className="flex-1 min-w-0">
											<div className="text-muted-foreground">Logs Path</div>
											<div className="font-mono text-foreground break-all">{paths.logsPath}</div>
										</div>
									</div>
									<div className="flex items-start gap-2">
										<Database className="w-3.5 h-3.5 text-primary/70 mt-0.5 shrink-0" />
										<div className="flex-1 min-w-0">
											<div className="text-muted-foreground">Database Path</div>
											<div className="font-mono text-foreground break-all">{paths.dbPath}</div>
										</div>
									</div>
								</div>
							) : (
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
									<span>Loading paths...</span>
								</div>
							)}
						</div>
					</CollapsibleContent>
				</div>
			</Collapsible>
		);
	}

	return (
		<Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
			<div className="bg-destructive/10 dark:bg-destructive/20 border-destructive/30 dark:border-destructive/40 w-full">
				<CollapsibleTrigger className="w-full px-4 py-3 flex items-center gap-2 hover:bg-destructive/5 transition-colors">
					<AlertCircle className="w-5 h-5 text-destructive shrink-0" />
					<div className="flex-1 min-w-0 text-left">
						<p className="text-xs text-destructive">
							Cannot connect to Vayu Engine
						</p>
						<p className="text-xs text-destructive/70 dark:text-destructive/80 mt-0.5">
							{engineError || "Make sure the engine is running on port 9876"}
						</p>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						<Zap className="w-5 h-5 text-destructive/50" />
						{isExpanded ? (
							<ChevronDown className="w-4 h-4 text-destructive/70" />
						) : (
							<ChevronRight className="w-4 h-4 text-destructive/70" />
						)}
					</div>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="px-4 pb-3 pt-1 space-y-2 border-t border-destructive/20">
						{paths ? (
							<div className="space-y-1.5 text-xs">
								<div className="flex items-start gap-2">
									<Folder className="w-3.5 h-3.5 text-destructive/70 mt-0.5 shrink-0" />
									<div className="flex-1 min-w-0">
										<div className="text-destructive/70">Data Directory</div>
										<div className="font-mono text-destructive/90 break-all">{paths.dataDir}</div>
									</div>
								</div>
								<div className="flex items-start gap-2">
									<FileText className="w-3.5 h-3.5 text-destructive/70 mt-0.5 shrink-0" />
									<div className="flex-1 min-w-0">
										<div className="text-destructive/70">Logs Path</div>
										<div className="font-mono text-destructive/90 break-all">{paths.logsPath}</div>
									</div>
								</div>
								<div className="flex items-start gap-2">
									<Database className="w-3.5 h-3.5 text-destructive/70 mt-0.5 shrink-0" />
									<div className="flex-1 min-w-0">
										<div className="text-destructive/70">Database Path</div>
										<div className="font-mono text-destructive/90 break-all">{paths.dbPath}</div>
									</div>
								</div>
							</div>
						) : (
							<div className="flex items-center gap-2 text-xs text-destructive/70">
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
								<span>Loading paths...</span>
							</div>
						)}
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
