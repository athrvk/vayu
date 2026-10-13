/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Check, Copy } from "lucide-react";
import { Button, IconSwap } from "@/components/ui";
import { useCopy } from "@/hooks/useCopy";
import { cn } from "@/lib/utils";

export interface CopyForAgentButtonProps {
	/** The line from `lib/agent-reference.ts`, built by the caller from the row's name alone. */
	reference: string;
	/** Names the row, since an icon button has no text: "Copy p95 latency for agent". */
	label: string;
	className?: string;
}

/**
 * The icon form of "Copy for agent" (#2047): a Copy glyph that swaps to a check
 * once the line landed, with no toast beside it (`useCopy({ feedback: "icon" })`).
 * One copy of the control for the dense rows of a list or a form, where a row
 * menu has no room, hence the compact `size-control-sm` hit area.
 */
export function CopyForAgentButton({ reference, label, className }: CopyForAgentButtonProps) {
	const { copy, copied } = useCopy({ feedback: "icon" });

	return (
		<Button
			type="button"
			variant="rowAction"
			size="icon"
			onClick={() => void copy(reference, "Reference")}
			aria-label={label}
			title="Copy for agent"
			className={cn("size-control-sm shrink-0", className)}
		>
			<IconSwap
				state={copied ? "copied" : "copy"}
				icons={{
					copy: <Copy className="size-icon-sm" />,
					copied: <Check className="size-icon-sm text-status-success-text" />,
				}}
			/>
		</Button>
	);
}
