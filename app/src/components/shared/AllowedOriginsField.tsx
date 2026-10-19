/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The "Allowed origins" box on a mock server's and an inbox's start form
 * (#2367): one origin per line, parsed by `parseAllowedOrigins`.
 *
 * Shared because the two forms ask the same question in the same words - which
 * pages in a browser may read this listener - and as two copies the helper text
 * would drift. The parent owns the text and the parse, since it also needs the
 * result to decide whether Start is enabled.
 */

import { Label, Textarea } from "@/components/ui";
import { FieldError } from "./FieldError";

export interface AllowedOriginsFieldProps {
	/** Prefixes the control and error ids, so two forms on one screen cannot collide. */
	id: string;
	value: string;
	onChange: (value: string) => void;
	/** `parseAllowedOrigins(value).error` - the refusal in words, or null. */
	error: string | null;
}

export function AllowedOriginsField({ id, value, onChange, error }: AllowedOriginsFieldProps) {
	const errorId = `${id}-error`;
	return (
		<div className="space-y-1">
			<Label htmlFor={id} className="leading-snug">
				Allowed origins
				<span className="block text-xs font-normal text-muted-foreground">
					Leave empty to allow any origin. List origins to let only those pages read the
					answers, cookies included. One per line, like https://app.example.com.
				</span>
			</Label>
			<Textarea
				id={id}
				rows={3}
				placeholder="https://app.example.com"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="font-mono text-xs"
				aria-invalid={!!error}
				aria-describedby={error ? errorId : undefined}
			/>
			<FieldError id={errorId}>{error}</FieldError>
		</div>
	);
}
