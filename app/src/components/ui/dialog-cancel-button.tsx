/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one way to draw the button that backs out of something (#1693): `outline`, `secondary` and
 * `ghost` had each been used for the same word beside the same confirm. `secondary` because
 * `DeleteConfirmDialog`, the dialog shown most, draws it, so users read it as "the one that does
 * nothing"; `ghost` reads as chrome when it is one of the dialog's two choices. The variant is not
 * a prop: a caller that can choose can drift. `size` and `className` pass through: inline forms
 * outside a `DialogFooter` (the new collection row, the client-certificate form) draw it at `sm` in
 * a denser row, a density decision, not a variant one.
 */

import { Button, type ButtonProps } from "./button";

export interface DialogCancelButtonProps extends Omit<
	ButtonProps,
	"variant" | "children" | "asChild"
> {
	/**
	 * The button's word, "Cancel" by default; "Not now" or "Keep it" reads better when the dialog
	 * interrupted something the user did not start (`DeleteConfirmDialog`'s `cancelLabel`).
	 */
	label?: string;
}

export function DialogCancelButton({
	label = "Cancel",
	type = "button",
	...props
}: DialogCancelButtonProps) {
	// `ref` rides in `props` (React 19 passes it as a prop), so no forwardRef wrapper must track
	// `Button`'s signature.
	return (
		<Button type={type} variant="secondary" {...props}>
			{label}
		</Button>
	);
}
