/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * These assert *structure only*. jsdom announces nothing and does no hit-testing,
 * so nothing here proves a screen reader speaks a toast, and the click test does
 * not prove `pointer-events` is right - the class assertions cover that instead.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useToastStore } from "@/stores";
import Toaster from "./Toaster";

/** Seed without going through showToast(), which arms a real 4s timer. */
function seed(...toasts: { id: string; message: string; variant: "info" | "success" | "error" }[]) {
	useToastStore.setState({ toasts });
}

function toastElementFor(message: string): HTMLElement {
	const el = screen.getByText(message).closest("div");
	if (!el) throw new Error(`no toast element wrapping ${message}`);
	return el as HTMLElement;
}

describe("Toaster", () => {
	beforeEach(() => {
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		cleanup();
		useToastStore.setState({ toasts: [] });
	});

	it("keeps the live region in the DOM when there are no toasts", () => {
		// The whole point of the fix: the region must pre-exist the message, or
		// assistive tech has nothing to observe a change on.
		render(<Toaster />);
		expect(useToastStore.getState().toasts).toHaveLength(0);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("marks that region polite and switches aria-atomic off explicitly", () => {
		render(<Toaster />);
		const region = screen.getByRole("status");
		expect(region).toHaveAttribute("aria-live", "polite");
		/*
		 * `not.toHaveAttribute("aria-atomic", "true")` is not enough, and an
		 * earlier version of this test made exactly that mistake: ARIA gives
		 * `role="status"` an *implicit* `aria-atomic="true"`, so an absent
		 * attribute leaves the region atomic. Chrome's accessibility tree
		 * reported `status atomic live="polite"` with nothing set. Atomic here
		 * re-announces the whole stack on every new toast, so the attribute has
		 * to be present and false.
		 */
		expect(region).toHaveAttribute("aria-atomic", "false");
	});

	it("does not make each toast its own live region", () => {
		seed({ id: "a", message: "Run history cleared", variant: "success" });
		render(<Toaster />);
		const toast = toastElementFor("Run history cleared");
		expect(toast).not.toHaveAttribute("role");
		expect(toast).not.toHaveAttribute("aria-live");
	});

	it("renders a queued toast's message inside the live region", () => {
		seed({ id: "a", message: "Failed to create request", variant: "error" });
		render(<Toaster />);
		const region = screen.getByRole("status");
		expect(region).toContainElement(screen.getByText("Failed to create request"));
	});

	it("lets the viewport pass pointer events through while each toast takes them", () => {
		// jsdom loads no CSS and does no hit-testing, so this is a class-level
		// assertion, not a behavioural one.
		seed({ id: "a", message: "Save failed", variant: "error" });
		render(<Toaster />);
		expect(screen.getByRole("status")).toHaveClass("pointer-events-none");
		expect(toastElementFor("Save failed")).toHaveClass("pointer-events-auto");
	});

	it("dismisses a toast through its labelled button", () => {
		seed({ id: "a", message: "Save failed", variant: "error" });
		render(<Toaster />);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
		expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
		expect(useToastStore.getState().toasts).toHaveLength(0);
		// ...and the region survives the last toast leaving.
		expect(screen.getByRole("status")).toBeInTheDocument();
	});
});
