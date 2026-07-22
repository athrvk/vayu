/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Collection, ScriptPart } from "@/types";
import InheritedScriptsNotice from "./InheritedScriptsNotice";

const chain: Collection[] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => chain,
}));

function collection(id: string, name: string, script: Partial<Collection>): Collection {
	return {
		id,
		name,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...script,
	};
}

describe("InheritedScriptsNotice", () => {
	it("renders one entry per collection with a script of that kind, named", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { preRequestScript: "pm.environment.set('a', 1);" }),
			collection("mid", "Payments", { preRequestScript: "" }),
			collection("leaf", "Refunds", { preRequestScript: "pm.environment.set('b', 2);" })
		);

		render(<InheritedScriptsNotice variant="pre" collectionId="leaf" />);

		expect(screen.getByText("Acme")).toBeInTheDocument();
		expect(screen.getByText("Refunds")).toBeInTheDocument();
	});

	it("does not show collections with no script of that kind", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { preRequestScript: "pm.environment.set('a', 1);" }),
			collection("mid", "Payments", { preRequestScript: "" })
		);

		render(<InheritedScriptsNotice variant="pre" collectionId="mid" />);

		expect(screen.getByText("Acme")).toBeInTheDocument();
		expect(screen.queryByText("Payments")).not.toBeInTheDocument();
	});

	it("distinguishes pre-request from test scripts via variant", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", {
				preRequestScript: "",
				postRequestScript: "pm.test('ok', () => {});",
			})
		);

		render(<InheritedScriptsNotice variant="pre" collectionId="root" />);
		expect(screen.queryByText("Acme")).not.toBeInTheDocument();

		render(<InheritedScriptsNotice variant="post" collectionId="root" />);
		expect(screen.getByText("Acme")).toBeInTheDocument();
	});

	it("renders nothing when no collection in the chain has a script of that kind", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { preRequestScript: "" }),
			collection("leaf", "Refunds", { preRequestScript: "" })
		);

		const { container } = render(<InheritedScriptsNotice variant="pre" collectionId="leaf" />);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the request isn't in a collection", () => {
		chain.length = 0;

		const { container } = render(<InheritedScriptsNotice variant="pre" collectionId={null} />);

		expect(container).toBeEmptyDOMElement();
	});

	it("prefers the explicit entries prop over the live chain", () => {
		// The hook's chain says "nothing to show" - if entries won, the text
		// below would not appear at all.
		chain.length = 0;
		chain.push(collection("root", "Acme", { preRequestScript: "" }));

		const entries: ScriptPart[] = [
			{
				origin: "collection",
				id: "stored-1",
				name: "Stored Run Collection",
				script: "pm.test();",
			},
		];

		render(<InheritedScriptsNotice variant="pre" collectionId="root" entries={entries} />);

		expect(screen.getByText("Stored Run Collection")).toBeInTheDocument();
		expect(screen.queryByText("Acme")).not.toBeInTheDocument();
	});

	it("only shows collection-origin entries, even when passed explicitly", () => {
		const entries: ScriptPart[] = [
			{ origin: "collection", id: "c1", name: "Parent Collection", script: "pm.test();" },
			{ origin: "request", id: "r1", script: "pm.test();" },
		];

		render(<InheritedScriptsNotice variant="post" entries={entries} />);

		expect(screen.getByText("Parent Collection")).toBeInTheDocument();
	});
});
