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
 * The stop control both run surfaces share. Two callers depend on this
 * contract - the load dashboard header and the collection-run tab - and neither
 * renders the markup itself any more, so the pending state is pinned here once
 * rather than in each of them.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StopRunButton } from "./StopRunButton";

describe("StopRunButton", () => {
	it("calls back when clicked", () => {
		const onStop = vi.fn();
		render(<StopRunButton onStop={onStop} />);

		fireEvent.click(screen.getByRole("button", { name: /^stop/i }));

		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("refuses a second click while a stop is in flight", () => {
		const onStop = vi.fn();
		render(<StopRunButton onStop={onStop} isStopping />);

		const button = screen.getByRole("button", { name: /stopping/i });
		expect((button as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(button);
		expect(onStop).not.toHaveBeenCalled();
	});

	it("labels the destructive action with the text token, never the fill", () => {
		// `text-destructive` is the fill token used as a foreground - the colour
		// bug this repo hits most. The pair is close enough that only the class
		// name tells them apart.
		const { container } = render(<StopRunButton onStop={() => {}} />);
		const className = container.querySelector("button")!.className;

		expect(className).toContain("text-destructive-text");
		expect(className).not.toMatch(/(^|\s)text-destructive(\s|$)/);
	});
});
