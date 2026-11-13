/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LabelledField - a visible `<Label>` and the one control it names.
 *
 * A `<Label>` written beside its control as a sibling names nothing: a screen
 * reader announces the control by its placeholder, or as a bare "edit text" or
 * "combo box" (#3498). The control is rendered through a function so it can
 * take the `id` the label points at, minted here and unique per instance.
 *
 * `label` is also handed to the control: an input that carries its own
 * `aria-label` (`VariableInput` falls back to its placeholder) is named by that,
 * which outranks the `<label for>`, so it has to be given the label's text.
 */

import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface LabelledControlProps {
	id: string;
	label: string;
}

interface LabelledFieldProps {
	label: string;
	hint?: string;
	className?: string;
	children: (control: LabelledControlProps) => ReactNode;
}

export function LabelledField({ label, hint, className, children }: LabelledFieldProps) {
	const id = useId();
	return (
		<div className={cn("space-y-2", className)}>
			<Label htmlFor={id}>{label}</Label>
			{children({ id, label })}
			{hint && <p className="text-label text-muted-foreground">{hint}</p>}
		</div>
	);
}
