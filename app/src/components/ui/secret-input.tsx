/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SecretInput - a masked text field with an eye toggle to reveal the value.
 * Modeled on the reveal pattern used by the variables table editor, extracted
 * so any secret field (OAuth 2.0 client secret / password, etc.) shares one
 * implementation. Masking and {{variable}} highlighting are mutually exclusive
 * by nature, so this deliberately uses a plain Input rather than VariableInput.
 */

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Input } from "./input";

interface SecretInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
	/**
	 * Read-only display: the value can be revealed but not edited. The eye toggle
	 * stays live (revealing is not editing), unlike `disabled`, which greys it out.
	 * Its host is a surface that shows a secret it does not own the edit path for -
	 * the context bar's request-tab variables row, whose edits land on the
	 * Variables page.
	 */
	readOnly?: boolean;
	/** Names the field for a screen reader, e.g. `Value of apiKey`. */
	"aria-label"?: string;
	/**
	 * Blur passthrough, for a host that commits on focus-out rather than on
	 * every keystroke - the variables table saves there, so without this the
	 * only field it cannot mount this primitive in would be the secret one.
	 */
	onBlur?: React.FocusEventHandler<HTMLInputElement>;
}

export function SecretInput({
	value,
	onChange,
	placeholder,
	className,
	disabled,
	readOnly,
	"aria-label": ariaLabel,
	onBlur,
}: SecretInputProps) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="relative">
			<Input
				type={revealed ? "text" : "password"}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onBlur={onBlur}
				placeholder={placeholder}
				disabled={disabled}
				readOnly={readOnly}
				aria-label={ariaLabel}
				className={cn("pr-9 font-mono text-sm", className)}
			/>
			<TooltipIconButton
				type="button"
				// Was `tabIndex={-1}`, on the reasoning that this is an affordance on
				// the field rather than a form control. True, but the consequence was
				// that a keyboard-only user had no way at all to reveal a Basic-auth
				// password or an OAuth client secret to check what they had typed -
				// the one thing the control exists for. One extra stop per secret
				// field is a fair price.
				disabled={disabled}
				onClick={() => setRevealed((v) => !v)}
				className="absolute right-0 top-0 h-full w-9 text-muted-foreground hover:text-foreground"
				label={revealed ? "Hide value" : "Show value"}
				aria-pressed={revealed}
				icon={
					revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />
				}
			/>
		</div>
	);
}
