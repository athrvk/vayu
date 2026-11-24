/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A markdown field that reads as prose and edits as text: click the rendered block to edit, click
 * away and it renders. **Focus is the trigger, not dirtiness**: the two disagree both ways (a clean
 * focused field, a dirty blurred one), and focus is what the user expresses. Dirtiness is only a
 * safety catch, `keepSourceOpen`, which a caller whose save failed passes so unsaved text is never
 * hidden behind the stored render. **The caret goes to the end**, not where you clicked: mapping a
 * rendered offset to source needs a WYSIWYG editor with position mapping, and a guess would land
 * plausibly and wrong. **Both modes share a min and max height**, so entering and leaving edit does
 * not shove the panel.
 */

import { useEffect, useRef, useState } from "react";
import { Code2, Eye } from "lucide-react";
import { MarkdownView } from "./markdown-view";
import { Textarea } from "./textarea";
import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "@/lib/utils";

export interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;
	/** Fired when editing ends, for callers that persist on blur. */
	onCommit?: () => void;
	placeholder?: string;
	/** Shown in place of the render when `value` is empty and unfocused. */
	emptyHint?: string;
	/**
	 * Hold the source open regardless of focus, for a caller whose save failed: rendering stored
	 * text over unsaved edits would hide what needs attention.
	 */
	keepSourceOpen?: boolean;
	minHeight?: string;
	maxHeight?: string;
	className?: string;
	/** Names the textarea, which has no visible label of its own. */
	"aria-label"?: string;
}

export function MarkdownEditor({
	value,
	onChange,
	onCommit,
	placeholder = "Describe this request - what it does, expected response, edge cases…",
	emptyHint = "Add a description…",
	keepSourceOpen = false,
	minHeight = "96px",
	maxHeight = "260px",
	className,
	"aria-label": ariaLabel = "Description",
}: MarkdownEditorProps) {
	const [isEditing, setIsEditing] = useState(false);
	const [pinned, setPinned] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const showSource = isEditing || pinned || keepSourceOpen;

	const startEditing = () => setIsEditing(true);

	/*
	 * Focus the textarea once it exists, caret at the end. An effect, as `setIsEditing(true)` does
	 * not render synchronously: anything in the same tick, `requestAnimationFrame` included, finds
	 * the ref null and does nothing; effects run after commit. Keyed on `isEditing`, not
	 * `showSource`, so pinning the source open steals no focus.
	 */
	useEffect(() => {
		if (!isEditing) return;
		const el = textareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [isEditing]);

	const stopEditing = () => {
		setIsEditing(false);
		onCommit?.();
	};

	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<div className="flex items-start gap-1.5">
				{showSource ? (
					<Textarea
						ref={textareaRef}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onBlur={stopEditing}
						placeholder={placeholder}
						aria-label={ariaLabel}
						style={{ minHeight, maxHeight }}
						className="flex-1 resize-y overflow-y-auto [scrollbar-gutter:auto] bg-card font-mono text-xs leading-relaxed"
					/>
				) : (
					/*
					 * A button, so the block is one keyboard-reachable control entering edit mode,
					 * as a click does. Links in the render are their own buttons and stop the click
					 * bubbling, so following one does not open the source.
					 */
					<div
						role="button"
						tabIndex={0}
						// The label, not the content, which would otherwise name the button: the
						// whole rendered description.
						aria-label={ariaLabel}
						onClick={startEditing}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								startEditing();
							}
						}}
						style={{ minHeight, maxHeight }}
						className={cn(
							"flex-1 cursor-text overflow-y-auto [scrollbar-gutter:auto] rounded-md border border-transparent px-2 py-1.5 text-left",
							"hover:border-rule focus-visible:outline-none focus-visible:border-primary transition-colors"
						)}
					>
						{value.trim() ? (
							<MarkdownView>{value}</MarkdownView>
						) : (
							<span className="text-sm text-muted-foreground">{emptyHint}</span>
						)}
					</div>
				)}

				{/*
				 * The escape hatch: without it there is no way to see your markdown while reading,
				 * which markdown writers want. Obsidian calls it source mode.
				 */}
				<TooltipIconButton
					label={pinned ? "Show rendered" : "Show markdown source"}
					icon={
						pinned ? (
							<Eye className="size-icon-sm" />
						) : (
							<Code2 className="size-icon-sm" />
						)
					}
					onClick={() => setPinned(!pinned)}
					aria-pressed={pinned}
					className={cn(
						"size-target shrink-0 text-muted-foreground hover:text-foreground",
						pinned && "text-primary-text"
					)}
				/>
			</div>
		</div>
	);
}
