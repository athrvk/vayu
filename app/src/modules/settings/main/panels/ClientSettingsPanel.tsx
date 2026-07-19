/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ClientSettingsPanel
 *
 * Shared shell for client-side (app) settings panels — the header (title +
 * description) and the scrolling content column. App panels render only their
 * cards; this shell gives them the same chrome the engine settings view uses,
 * without a Save/Reset bar (client prefs auto-persist).
 */

import type { ReactNode } from "react";

interface ClientSettingsPanelProps {
	title: string;
	description: string;
	children: ReactNode;
}

export default function ClientSettingsPanel({
	title,
	description,
	children,
}: ClientSettingsPanelProps) {
	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header */}
			<div className="border-b border-border px-6 py-4 shrink-0">
				<div className="max-w-3xl mx-auto w-full">
					<h1 className="text-xl font-semibold">{title}</h1>
					<p className="text-sm text-muted-foreground mt-1">{description}</p>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-auto p-6">
				<div className="grid gap-6 max-w-3xl mx-auto">{children}</div>
			</div>
		</div>
	);
}
