/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The message under a control that will not take what you typed. Error text had three presentations
 * and no rule (`Callout`, a full-pane `ErrorState`, and hand-written paragraphs at three sizes).
 * The rule, one line each (`docs/design-system/component-patterns.md`, Component Patterns):
 *
 * - **field-level** - one control rejected one value: `FieldError`.
 * - **block-level** - a condition about the whole form or pane, which may stack with others:
 *   `Callout`.
 * - **pane-level** - the thing you came to look at could not be loaded: `ErrorState`.
 *
 * **One size, `text-xs`**: the sizes were no hierarchy, and a 1px difference between two messages
 * says nothing actionable. **`role="alert"`**: a message appearing after a keystroke is a change a
 * screen reader user is not looking at, so it announces itself; pass `id` and point the control's
 * `aria-describedby` at it, which ties it to that field rather than the form. Renders nothing
 * without a message, so a call site is `<FieldError>{error}</FieldError>`, as `TabCount` swallows a
 * zero.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FieldErrorProps {
	/** The control's `aria-describedby` target. */
	id?: string;
	/**
	 * A leading glyph, for a message found among same-size lines (the import dialog's per-file
	 * rows); a field with one message needs none.
	 */
	icon?: LucideIcon;
	children?: ReactNode;
	/**
	 * `span`, for a phrasing-only parent (a `<label>`, a `<span>`): a `<p>` there is invalid, and
	 * the browser reparents it out of its row.
	 */
	as?: "p" | "span";
	className?: string;
}

export function FieldError({ id, icon: Icon, children, as = "p", className }: FieldErrorProps) {
	if (children === null || children === undefined || children === false || children === "") {
		return null;
	}

	const Tag = as;
	return (
		<Tag
			id={id}
			role="alert"
			className={cn(
				"flex items-center gap-1.5 text-xs text-destructive-text",
				// A `<span>` is inline by default, so the flex row would not take its own line.
				as === "span" && "flex",
				className
			)}
		>
			{Icon && <Icon className="size-icon-sm shrink-0" aria-hidden="true" />}
			{children}
		</Tag>
	);
}
