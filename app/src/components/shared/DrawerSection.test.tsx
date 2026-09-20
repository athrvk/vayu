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
 * The drawer's section header, and the one count idiom (issue #1688).
 *
 * `DrawerPanel` gave the four views one frame; the groups inside a view had
 * none. Services drew muted labels with a plus, Variables a chevron, an icon, a
 * filled `Badge` count and a plus, and the collection rows wrote the same fact
 * as inline `(2)` text one click away from that badge.
 *
 * Rendered, because every claim here is about a class list or an attribute that
 * only exists once the component has run. The adoption check at the bottom is a
 * scan: it is a fact about three call sites' imports, and mounting three drawer
 * trees that each fetch proves nothing extra about it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cloud } from "lucide-react";
import { DrawerSection, DrawerSectionCount } from "./DrawerSection";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("DrawerSection", () => {
	afterEach(cleanup);

	it("names the group with a heading when it does not collapse", () => {
		render(
			<DrawerSection title="Webhook inboxes">
				<div>rows</div>
			</DrawerSection>
		);
		expect(screen.getByRole("heading", { name: "Webhook inboxes" })).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("becomes one button that both toggles and activates when it collapses", () => {
		// For a section header "expand" and "activate" are the same verb, which is
		// why the tree binds `data-tree-toggle` and `data-tree-activate` to one
		// element rather than giving the row two targets.
		const onToggle = vi.fn();
		render(
			<DrawerSection title="Environments" icon={Cloud} expanded={false} onToggle={onToggle}>
				<div>rows</div>
			</DrawerSection>
		);
		const activator = screen.getByRole("button", { name: /Environments/ });
		fireEvent.click(activator);
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("writes a count as the muted inline count, never as a filled badge", () => {
		// The decision this component records: a count beside a group name is the
		// least important thing in the row, and a Badge gives it a fill, a border
		// and a 20px floor.
		render(
			<DrawerSection title="Environments" count={3} expanded onToggle={() => {}}>
				<div>rows</div>
			</DrawerSection>
		);
		const count = screen.getByText("(3)");
		expect(count.className).toContain("text-muted-foreground");
		expect(count.className).not.toContain("bg-");
		expect(count.className).not.toContain("border");
	});

	it("takes a string count for a number the app does not have yet", () => {
		render(
			<DrawerSection title="Collections" count="-" expanded onToggle={() => {}}>
				<div>rows</div>
			</DrawerSection>
		);
		expect(screen.getByText("(-)")).toBeInTheDocument();
	});

	it("renders no count at all when none is given", () => {
		render(
			<DrawerSection title="Mock servers">
				<div>rows</div>
			</DrawerSection>
		);
		expect(screen.queryByText(/^\(/)).toBeNull();
	});

	it("keeps the actions slot outside the activator", () => {
		// Deliberate: the tree has no "create" key, so the "+" is the drawer's own
		// tab stop. Inside the activator it would be a button in a button.
		render(
			<DrawerSection
				title="Environments"
				expanded
				onToggle={() => {}}
				actions={<button>Add environment</button>}
			>
				<div>rows</div>
			</DrawerSection>
		);
		const add = screen.getByRole("button", { name: "Add environment" });
		const activator = screen.getByRole("button", { name: /Environments/ });
		expect(activator.contains(add)).toBe(false);
	});

	it("spreads the caller's ARIA onto the row and the activator", () => {
		// The semantics stay at the call site: a primitive that owned these would
		// have to know about the roving-tabindex tree they belong to.
		render(
			<DrawerSection
				title="Environments"
				expanded
				onToggle={() => {}}
				rowProps={{
					role: "treeitem",
					"aria-level": 1,
					"data-tree-label": "Environments",
					className: "focus-row items-center",
				}}
				activatorProps={{ tabIndex: -1, "data-tree-toggle": true }}
			>
				<div>rows</div>
			</DrawerSection>
		);
		const row = screen.getByRole("treeitem");
		expect(row.getAttribute("aria-level")).toBe("1");
		expect(row.dataset.treeLabel).toBe("Environments");
		expect(row.className).toContain("focus-row");
		const activator = screen.getByRole("button", { name: /Environments/ });
		expect(activator.tabIndex).toBe(-1);
		expect(activator.dataset.treeToggle).toBe("true");
		// The hover fill has to reach the row's edges, so the padding is on the
		// activator rather than on the row around it.
		expect(activator.className).toContain("px-3");
		expect(activator.className).toContain("hover:bg-accent");
	});
});

describe("DrawerSectionCount", () => {
	afterEach(cleanup);

	it("is the same element a row inside a section uses", () => {
		render(<DrawerSectionCount value={2} />);
		const el = screen.getByText("(2)");
		expect(el.className).toContain("shrink-0");
		expect(el.className).toContain("tabular-nums");
	});
});

/**
 * The three drawers this issue names.
 *
 * The collections drawer is the written exception: `CollectionTree` renders no
 * section header at all, because its `DrawerPanel` band already says
 * "Collections" - adding a `DrawerSection` with the same title inside it would
 * be the double-heading defect item 5 of this same issue removes from Settings.
 * What it shares is the *count idiom*, through `DrawerSectionCount`, which is
 * the half of this that was actually inconsistent there.
 */
describe("the drawer views adopt the section frame", () => {
	const FRAME = [
		["Services", "modules/services/ServicesPanel.tsx"],
		["Variables", "modules/variables/sidebar/VariablesCategoryTree.tsx"],
	] as const;

	it.each(FRAME)("%s renders its groups through DrawerSection", (_view, path) => {
		const source = readFileSync(join(src, path), "utf8");
		expect(source.length).toBeGreaterThan(500);
		expect(source).toContain("<DrawerSection");
		// And no longer hand-rolls the header it used to.
		expect(source).not.toContain('<h3 className="text-xs tracking-wider');
	});

	it("the collections tree shares the count idiom rather than the frame", () => {
		const source = readFileSync(join(src, "modules/collections/CollectionItem.tsx"), "utf8");
		expect(source.length).toBeGreaterThan(500);
		expect(source).toContain("<DrawerSectionCount");
	});

	it("leaves no filled Badge count on a variables section header", () => {
		// The idiom that lost. Mutation check (confirmed): put the
		// `<Badge variant="secondary" className="ml-auto …">` back on the
		// Environments header and this fails.
		const source = readFileSync(
			join(src, "modules/variables/sidebar/VariablesCategoryTree.tsx"),
			"utf8"
		);
		expect(source).not.toMatch(/<Badge[^>]*\n?[^>]*className="ml-auto/);
	});
});
