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
 * These assert against the DOM Radix actually renders, which was read off a
 * probe render rather than taken from the docs - the docs describe the
 * announcement model but do not pin the markup.
 *
 * jsdom announces nothing, so none of this proves a screen reader speaks a
 * toast. What it does prove is the structural property the hand-rolled version
 * was built around and that a swap could silently drop: the live region exists
 * in the DOM *before* it has content.
 *
 * Variant styling is asserted by rendering and reading `className`, never by
 * scanning this file's source. The variant class arrives through a binding, and
 * a source scan cannot see a class that arrives in a variable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useToastStore, type ToastVariant } from "@/stores/toast-store";
import { TOAST_DURATION_MS, MAX_TOASTS } from "@/stores/toast-store";
import Toaster from "./Toaster";

function show(message: string, variant: ToastVariant = "info") {
	act(() => {
		useToastStore.getState().showToast(message, variant);
	});
}

/** Radix defers the announce text by a frame so the region pre-exists it. */
async function settleFrames() {
	await act(async () => {
		await new Promise((r) => globalThis.requestAnimationFrame(() => r(null)));
		await new Promise((r) => globalThis.requestAnimationFrame(() => r(null)));
	});
}

const announceRegions = () => document.querySelectorAll('span[role="status"]');

function toastElementFor(message: string): HTMLElement {
	const el = screen.getByText(message).closest("li");
	if (!el) throw new Error(`no toast <li> wrapping ${message}`);
	return el;
}

describe("Toaster", () => {
	beforeEach(() => useToastStore.setState({ toasts: [] }));
	afterEach(() => {
		cleanup();
		useToastStore.setState({ toasts: [] });
	});

	describe("the announcement guarantee", () => {
		it("mounts the live region empty, then fills it", async () => {
			// The property the hand-rolled Toaster existed to protect: a region
			// that first appears *together with* its content is commonly not
			// announced at all. Radix reaches it differently - one region per
			// toast rather than one persistent shared region - so this asserts the
			// guarantee, not the old mechanism.
			render(<Toaster />);
			expect(announceRegions()).toHaveLength(0);

			show("database is locked", "error");
			expect(announceRegions()).toHaveLength(1);
			expect(announceRegions()[0]?.textContent).toBe("");

			await settleFrames();
			expect(announceRegions()[0]?.textContent).toContain("database is locked");
		});

		it("keeps every toast polite, including errors", async () => {
			/*
			 * Inherited decision, deliberately re-asserted after the swap. A toast
			 * dismisses itself on a timer and always reports something the user
			 * just asked for, so interrupting what they are reading is the wrong
			 * trade. Radix spells this `type="background"`, which is not visible in
			 * the DOM - what it produces is `aria-live="polite"`. `type="foreground"`
			 * would render "assertive" here, so this assertion is what pins it.
			 */
			render(<Toaster />);
			show("Request failed", "error");
			await settleFrames();
			expect(announceRegions()[0]).toHaveAttribute("aria-live", "polite");
		});

		it("gives each toast its own region rather than one shared one", async () => {
			// Why the old explicit aria-atomic="false" is gone rather than ported:
			// it existed because one region held the whole stack and would
			// re-announce all of it on each arrival. One region per toast makes
			// role="status"'s implicit atomic=true the correct value.
			render(<Toaster />);
			show("first");
			show("second");
			await settleFrames();
			expect(announceRegions()).toHaveLength(2);
		});
	});

	describe("variant signal", () => {
		// Rendered, not scanned: these classes arrive via `variant={toast.variant}`.
		it.each([
			["success", "border-l-status-success", "text-status-success-text"],
			["warning", "border-l-status-warning", "text-status-warning-text"],
			["error", "border-l-status-error", "text-status-error-text"],
			["info", "border-l-border", "text-muted-foreground"],
		] as const)("gives %s its own rail and icon colour", (variant, rail, iconClass) => {
			render(<Toaster />);
			show(`a ${variant} toast`, variant);
			const el = toastElementFor(`a ${variant} toast`);
			expect(el.className).toContain(rail);
			expect(el.querySelector("svg")?.getAttribute("class")).toContain(iconClass);
		});

		it("carries an icon, so the variant does not rest on colour alone", () => {
			// The defect this replaces: variant was a 40%-alpha border and nothing
			// else, which in dark mode left error and info near-identical.
			render(<Toaster />);
			show("Save failed", "error");
			expect(toastElementFor("Save failed").querySelector("svg")).toBeInTheDocument();
		});

		it("never signals a variant with the -fill token", () => {
			// -fill is the solid chip colour, only correct under a white label.
			// Using it as a foreground is the most common colour bug in this repo.
			render(<Toaster />);
			show("Save failed", "error");
			expect(toastElementFor("Save failed").innerHTML).not.toContain("status-error-fill");
		});
	});

	describe("queue policy", () => {
		it("collapses a repeat instead of stacking it", () => {
			// The OAuth2 guard retries and an SSE stream can fail every reconnect;
			// four copies of one sentence say nothing the first did not.
			render(<Toaster />);
			show("Token refresh failed", "error");
			show("Token refresh failed", "error");
			expect(useToastStore.getState().toasts).toHaveLength(1);
			expect(screen.getAllByText("Token refresh failed")).toHaveLength(1);
		});

		it("treats the same text in another variant as a different toast", () => {
			render(<Toaster />);
			show("Done", "success");
			show("Done", "info");
			expect(useToastStore.getState().toasts).toHaveLength(2);
		});

		it("drops the oldest past the cap rather than running off-screen", () => {
			render(<Toaster />);
			for (let i = 0; i < MAX_TOASTS + 2; i++) show(`toast ${i}`);
			const { toasts } = useToastStore.getState();
			expect(toasts).toHaveLength(MAX_TOASTS);
			expect(toasts.map((t) => t.message)).not.toContain("toast 0");
			expect(toasts.map((t) => t.message)).toContain(`toast ${MAX_TOASTS + 1}`);
		});

		it("gives a failure longer to be read than a confirmation", () => {
			expect(TOAST_DURATION_MS.error).toBeGreaterThan(TOAST_DURATION_MS.success);
		});
	});

	describe("dismissal", () => {
		it("dismisses through the labelled close button", () => {
			render(<Toaster />);
			show("Save failed", "error");
			fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
			expect(useToastStore.getState().toasts).toHaveLength(0);
		});

		it("gives the close control a focus ring and a target bigger than its icon", () => {
			// The old button had neither: a 14px hit area with no focused state.
			render(<Toaster />);
			show("Save failed", "error");
			const close = screen.getByRole("button", { name: "Dismiss notification" });
			expect(close.className).toContain("focus-visible:ring-2");
			expect(close.className).toContain("p-1");
		});
	});

	describe("actions", () => {
		it("renders an action and dismisses once it is taken", () => {
			const onClick = vi.fn();
			render(<Toaster />);
			act(() => {
				useToastStore.getState().showToast({
					message: "Couldn't stop the run",
					variant: "error",
					action: { label: "Retry", onClick },
				});
			});
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(onClick).toHaveBeenCalledOnce();
			expect(useToastStore.getState().toasts).toHaveLength(0);
		});

		it("renders a title above the message when one is given", () => {
			render(<Toaster />);
			act(() => {
				useToastStore
					.getState()
					.showToast({ title: "Save failed", message: "database is locked" });
			});
			expect(screen.getByText("Save failed")).toBeInTheDocument();
			expect(screen.getByText("database is locked")).toBeInTheDocument();
		});
	});
});
