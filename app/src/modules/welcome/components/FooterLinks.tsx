/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * FooterLinks
 *
 * Low-emphasis row shared by both welcome states. Settings opens in-app; the
 * doc links go to the system browser through the keyed `openAppLink` channel
 * (the renderer cannot open arbitrary URLs, and a plain anchor would spawn an
 * unmanaged Electron window).
 */

import { useTabsStore } from "@/stores";

const linkClass =
	"text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm";

export function FooterLinks() {
	const { openTab } = useTabsStore();

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
			<button
				type="button"
				className={linkClass}
				onClick={() => openTab({ type: "settings", entityId: null })}
			>
				Settings
			</button>
			<button
				type="button"
				className={linkClass}
				onClick={() => window.electronAPI?.openAppLink("scripting")}
			>
				Scripting docs
			</button>
			<button
				type="button"
				className={linkClass}
				onClick={() => window.electronAPI?.openAppLink("docs")}
			>
				Documentation
			</button>
		</div>
	);
}
