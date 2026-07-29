/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A markdown field that reads as prose and edits as text.
 *
 * Click the rendered block to edit it; click away and it renders again. Vayu
 * has stored markdown in descriptions since descriptions existed and rendered
 * none of it - the field even advertised "Markdown supported" beside a plain
 * textarea.
 *
 * **Focus is the trigger, not dirtiness.** The two disagree in both directions -
 * a clean focused field, a dirty blurred one - and focus is the one the user is
 * actually expressing: you are editing because you clicked in. Dirtiness is kept
 * only as a safety catch, via `keepSourceOpen`: a caller whose save failed
 * passes it so unsaved text is never hidden behind a render of what is stored.
 *
 * **The caret goes to the end, not to where you clicked.** Mapping a rendered
 * offset back to a source offset needs a real WYSIWYG editor with position
 * mapping; every implementation of this pattern without one puts the caret at
 * the end, and pretending otherwise would mean a caret that lands somewhere
 * plausible and wrong.
 *
 * **Both modes share a min and max height**, so clicking to edit does not shove
 * the rest of the panel down the screen and blurring does not yank it back up.
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
	 * Hold the source open regardless of focus. For a caller whose save failed:
	 * rendering stored text over unsaved edits would hide the thing that needs
	 * attention.
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
	 * Focus the textarea once it exists, with the caret at the end.
	 *
	 * An effect rather than a callback: `setIsEditing(true)` does not render
	 * synchronously, so anything that runs in the same tick - including a
	 * `requestAnimationFrame` - finds `textareaRef.current` still null and
	 * silently does nothing. Effects run after commit, which is the first moment
	 * the element is there.
	 *
	 * Keyed on `isEditing` and not on `showSource`, so pinning the source open
	 * does not also steal focus from wherever the user was.
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
						className="flex-1 resize-y overflow-y-auto bg-card font-mono text-xs leading-relaxed"
					/>
				) : (
					/*
					 * A button, so the whole block is one keyboard-reachable control
					 * that enters edit mode - the same thing clicking it does. Links
					 * inside the render are their own buttons and stop the click from
					 * bubbling to this one, so following a link does not also drop
					 * you into the source.
					 */
					<div
						role="button"
						tabIndex={0}
						onClick={startEditing}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								startEditing();
							}
						}}
						style={{ minHeight, maxHeight }}
						className={cn(
							"flex-1 cursor-text overflow-y-auto rounded-md border border-transparent px-2 py-1.5 text-left",
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
				 * The escape hatch, and the reason it exists: without it there is no
				 * way to look at your own markdown while reading, and people who
				 * write markdown want that. Obsidian calls the same thing source
				 * mode.
				 */}
				<TooltipIconButton
					label={pinned ? "Show rendered" : "Show markdown source"}
					icon={
						pinned ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />
					}
					onClick={() => setPinned(!pinned)}
					aria-pressed={pinned}
					className={cn(
						"h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground",
						pinned && "text-primary-text"
					)}
				/>
			</div>
		</div>
	);
}
