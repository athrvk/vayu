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
 * `InheritedElementsNotice` generalizes `InheritedScriptsNotice` from scripts
 * alone to every element kind (issue #1512), and adds the one thing a
 * script-only notice never needed: a Disable / Re-enable toggle per entry,
 * which writes an `inherit.disable` element into the request's own list
 * rather than editing the ancestor (which the request cannot do).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Collection, ElementDef, ElementKindSchema, ResolvedElement } from "@/types";
import InheritedElementsNotice from "./InheritedElementsNotice";

const chain: Collection[] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => chain,
}));

function collection(id: string, name: string, elements: ElementDef[] = []): Collection {
	return {
		id,
		name,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function element(overrides: Partial<ElementDef> & { id: string; kind: string }): ElementDef {
	return { enabled: true, config: {}, ...overrides };
}

/** A minimal catalogue entry - only `kind` and `label` matter to this notice. */
function kindSchema(kind: string, label: string): ElementKindSchema {
	return {
		kind,
		version: 1,
		label,
		description: "",
		category: "test",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema: { type: "object" },
		phases: [],
	};
}

const KINDS: ElementKindSchema[] = [
	kindSchema("script.pre", "Pre-request Script"),
	kindSchema("extract.json", "Extract JSON"),
];

function renderNotice(props: Partial<Parameters<typeof InheritedElementsNotice>[0]> = {}) {
	const onChangeOwnElements = props.onChangeOwnElements ?? vi.fn();
	return render(
		<InheritedElementsNotice
			collectionId="leaf"
			ownElements={[]}
			onChangeOwnElements={onChangeOwnElements}
			kinds={KINDS}
			{...props}
		/>
	);
}

describe("InheritedElementsNotice - no elements in the chain", () => {
	it("renders nothing when the chain has no elements", () => {
		chain.length = 0;
		chain.push(collection("root", "Acme", []), collection("leaf", "Refunds", []));

		const { container } = renderNotice();

		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the request isn't in a collection", () => {
		chain.length = 0;

		const { container } = renderNotice({ collectionId: null });

		expect(container).toBeEmptyDOMElement();
	});
});

describe("InheritedElementsNotice - listing the chain's elements", () => {
	it("lists an ancestor collection's enabled element, with its kind label", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", [
				element({ id: "r1", kind: "script.pre", config: { script: "pm.log('x')" } }),
			]),
			collection("leaf", "Refunds", [])
		);

		renderNotice({ collectionId: "leaf" });

		expect(screen.getByText("Acme")).toBeInTheDocument();
		expect(screen.getByText("Pre-request Script")).toBeInTheDocument();
	});

	it("skips a disabled element", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", [
				element({
					id: "r1",
					kind: "script.pre",
					enabled: false,
					config: { script: "pm.log('x')" },
				}),
			])
		);

		const { container } = renderNotice({ collectionId: "root" });

		expect(container).toBeEmptyDOMElement();
	});

	it("skips a blank script.pre", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", [
				element({ id: "r1", kind: "script.pre", config: { script: "" } }),
			])
		);

		const { container } = renderNotice({ collectionId: "root" });

		expect(container).toBeEmptyDOMElement();
	});

	it("skips a whitespace-only script.post but lists a real one alongside it", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", [
				element({ id: "r1", kind: "script.post", config: { script: "  \n\t" } }),
				element({ id: "r2", kind: "extract.json", config: {} }),
			])
		);

		renderNotice({ collectionId: "root" });

		expect(screen.getByText("Extract JSON")).toBeInTheDocument();
		expect(screen.getByText("A collection will run before your own.")).toBeInTheDocument();
	});

	it("falls back to the raw kind string when the catalogue has no label for it", () => {
		chain.length = 0;
		chain.push(collection("root", "Acme", [element({ id: "r1", kind: "unknown.kind" })]));

		renderNotice({ collectionId: "root", kinds: [] });

		expect(screen.getByText("unknown.kind")).toBeInTheDocument();
	});

	it("prefers the explicit entries prop over the live chain", () => {
		// The hook's chain says "nothing to show" - if entries won, the text
		// below would not appear at all.
		chain.length = 0;
		chain.push(collection("root", "Acme", []));

		const entries: ResolvedElement[] = [
			{
				id: "stored-1",
				kind: "extract.json",
				enabled: true,
				config: {},
				origin: { kind: "collection", id: "c1", name: "Stored Run Collection" },
			},
		];

		renderNotice({ collectionId: "root", entries });

		expect(screen.getByText("Stored Run Collection")).toBeInTheDocument();
		expect(screen.queryByText("Acme")).not.toBeInTheDocument();
	});

	it("only shows collection-origin entries, even when passed explicitly", () => {
		const entries: ResolvedElement[] = [
			{
				id: "c1",
				kind: "extract.json",
				enabled: true,
				config: {},
				origin: { kind: "collection", id: "c1", name: "Parent Collection" },
			},
			{
				id: "r1",
				kind: "extract.json",
				enabled: true,
				config: {},
				origin: { kind: "request", id: "r1" },
			},
		];

		renderNotice({ entries });

		expect(screen.getByText("Parent Collection")).toBeInTheDocument();
	});

	// Presence alone would pass even if the rows were reversed - `chain` is
	// already root first, and reversing it would list the leaf's element
	// before the root's, actively misleading about what runs first.
	it("renders the chain root to leaf, matching execution order", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Outer", [element({ id: "r1", kind: "extract.json" })]),
			collection("leaf", "Inner", [element({ id: "l1", kind: "extract.json" })])
		);

		renderNotice({ collectionId: "leaf" });

		const names = screen.getAllByText(/^(Outer|Inner)$/).map((el) => el.textContent);
		expect(names).toEqual(["Outer", "Inner"]);
	});
});

