/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Choosing this mode edited your Headers tab."
 *
 * Its own component so it can be rendered and tested directly. Inside the panel
 * it only appears after a Radix Select commits a value, and a Select does not
 * commit in jsdom - so a test of the notice through the panel would either not
 * run or pass without exercising anything.
 */

import { Button } from "@/components/ui";
import { CONTENT_TYPE } from "./content-type";

export interface ContentTypeNoticeProps {
	value: string;
	onUndo: () => void;
	onDismiss: () => void;
}

export function ContentTypeNotice({ value, onUndo, onDismiss }: ContentTypeNoticeProps) {
	return (
		// `/10` and `/30`, matching the accent tint the Load Test button and the
		// variable popover already use - not a bespoke opacity.
		<div className="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs">
			<span>
				Added{" "}
				<code className="font-mono">
					{CONTENT_TYPE}: {value}
				</code>{" "}
				to Headers.
			</span>
			<div className="flex shrink-0 items-center gap-1">
				<Button size="sm" variant="ghost" onClick={onUndo} className="h-6 px-2 text-xs">
					Undo
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss} className="h-6 px-2 text-xs">
					Dismiss
				</Button>
			</div>
		</div>
	);
}

export default ContentTypeNotice;
