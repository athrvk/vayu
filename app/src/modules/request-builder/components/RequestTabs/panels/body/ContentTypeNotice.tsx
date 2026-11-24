/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Choosing this mode edited your Headers tab, and will put it back." Undo is the impatient form of
 * what the next mode change does anyway (the row goes when the body type no longer needs it); the
 * notice says so, since an edit to an unseen tab reads as permanent otherwise. Its own component to
 * test directly: in the panel it appears only after a Radix Select commits, which a Select does not
 * do in jsdom.
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
		// `/10` and `/30`, the accent tint of the Load Test button and the variable popover.
		<div className="enter-fade flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary-tint px-2.5 py-1.5 text-xs">
			<span>
				Added{" "}
				<code className="font-mono">
					{CONTENT_TYPE}: {value}
				</code>{" "}
				to Headers - removed again when you change body type.
			</span>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					size="sm"
					variant="ghost"
					onClick={onUndo}
					className="h-control-sm px-2 text-xs"
				>
					Undo
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={onDismiss}
					className="h-control-sm px-2 text-xs"
				>
					Dismiss
				</Button>
			</div>
		</div>
	);
}

export default ContentTypeNotice;
