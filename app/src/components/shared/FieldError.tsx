/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * FieldError - the message under a control that will not take what you typed.
 *
 * Error text had three presentations and no rule saying which to reach for:
 * `Callout` in twenty files, a full-pane `ErrorState`, and hand-written
 * `text-destructive-text` paragraphs in between - at `text-sm`, `text-xs` and
 * `text-[11px]`, some with a leading glyph and some without, some announced and
 * most not. The import dialog alone carried all three sizes.
 *
 * The rule, in one line each (`docs/design-system.md`, Component Patterns):
 *
 * - **field-level** - one control rejected one value: `FieldError`.
 * - **block-level** - a condition about the whole form or pane, which may stack
 *   with others: `Callout`.
 * - **pane-level** - the thing you came to look at could not be loaded:
 *   `ErrorState`.
 *
 * **One size, and it is `text-xs`.** The three sizes were not a hierarchy, they
 * were the order the code was written in; a 1px difference between two messages
 * on the same screen says nothing a reader can act on.
 *
 * **`role="alert"`.** A validation message that appears after a keystroke is a
 * change a screen-reader user is not looking at, so it has to announce itself.
 * Pass `id` and point the control's `aria-describedby` at it as well, which is
 * what names the message as belonging to that field rather than to the form.
 *
 * Renders nothing for no message, so a call site is `<FieldError>{error}</FieldError>`
 * rather than `{error && <FieldError>…</FieldError>}` - the same reason
 * `TabCount` swallows a zero.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FieldErrorProps {
	/** The control's `aria-describedby` target. */
	id?: string;
	/**
	 * A leading glyph, for a message that has to be found among other lines of
	 * the same size - the import dialog's per-file rows. A field with one message
	 * under it needs no icon to be located.
	 */
	icon?: LucideIcon;
	children?: ReactNode;
	/**
	 * `span`, for a parent whose content model is phrasing only - a `<label>`,
	 * or another `<span>`. A `<p>` there is invalid markup that the browser
	 * silently reparents, which moves the message out of the row it belongs to.
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
				// A `<span>` is inline by default, so the flex row above would not
				// take a line of its own.
				as === "span" && "flex",
				className
			)}
		>
			{Icon && <Icon className="size-icon-sm shrink-0" aria-hidden="true" />}
			{children}
		</Tag>
	);
}