describe("InheritedElementsNotice - the Disable / Re-enable toggle", () => {
	it("adds an inherit.disable entry naming the element when Disable is pressed", () => {
		chain.length = 0;
		chain.push(collection("root", "Acme", [element({ id: "r1", kind: "extract.json" })]));

		const onChangeOwnElements = vi.fn();
		renderNotice({ collectionId: "root", ownElements: [], onChangeOwnElements });

		screen.getByRole("button", { name: /disable/i }).click();

		expect(onChangeOwnElements).toHaveBeenCalledWith([
			{
				id: "el_disable_r1",
				kind: "inherit.disable",
				enabled: true,
				config: { elementId: "r1" },
			},
		]);
	});

	it("shows Re-enable, and removes the disable entry, once the element is disabled", () => {
		chain.length = 0;
		chain.push(collection("root", "Acme", [element({ id: "r1", kind: "extract.json" })]));

		const ownElements: ElementDef[] = [
			element({ id: "el_disable_r1", kind: "inherit.disable", config: { elementId: "r1" } }),
		];
		const onChangeOwnElements = vi.fn();
		renderNotice({ collectionId: "root", ownElements, onChangeOwnElements });

		expect(screen.getByRole("button", { name: /re-enable/i })).toBeInTheDocument();
		screen.getByRole("button", { name: /re-enable/i }).click();

		expect(onChangeOwnElements).toHaveBeenCalledWith([]);
	});

	it("still lists a disabled entry, so Re-enable stays reachable", () => {
		// `disabledIds` marks the row, it does not hide it - only an actually
		// disabled *ancestor* element (its own `enabled: false`) is left off.
		chain.length = 0;
		chain.push(collection("root", "Acme", [element({ id: "r1", kind: "extract.json" })]));

		const ownElements: ElementDef[] = [
			element({ id: "el_disable_r1", kind: "inherit.disable", config: { elementId: "r1" } }),
		];
		renderNotice({ collectionId: "root", ownElements });

		expect(screen.getByText("Acme")).toBeInTheDocument();
	});
});
