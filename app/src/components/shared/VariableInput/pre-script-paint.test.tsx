/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `{{token}}` in a field of a request the engine says runs a pre-request
 * script (`VariableSupport.runsPreRequestScript`, #2741) is not painted as the
 * stored variable: the flag has no names, so any name a scope defines might be
 * the one the script sets. It takes the muted run-time paint and, with nothing
 * stored to edit, opens no popover.
 *
 * Mutation check: stop passing `variables?.runsPreRequestScript` to
 * `classifyVariableToken` in the overlay and the flagged cases fail.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { variableSupportStub } from "@/test/variable-support";
import VariableInput from "./index";

const VARIABLES = { token: { value: "abc", scope: "environment" as const } };

function overlayOf(runs: boolean | undefined, value = "https://x/{{token}}/{{missing}}") {
	const { container } = render(
		<TooltipProvider>
			<VariableInput
				value={value}
				onChange={() => {}}
				placeholder="URL"
				variables={variableSupportStub(VARIABLES, { runsPreRequestScript: runs })}
			/>
		</TooltipProvider>
	);
	const overlay = container.querySelector("[data-variable-overlay]") as HTMLElement;
	expect(overlay).toBeTruthy();
	return overlay;
}

describe("a scope-defined token in a request a pre-request script runs before", () => {
	it("is a muted run-time token, not an editable one", () => {
		const overlay = overlayOf(true, "https://x/{{token}}");
		const runtime = overlay.querySelector("[data-runtime-token] span") as HTMLElement;
		expect(runtime.textContent).toBe("{{token}}");
		expect(runtime.className).toContain("text-muted-foreground");
		expect(overlay.querySelector('[role="button"]')).toBeNull();
	});

	it("leaves a name no scope defines painted as undefined", () => {
		const overlay = overlayOf(true);
		expect(overlay.querySelectorAll("[data-runtime-token]")).toHaveLength(1);
		expect(overlay.querySelector('[role="button"]')?.textContent).toBe("{{missing}}");
	});

	it.each([[false], [undefined]])("is the editable token when the flag is %s", (flag) => {
		const overlay = overlayOf(flag);
		expect(overlay.querySelector("[data-runtime-token]")).toBeNull();
		const buttons = [...overlay.querySelectorAll('[role="button"]')].map((b) => b.textContent);
		expect(buttons).toEqual(["{{token}}", "{{missing}}"]);
	});
});
