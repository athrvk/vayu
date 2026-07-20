import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";

function open(props: Partial<React.ComponentProps<typeof DeleteConfirmDialog>> = {}) {
	return render(
		<DeleteConfirmDialog
			open
			onOpenChange={vi.fn()}
			title="Delete request?"
			description="This cannot be undone."
			onConfirm={vi.fn()}
			{...props}
		/>
	);
}

const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("DeleteConfirmDialog", () => {
	// DialogContent renders a close "X" as its first focusable child, so Radix's
	// default open-focus lands there and neither action appears focused — most
	// visible when the dialog was opened by keyboard (Delete on a tree row).
	it("focuses Cancel on open, not the close button", async () => {
		open();
		await waitFor(() => expect(document.activeElement).toBe(btn(/^Cancel$/)));
	});

	it("moves between actions with Left and Right", async () => {
		open();
		await waitFor(() => expect(document.activeElement).toBe(btn(/^Cancel$/)));

		fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
		expect(document.activeElement).toBe(btn(/^Delete$/));

		fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(btn(/^Cancel$/));
	});

	it("wraps around at both ends", async () => {
		open();
		await waitFor(() => expect(document.activeElement).toBe(btn(/^Cancel$/)));

		fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(btn(/^Delete$/));

		fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
		expect(document.activeElement).toBe(btn(/^Cancel$/));
	});

	// Focus starts on the safe action so a reflexive Enter cancels rather than
	// deletes — the dialog is often reached by pressing Delete in the first place.
	it("confirms only when Delete is chosen", async () => {
		const onConfirm = vi.fn();
		open({ onConfirm });
		await waitFor(() => expect(document.activeElement).toBe(btn(/^Cancel$/)));

		fireEvent.click(document.activeElement!);
		expect(onConfirm).not.toHaveBeenCalled();

		fireEvent.click(btn(/^Delete$/));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("skips disabled actions while deleting", async () => {
		open({ isDeleting: true });
		// Both actions are disabled mid-delete, so arrows have nothing to move to
		// and must not throw.
		const dialog = await screen.findByRole("dialog");
		fireEvent.keyDown(dialog, { key: "ArrowRight" });
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
