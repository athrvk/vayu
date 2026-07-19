/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * GeneralPanel
 *
 * System-level, mostly informational app settings. Today: the on-disk storage
 * locations (Electron only). Read-only; kept separate from cosmetic Appearance
 * prefs so "where is my data" has an obvious home.
 */

import { useState, useEffect } from "react";
import { FolderOpen } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

interface AppPaths {
	appDir: string;
	dataDir: string;
	logsPath: string;
	dbPath: string;
}

export default function GeneralPanel() {
	const [appPaths, setAppPaths] = useState<AppPaths | null>(null);

	useEffect(() => {
		window.electronAPI
			?.getAppPaths()
			.then(setAppPaths)
			.catch(() => {});
	}, []);

	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-center gap-2">
					<FolderOpen className="w-5 h-5 text-muted-foreground" />
					<CardTitle className="text-base">Storage Paths</CardTitle>
				</div>
				<CardDescription>File system locations used by the application.</CardDescription>
			</CardHeader>
			<CardContent>
				{appPaths ? (
					<div className="space-y-2">
						{(
							[
								["App directory", appPaths.appDir],
								["Data directory", appPaths.dataDir],
								["Database", appPaths.dbPath],
								["Logs", appPaths.logsPath],
							] as const
						).map(([label, value]) => (
							<div key={label} className="flex flex-col gap-0.5">
								<span className="text-xs font-medium text-muted-foreground">
									{label}
								</span>
								<span className="text-xs font-mono text-foreground break-all">
									{value}
								</span>
							</div>
						))}
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						Storage paths are available in the desktop app.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
