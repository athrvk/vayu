/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DialogCancelButton
 *
 * The one way to draw the button that backs out of something (issue #1693).
 *
 * Before this, the same button carried three different variants depending on
 * which dialog you had opened: `outline` (`NewIssuerDialog`,
 * `SaveAsExampleDialog`, `LoadTestConfigDialog`, `StartMockServerDialog`,
 * `RunCollectionDialog`, `ImportModal`), `secondary` (`SaveRunToRequestDialog`,
 * `SpecReimportDialog`, `DeleteConfirmDialog`) and `ghost` (`ExportSpecDialog`,
 * `ClientCertificatesCard`, `VariablePopover`) - plus one hand-rolled `<button>`
 * with a copied class list in `SendWithRowDialog`. Nothing distinguished the
 * three: they are the same word doing the same thing next to the same confirm.
 *
 * `secondary` is the settled answer because it is what `DeleteConfirmDialog`
 * draws, and that is the dialog this app shows most often - it is the shape
 * users already read as "the one that does nothing". `ghost` was the weakest
 * of the three: a declining action that only appears on hover reads as
 * chrome, when it is one of exactly two things the dialog offers.
 *
 * The variant is deliberately not a prop. A caller that can choose is a
 * caller that can drift, which is the defect this replaces. `size` and
 * `className` do pass through: inline forms outside a `DialogFooter` (the new
 * collection row, the client-certificate form) draw the same button at `sm`
 * inside a denser row, and that is a density decision, not a variant one.
 */

import { Button, type ButtonProps } from "./button";

export interface DialogCancelButtonProps extends Omit<
	ButtonProps,
	"variant" | "children" | "asChild"
> {
	/**
	 * The word on the button. Defaults to "Cancel"; "Not now" or "Keep it"
	 * reads better when the dialog interrupted something the user did not
	 * start, and `DeleteConfirmDialog` exposes it as `cancelLabel`.
	 */
	label?: string;
}

export function DialogCancelButton({
	label = "Cancel",
	type = "button",
	...props
}: DialogCancelButtonProps) {
	// `ref` rides in `props`: React 19 passes it as an ordinary prop, so there
	// is no forwardRef wrapper to keep in step with `Button`'s own signature.
	return (
		<Button type={type} variant="secondary" {...props}>
			{label}
		</Button>
	);
}
