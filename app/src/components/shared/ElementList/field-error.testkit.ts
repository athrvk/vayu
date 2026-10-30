/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a form control carrying a validation message must look like (#3048):
 * `aria-invalid`, the message in a `role="alert"` that the control's
 * `aria-describedby` names, and the destructive border. All three, because the
 * colour alone tells a screen reader nothing and the message alone does not say
 * which field it is about.
 */

import { expect } from "vitest";

export function expectShowsError(control: HTMLElement, message: string) {
	expect(control).toHaveAttribute("aria-invalid", "true");
	const alert = (control.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id))
		.find((el) => el?.getAttribute("role") === "alert");
	expect(alert?.textContent).toBe(message);
	expect(control.className).toContain("border-destructive");
}

export function expectShowsNoError(control: HTMLElement) {
	expect(control).not.toHaveAttribute("aria-invalid");
	expect(control.className).not.toContain("border-destructive");
}
