/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorState } from "./ErrorState";

describe("ErrorState", () => {
	it("names what failed and why", () => {
		render(<ErrorState title="Couldn't load collections" detail="Failed to fetch" />);
		expect(screen.getByText("Couldn't load collections")).toBeInTheDocument();
		expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
	});

	it("calls onRetry when the user takes the way out", () => {
		const onRetry = vi.fn();
		render(<ErrorState title="Couldn't load collections" onRetry={onRetry} />);
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("offers no button when there is nothing to retry", () => {
		// A "Try again" that does nothing is worse than no button at all.
		render(<ErrorState title="Couldn't load collections" />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("drops the icon and detail inline, keeping the title and the retry", () => {
		// Inline sits in a small panel, where a 48px icon and a wrapped stack
		// trace would out-weigh whatever it is reporting on.
		const onRetry = vi.fn();
		const { container } = render(
			<ErrorState
				variant="inline"
				title="Couldn't load headers"
				detail="Failed to fetch"
				onRetry={onRetry}
			/>
		);
		expect(screen.getByText("Couldn't load headers")).toBeInTheDocument();
		expect(container.querySelector("svg")).toBeNull();
		expect(screen.queryByText("Failed to fetch")).toBeNull();
		expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
	});
});
