/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { useRovingTreeFocus } from "./useRovingTreeFocus";
import { TIMING } from "@/config/timing";

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
					<div
						role="treeitem"
						tabIndex={-1}
						aria-expanded={expanded}
						data-name="demo"
						data-tree-label="Demo"
					>
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
							<div
								role="treeitem"
								tabIndex={-1}
								data-name="req-1"
								data-tree-label="Ping users"
							>
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
							<div
								role="treeitem"
								tabIndex={-1}
								data-name="req-2"
								data-tree-label="Post orders"
							/>
						</div>
					)}
				</div>
				<div
					role="treeitem"
					tabIndex={-1}
					aria-expanded={false}
					data-name="test"
					data-tree-label="Payments"
				>
					<button tabIndex={-1} data-tree-toggle onClick={toggle}>
						toggle
					</button>
				</div>
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

	/*
	 * The macOS half of those two keys (#931). The key labelled "delete" on a Mac
	 * keyboard reports "Backspace", and Mac keyboards have neither a Menu key nor
	 * a usable F10 - so each of the three cases below is a path that fires on
	 * Windows and did nothing at all on a Mac.
	 *
	 * These assert the *key*, never the host platform: the hook has no platform
	 * branch, so both keys must work in one run wherever it happens to run.
	 */
	it("deletes on Backspace as well as Delete, since Mac delete is Backspace", () => {
		render(<Tree expanded />);
		byName("req-1").focus();

		key("Backspace");
		expect(del).toHaveBeenCalledTimes(1);

		key("Delete");
		expect(del).toHaveBeenCalledTimes(2);
	});

	it("opens the row menu on Shift+Enter, the Mac-reachable path", () => {
		render(<Tree expanded />);
		byName("demo").focus();

		key("Enter", { shiftKey: true });
		expect(menu).toHaveBeenCalledTimes(1);
		// Shift+Enter is the menu, not a second way to open the row.
		expect(activate).not.toHaveBeenCalled();
	});

	it("still activates on plain Enter and on Space", () => {
		render(<Tree expanded />);
		byName("demo").focus();

		key("Enter");
		key(" ");
		expect(activate).toHaveBeenCalledTimes(2);
		expect(menu).not.toHaveBeenCalled();
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

	// The click path, which nothing asserted: `onFocus` re-anchors the roving
	// tabindex so Tab returns to the row the pointer left off at, rather than to
	// whichever row happened to be seeded first.
	it("re-anchors the tabbable row when a row is clicked into", () => {
		render(<Tree expanded />);
		expect(items().filter((i) => i.tabIndex === 0)).toEqual([byName("demo")]);

		// A click focuses the control inside the row, not the row itself - so the
		// handler has to walk up to the treeitem.
		fireEvent.focus(byName("req-2"));

		expect(items().filter((i) => i.tabIndex === 0)).toEqual([byName("req-2")]);
	});

	it("re-seeds a tabbable row when the one holding it is collapsed away", () => {
		const { rerender } = render(<Tree expanded />);
		fireEvent.focus(byName("req-1"));
		expect(items().filter((i) => i.tabIndex === 0)).toEqual([byName("req-1")]);

		// `req-1` is unmounted by the collapse. Without the re-seed the tree owns
		// no tabbable row at all and drops out of the tab order entirely.
		rerender(<Tree expanded={false} />);

		expect(items().filter((i) => i.tabIndex === 0)).toEqual([byName("demo")]);
	});

	/*
	 * Typeahead. The rows are deliberately named so that three of them share a
	 * first letter and only one matches a two-letter prefix - a hook that
	 * ignored the buffer and matched on the latest keystroke alone would land
	 * somewhere else on every one of these.
	 */
	describe("typeahead", () => {
		// Date.now drives the buffer's expiry, and vitest's fake timers mock it.
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("steps through the rows starting with the typed letter, wrapping", () => {
			render(<Tree expanded />);
			byName("demo").focus();

			key("p");
			expect(document.activeElement).toBe(byName("req-1")); // Ping users
			key("p");
			expect(document.activeElement).toBe(byName("req-2")); // Post orders
			key("p");
			expect(document.activeElement).toBe(byName("test")); // Payments
			// Past the last match: back to the first, rather than stopping dead.
			key("p");
			expect(document.activeElement).toBe(byName("req-1"));
		});

		it("accumulates the letters into a prefix", () => {
			render(<Tree expanded />);
			byName("demo").focus();

			key("p");
			expect(document.activeElement).toBe(byName("req-1"));
			// "pa" matches Payments only - a single-letter search would have moved
			// to Post orders instead.
			key("a");
			expect(document.activeElement).toBe(byName("test"));
		});

		it("starts a fresh search once the buffer has gone stale", () => {
			render(<Tree expanded />);
			byName("demo").focus();

			key("p");
			key("a");
			expect(document.activeElement).toBe(byName("test"));

			vi.advanceTimersByTime(TIMING.TREE_TYPEAHEAD_MS + 1);

			// A buffer that never expired would search for "pad", match nothing and
			// leave focus on Payments - which is what a user who paused, then typed
			// the first letter of a different row, reads as the key being ignored.
			key("d");
			expect(document.activeElement).toBe(byName("demo"));
		});

		it("matches the row's label, not the text around it", () => {
			render(<Tree expanded />);
			byName("demo").focus();

			// No row is *named* with a leading "t"; `test`'s markup contains the
			// word "toggle", the shape a method badge or a child count gives a real
			// row. Matching on textContent would jump there.
			key("t");
			expect(document.activeElement).toBe(byName("demo"));
		});

		it("leaves shortcut combinations to the app", () => {
			render(<Tree expanded />);
			byName("demo").focus();

			key("p", { ctrlKey: true });
			key("p", { metaKey: true });
			expect(document.activeElement).toBe(byName("demo"));
		});
	});

	// `*` expands every folder that shares the focused row's parent - the ARIA
	// tree pattern's one-key "show me this whole level".
	it("expands sibling folders with *", () => {
		render(<Tree expanded />);
		byName("demo").focus();

		key("*");

		// `test` is the collapsed root sibling. `demo` is already expanded and is
		// skipped, so this is one call and not two - `*` never collapses anything.
		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it("does not expand folders at another level with *", () => {
		render(<Tree expanded />);
		// A leaf inside `demo`: its only sibling is the other request, and the
		// collapsed `test` belongs to the level above.
		byName("req-1").focus();

		key("*");

		expect(toggle).not.toHaveBeenCalled();
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
