/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A visible `<Label>` and the one control it names. A sibling `<Label>` names nothing: a screen
 * reader announces the control by its placeholder, or as a bare "edit text" or "combo box" (#3498).
 * The control renders through a function so it takes the `id` the label points at, minted here and
 * unique per instance. `label` goes to the control too: an input with its own `aria-label`
 * (`VariableInput` falls back to its placeholder) is named by that, which outranks `<label for>`,
 * so it must carry the label's text.
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
