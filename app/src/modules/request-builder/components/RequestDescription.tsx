/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestDescription
 *
 * Collapsible description editor that sits between UrlBar and RequestTabs.
 * - Empty state: ghost "✎ Add description…" button
 * - Open state: Textarea bound to request.description
 * - Saves to context on blur
 */

import { useEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { Textarea } from "@/components/ui";
import { useRequestBuilderContext } from "../context";

export default function RequestDescription() {
	const { request, updateField, saveRequest } = useRequestBuilderContext();
	const description = request.description ?? "";

	const [open, setOpen] = useState(description.length > 0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-open when the request has description content, and stay open (sticky)
	// until the user explicitly closes it or blurs an empty field. This can't be
	// derived from `description.length` without losing stickiness — collapsing the
	// editor the instant the field becomes empty would yank the textarea out from
	// under an active edit. Justified setState-in-effect.
	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (description.length > 0) setOpen(true);
	}, [description.length]);

	if (!open) {
		return (
			<div className="px-4 py-1.5 border-b border-border bg-panel shrink-0">
				<button
					type="button"
					onClick={() => {
						setOpen(true);
						setTimeout(() => textareaRef.current?.focus(), 0);
					}}
					className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
				>
					<Pencil className="w-3.5 h-3.5" />
					Add description…
				</button>
			</div>
		);
	}

	return (
		<div className="px-4 py-2 border-b border-border bg-panel shrink-0">
			<div className="flex items-start gap-2">
				<Textarea
					ref={textareaRef}
					value={description}
					onChange={(e) => updateField("description", e.target.value)}
					onBlur={() => {
						void saveRequest();
						if (description.length === 0) setOpen(false);
					}}
					placeholder="Describe this request — what it does, expected response, edge cases…"
					className="min-h-[48px] max-h-[160px] text-[13px] leading-relaxed resize-y bg-card"
				/>
				{description.length === 0 && (
					<button
						type="button"
						onClick={() => setOpen(false)}
						className="shrink-0 p-1 rounded-md text-muted-foreground hover:bg-accent transition-colors"
						aria-label="Close description"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				)}
			</div>
		</div>
	);
}
