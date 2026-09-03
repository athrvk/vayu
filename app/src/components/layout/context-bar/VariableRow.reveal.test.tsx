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
 * A secret in the context bar can now be looked at (#1308). The row mounts the
 * shared `SecretInput` - masked, with a keyboard-reachable eye - rather than a
 * hand-rolled `••••••` that could never be revealed, and the reveal re-masks when
 * the row's identity changes (an environment or tab switch), the defect #621
 * names when reveal is keyed by position.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VariableRow } from "./VariableRow";
import { TooltipProvider } from "@/components/ui";
import type { ResolvedVariable } from "@/types";

const secret = (sourceId: string): ResolvedVariable => ({
	value: "s3cret",
	scope: "environment",
	sourceId,
	secret: true,
});

function renderRow(resolved: ResolvedVariable) {
	return render(
		<TooltipProvider>
			<VariableRow name="apiKey" resolved={resolved} onCommit={vi.fn()} />
		</TooltipProvider>
	);
}

describe("VariableRow - revealing a secret", () => {
	it("masks the value until the eye is clicked, then shows it", () => {
		renderRow(secret("env_a"));
		const input = screen.getByLabelText("Value of apiKey");

		// Masked: the value is held for the reveal but drawn as a password field.
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveAttribute("readonly");

		fireEvent.click(screen.getByLabelText("Show value"));
		expect(screen.getByLabelText("Value of apiKey")).toHaveAttribute("type", "text");
	});

	it("re-masks when the row's source changes under the same value", () => {
		const { rerender } = renderRow(secret("env_a"));
		fireEvent.click(screen.getByLabelText("Show value"));
		expect(screen.getByLabelText("Value of apiKey")).toHaveAttribute("type", "text");

		// Same name and value, different source: the environment switched. Reveal is
		// keyed by identity, so the field remounts masked rather than leaking the
		// new source's secret.
		rerender(
			<TooltipProvider>
				<VariableRow name="apiKey" resolved={secret("env_b")} onCommit={vi.fn()} />
			</TooltipProvider>
		);
		expect(screen.getByLabelText("Value of apiKey")).toHaveAttribute("type", "password");
	});

	it("does not reveal on hover - only an explicit activation", () => {
		renderRow(secret("env_a"));
		const input = screen.getByLabelText("Value of apiKey");
		fireEvent.mouseOver(input);
		expect(input).toHaveAttribute("type", "password");
	});
});
