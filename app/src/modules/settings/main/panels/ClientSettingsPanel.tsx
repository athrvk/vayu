/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ClientSettingsPanel
 *
 * Shared shell for client-side (app) settings panels - the header (title +
 * description) and the scrolling content column. App panels render only their
 * cards; this shell gives them the same chrome the engine settings view uses,
 * without a Save/Reset bar (client prefs auto-persist).
 */

import type { ReactNode } from "react";
import { useRevealedSetting } from "../../useRevealedSetting";

interface ClientSettingsPanelProps {
	title: string;
	description: string;
	/**
	 * One line saying when edits are persisted. Every app panel states it -
	 * seven of them from one string - because the app autosaves, the engine view
	 * has a Save bar and MCP commits on blur, and until now nothing on screen
	 * told you which of the three you were in.
	 */
	saveNote: string;
	children: ReactNode;
}

export default function ClientSettingsPanel({
	title,
	description,
	saveNote,
	children,
}: ClientSettingsPanelProps) {
	// A search result can name a setting inside the panel, not just the panel.
	useRevealedSetting();

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header */}
			<div className="border-b border-border px-6 py-4 shrink-0">
				<div className="max-w-3xl mx-auto w-full">
					<h1 className="text-xl font-semibold">{title}</h1>
					<p className="text-sm text-muted-foreground mt-1">{description}</p>
					<p className="text-xs text-muted-foreground mt-1.5">{saveNote}</p>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-auto p-6">
				<div className="grid gap-6 max-w-3xl mx-auto">{children}</div>
			</div>
		</div>
	);
}
