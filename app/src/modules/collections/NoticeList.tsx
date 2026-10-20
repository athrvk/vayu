/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import type { ImportNotice, NoticeTier } from "./import-notices";

/**
 * What a file lost or changed, one line each (see `import-notices.ts`): amber
 * for what the user has to finish by hand, muted for what the import decided.
 * Neither is an error - the file imported - so neither is announced as an
 * alert. `as="span"` for a host that is itself phrasing content (a ledger
 * row's `<label>`).
 */
export function NoticeList({
	notices,
	as: Tag = "div",
}: {
	notices: readonly ImportNotice[];
	as?: "div" | "span";
}) {
	if (notices.length === 0) return null;
	return (
		<Tag role="status" className="block space-y-0.5">
			{notices.map((notice, i) => (
				<NoticeLine key={i} tier={notice.tier}>
					{notice.link ? (
						<span>
							{notice.text} <NoticeLink link={notice.link} />
						</span>
					) : (
						notice.text
					)}
				</NoticeLine>
			))}
		</Tag>
	);
}

/**
 * The line's way to read more. A button, not an anchor: the renderer cannot
 * open a URL, only ask the main process for one of its keyed links (a plain
 * `<a target="_blank">` would spawn an unmanaged Electron window).
 */
function NoticeLink({ link }: { link: NonNullable<ImportNotice["link"]> }) {
	return (
		<Button
			variant="link"
			size="sm"
			className="h-auto p-0 text-xs align-baseline"
			onClick={() => window.electronAPI?.openAppLink(link.key)}
		>
			{link.label}
		</Button>
	);
}

/**
 * One follow-up line about a file that imported. A `span`, so it is valid
 * inside a `<label>`; no `role`, so a screen reader hears it through the
 * polite `status` of its list rather than as a stack of alerts.
 */
export function NoticeLine({ tier, children }: { tier: NoticeTier; children: ReactNode }) {
	const Icon = tier === "action" ? AlertTriangle : Info;
	return (
		<span
			className={`flex items-start gap-1.5 text-xs ${
				tier === "action" ? "text-warning-text" : "text-muted-foreground"
			}`}
		>
			<Icon className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
			{children}
		</span>
	);
}
