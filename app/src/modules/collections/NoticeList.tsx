/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { AlertTriangle, Info } from "lucide-react";
import { FieldError } from "@/components/shared";
import type { ImportNotice } from "./import-notices";

/**
 * What a file lost or changed, one line each (see `import-notices.ts`): red
 * for what the user has to finish by hand, muted for what the import decided.
 * `as="span"` for a host that is itself phrasing content (a ledger row's
 * `<label>`).
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
		<Tag className="block space-y-0.5">
			{notices.map((notice, i) =>
				notice.tier === "action" ? (
					<FieldError key={i} as="span" icon={AlertTriangle}>
						{notice.text}
					</FieldError>
				) : (
					<span
						key={i}
						className="flex items-start gap-1.5 text-xs text-muted-foreground"
					>
						<Info className="mt-0.5 size-icon-sm shrink-0" />
						{notice.text}
					</span>
				)
			)}
		</Tag>
	);
}
