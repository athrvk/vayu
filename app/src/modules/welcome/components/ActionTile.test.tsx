/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Plus } from "lucide-react";
import { ActionTile } from "./ActionTile";

describe("ActionTile", () => {
	// A handler like `newRequest(preset?)` takes optional data as its first
	// parameter; the click event must never arrive there.
	it("calls onClick with no arguments, not the click event", () => {
		const onClick = vi.fn();
		render(<ActionTile icon={Plus} label="New request" onClick={onClick} />);
		fireEvent.click(screen.getByRole("button", { name: /New request/i }));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onClick.mock.calls[0]).toHaveLength(0);
	});
});
