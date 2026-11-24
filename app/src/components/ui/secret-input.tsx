/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A masked text field with an eye to reveal it, the variables table's reveal pattern shared by
 * every secret field (an OAuth 2.0 client secret, a password). A plain `Input`, not
 * `VariableInput`: masking and `{{variable}}` highlighting exclude each other.
 */

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconSwap } from "./icon-swap";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Input, type InputProps } from "./input";

interface SecretInputProps {
	/** Lets a `<Label htmlFor>` bind to the inner input rather than the wrapper. */
	id?: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	/** Forwarded to the `Input`: a dense host (a table cell) states `sm`. */
	size?: InputProps["size"];
	disabled?: boolean;
	/**
	 * Read-only display: revealable, not editable. The eye stays live (revealing is not editing),
	 * unlike `disabled`, which greys it. For a surface showing a secret it cannot edit: the context
	 * bar's request-tab variables row, whose edits land on the Variables page.
	 */
	readOnly?: boolean;
	/** Names the field for a screen reader, e.g. `Value of apiKey`. */
	"aria-label"?: string;
	/**
	 * Blur passthrough, for a host committing on focus-out: the variables table saves there, so
	 * without it the secret field is the one it could not mount this in.
	 */
	onBlur?: React.FocusEventHandler<HTMLInputElement>;
	/** For a host that commits on Enter, such as a create form. */
	onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
	/** The inner input, for a host that returns focus to it after another control took it. */
	ref?: React.Ref<HTMLInputElement>;
}

export function SecretInput({
	id,
	value,
	onChange,
	placeholder,
	className,
	size,
	disabled,
	readOnly,
	"aria-label": ariaLabel,
	onBlur,
	onKeyDown,
	ref,
}: SecretInputProps) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="relative">
			<Input
				ref={ref}
				id={id}
				type={revealed ? "text" : "password"}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				onKeyDown={onKeyDown}
				size={size}
				placeholder={placeholder}
				disabled={disabled}
				readOnly={readOnly}
				aria-label={ariaLabel}
				className={cn("pr-9 font-mono text-sm", className)}
			/>
			<TooltipIconButton
				type="button"
				// In the tab order: it is an affordance on the field, but without a stop a keyboard
				// user could not reveal a Basic-auth password or OAuth client secret to check it,
				// the one thing the control is for. One stop per secret field is a fair price.
				disabled={disabled}
				onClick={() => setRevealed((v) => !v)}
				className="absolute right-0 top-0 h-full w-9 text-muted-foreground hover:text-foreground"
				label={revealed ? "Hide value" : "Show value"}
				aria-pressed={revealed}
				icon={
					<IconSwap
						state={revealed ? "revealed" : "hidden"}
						icons={{
							hidden: <Eye className="size-icon-sm" />,
							revealed: <EyeOff className="size-icon-sm" />,
						}}
					/>
				}
			/>
		</div>
	);
}
