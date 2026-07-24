/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { useRovingTreeFocus } from "./useRovingTreeFocus";

const activate = vi.fn();
const toggle = vi.fn();
const del = vi.fn();
const menu = vi.fn();
const rename = vi.fn();

/**
 * Mirrors the real shape: collections are treeitems with aria-expanded whose
 * children are nested inside them; requests are leaf treeitems. Collapsed
 * children are not rendered, exactly as CollectionItem does.
 */
function Tree({ expanded }: { expanded: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const { onKeyDown, onFocus } = useRovingTreeFocus(ref);
	return (
		<div ref={ref}>
			<div role="tree" onKeyDown={onKeyDown} onFocus={onFocus}>
				<div>
					<div role="treeitem" tabIndex={-1} aria-expanded={expanded} data-name="demo">
						<button tabIndex={-1} data-tree-toggle onClick={toggle}>
							toggle
						</button>
						<button tabIndex={-1} data-tree-activate onClick={activate}>
							demo
						</button>
						<button tabIndex={-1} data-tree-menu onClick={menu}>
							menu
						</button>
						<button tabIndex={-1} data-tree-rename onClick={rename}>
							rename
						</button>
					</div>
					{expanded && (
						<div>
							<div role="treeitem" tabIndex={-1} data-name="req-1">
								<button tabIndex={-1} data-tree-activate onClick={activate}>
									req-1
								</button>
								<button tabIndex={-1} data-tree-delete onClick={del}>
									del
								</button>
								<button tabIndex={-1} data-tree-rename onClick={rename}>
									rename
								</button>
							</div>
							<div role="treeitem" tabIndex={-1} data-name="req-2" />
						</div>
					)}
				</div>
				<div role="treeitem" tabIndex={-1} aria-expanded={false} data-name="test" />
			</div>
		</div>
	);
}

const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
const byName = (n: string) => document.querySelector<HTMLElement>(`[data-name="${n}"]`)!;
const key = (k: string, opts = {}) =>
	fireEvent.keyDown(document.activeElement!, { key: k, ...opts });

describe("useRovingTreeFocus", () => {
	beforeEach(() => {
		activate.mockClear();
		toggle.mockClear();
		del.mockClear();
		menu.mockClear();
		rename.mockClear();
	});

	it("makes the tree a single tab stop", () => {
		render(<Tree expanded />);
		const tabbable = items().filter((i) => i.tabIndex === 0);
		expect(tabbable).toHaveLength(1);
		expect(tabbable[0]).toBe(byName("demo"));
		// Every control inside a row stays out of the tab order.
		for (const btn of document.querySelectorAll("button")) {
			expect(btn.tabIndex).toBe(-1);
		}
	});

	it("moves focus with ArrowDown and ArrowUp", () => {
		render(<Tree expanded />);
		byName("demo").focus();
		key("ArrowDown");
		expect(document.activeElement).toBe(byName("req-1"));
		key("ArrowDown");
		expect(document.activeElement).toBe(byName("req-2"));
		key("ArrowUp");
		expect(document.activeElement).toBe(byName("req-1"));
	});

	it("jumps to first and last with Home and End", () => {
		render(<Tree expanded />);
		byName("req-1").focus();
		key("End");
		expect(document.activeElement).toBe(byName("test"));
		key("Home");
		expect(document.activeElement).toBe(byName("demo"));
	});

	it("keeps exactly one row tabbable as focus moves", () => {
		render(<Tree expanded />);
		byName("demo").focus();
		key("ArrowDown");
		expect(items().filter((i) => i.tabIndex === 0)).toEqual([byName("req-1")]);
	});

	it("expands with ArrowRight when collapsed, and steps in when already expanded", () => {
		const { rerender } = render(<Tree expanded={false} />);
		byName("demo").focus();
		key("ArrowRight");
		expect(toggle).toHaveBeenCalledTimes(1); // expands; children mount next render
		rerender(<Tree expanded />);
		byName("demo").focus();
		key("ArrowRight");
		expect(document.activeElement).toBe(byName("req-1"));
	});

	it("collapses with ArrowLeft, and moves to the parent from a leaf", () => {
		render(<Tree expanded />);
		byName("demo").focus();
		key("ArrowLeft");
		expect(toggle).toHaveBeenCalledTimes(1);

		byName("req-1").focus();
		key("ArrowLeft");
		expect(document.activeElement).toBe(byName("demo"));
	});

	// A root row has no parent. Children are siblings of their parent row rather
	// than nested inside it, so a naive lookup walks into the preceding root
	// collection instead of stopping.
	it("does not move to a preceding sibling when a root row has no parent", () => {
		render(<Tree expanded />);
		byName("test").focus();
		key("ArrowLeft");
		expect(document.activeElement).toBe(byName("test"));
	});

	// Focus moves without opening anything - selection is a separate concept.
	it("does not activate a row merely by moving focus", () => {
		render(<Tree expanded />);
		byName("demo").focus();
		key("ArrowDown");
		key("ArrowUp");
		expect(activate).not.toHaveBeenCalled();
	});

	it("activates with Enter and Space", () => {
		render(<Tree expanded />);
		byName("demo").focus();
		key("Enter");
		key(" ");
		expect(activate).toHaveBeenCalledTimes(2);
	});

	// C makes every row control tabIndex=-1, so these keys are the replacement
	// path - without them delete and row actions become mouse-only.
	it("reaches row actions with Delete and Shift+F10 / ContextMenu", () => {
		render(<Tree expanded />);
		byName("req-1").focus();
		key("Delete");
		expect(del).toHaveBeenCalledTimes(1);

		byName("demo").focus();
		key("F10", { shiftKey: true });
		expect(menu).toHaveBeenCalledTimes(1);
		key("ContextMenu");
		expect(menu).toHaveBeenCalledTimes(2);
	});

	// F2 is the keyboard path to the rename control the ⋯ menu also offers.
	it("renames the focused row with F2", () => {
		render(<Tree expanded />);
		byName("demo").focus();
		key("F2");
		expect(rename).toHaveBeenCalledTimes(1);

		// Works on a leaf request row too, not only collections.
		byName("req-1").focus();
		key("F2");
		expect(rename).toHaveBeenCalledTimes(2);
	});

	it("ignores arrow keys while renaming in a text field", () => {
		render(
			<>
				<Tree expanded />
			</>
		);
		const input = document.createElement("input");
		byName("demo").appendChild(input);
		input.focus();
		fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(document.activeElement).toBe(input);
	});
});
