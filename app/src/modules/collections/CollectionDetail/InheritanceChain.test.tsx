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
 * The chain's right-hand cell is `shrink-0` - it holds a short constant and the
 * collection name is what yields. It used to interpolate the credential into
 * that cell (`Bearer ${auth.token}`), so one imported JWT put several hundred
 * unbreakable mono characters into a flex child told not to shrink, and printed
 * a bearer token in a summary panel nobody opened to read a secret.
 *
 * Request-builder's AuthInheritBanner - the same chain, on the request side -
 * already puts a bounded type label in that cell. This is the collection side
 * agreeing with it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AUTH_MODE_LABELS } from "@/constants/auth-modes";
import type { AuthMode, Collection } from "@/types";
import InheritanceChain from "./InheritanceChain";

const chain: Collection[] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => chain,
}));

function collection(id: string, name: string, auth: Collection["auth"]): Collection {
	return {
		id,
		name,
		description: "",
		order: 0,
		variables: {},
		auth,
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const JWT = `eyJhbGciOiJIUzI1NiJ9.${"x".repeat(400)}.signature`;

describe("InheritanceChain", () => {
	it("names the auth type without printing the credential", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { mode: "bearer", token: JWT }),
			collection("leaf", "Payments", { mode: "none" })
		);

		render(<InheritanceChain collectionId="leaf" />);

		expect(screen.getByText("Bearer Token")).toBeInTheDocument();
		expect(screen.queryByText(new RegExp(JWT.slice(0, 40)))).not.toBeInTheDocument();
	});

	it("does the same for basic and api-key credentials", () => {
		chain.length = 0;
		chain.push(
			collection("a", "Basic root", {
				mode: "basic",
				username: "svc-account-with-a-long-name",
				password: "hunter2",
			}),
			collection("b", "Key child", {
				mode: "apikey",
				key: "X-Acme-Very-Long-Header-Name",
				value: "secret-value",
				in: "header",
			})
		);

		render(<InheritanceChain collectionId="b" />);

		expect(screen.getByText("Basic Auth")).toBeInTheDocument();
		expect(screen.getByText("API Key")).toBeInTheDocument();
		expect(screen.queryByText(/svc-account-with-a-long-name/)).not.toBeInTheDocument();
		expect(screen.queryByText(/X-Acme-Very-Long-Header-Name/)).not.toBeInTheDocument();
	});

	it("names every mode a collection can hold from the registry", () => {
		// `inherit` is a request-only mode; a collection is always a source.
		const modes = (Object.keys(AUTH_MODE_LABELS) as AuthMode[]).filter(
			(mode) => mode !== "inherit"
		);
		expect(modes.length).toBeGreaterThan(0);

		for (const mode of modes) {
			chain.length = 0;
			chain.push(collection("only", "Solo", { mode } as Collection["auth"]));

			const { container, unmount } = render(<InheritanceChain collectionId="only" />);

			// The mode cell is the row's one `shrink-0` mono span that is not a badge.
			const cell = container.querySelector("span.font-mono.shrink-0");
			expect(cell?.textContent, mode).toBe(AUTH_MODE_LABELS[mode]);
			unmount();
		}
	});

	it("marks no source, and says why, when an ancestor blocks inheriting", () => {
		// A folder explicitly set to No Auth terminates the walk. The panel has to
		// agree with what execution sends, or it claims a SOURCE the request never
		// uses - the bug an imported Postman No Auth folder produced (issue #195).
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { mode: "bearer", token: "t" }),
			collection("mid", "Public endpoints", { mode: "noauth" }),
			collection("leaf", "Health", { mode: "none" })
		);

		render(<InheritanceChain collectionId="leaf" />);

		expect(screen.queryByText("SOURCE")).not.toBeInTheDocument();
		expect(
			screen.getByText(/is set to No Auth, so requests below it inherit nothing/)
		).toBeInTheDocument();
		// The blocking row names itself distinctly from a plain unset one.
		expect(screen.getByText("No Auth (blocks inheriting)")).toBeInTheDocument();
	});

	it("still marks the nearest non-none ancestor as the source", () => {
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { mode: "bearer", token: "t" }),
			collection("mid", "Payments", { mode: "none" }),
			collection("leaf", "Refunds", { mode: "none" })
		);

		render(<InheritanceChain collectionId="leaf" />);

		expect(screen.getByText("SOURCE")).toBeInTheDocument();
		expect(screen.getByText("THIS")).toBeInTheDocument();
	});

	it("shows the tab's unsaved pick instead of the stored mode while it is dirty (#1483)", () => {
		// The leaf is stored as bearer, so without `draftAuth` wired through
		// `withDraftAuth` this would read "Bearer Token" and mark "root" as
		// SOURCE - the stale-panel bug the draft prop exists to close.
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { mode: "bearer", token: "t" }),
			collection("leaf", "Payments", { mode: "bearer", token: "old" })
		);

		render(<InheritanceChain collectionId="leaf" draftAuth={{ mode: "noauth" }} />);

		expect(screen.getByText("No Auth (blocks inheriting)")).toBeInTheDocument();
		expect(screen.queryByText("SOURCE")).not.toBeInTheDocument();
		// Names Payments (the leaf) as the blocker, which only happens once its
		// row reads the draft's noauth rather than its stored bearer token.
		expect(
			screen.getByText(/is set to No Auth, so requests below it inherit nothing/)
		).toBeInTheDocument();
	});

	it("declares the card surface its row dividers read (#1891)", () => {
		// `--border` is the same colour as `--card` in dark, so a divider on it
		// inside the card is absent; `border-rule` is only right under a declared
		// surface, hence the card's `surface-card` is asserted beside the rows'.
		chain.length = 0;
		chain.push(
			collection("root", "Acme", { mode: "bearer", token: "t" }),
			collection("mid", "Payments", { mode: "none" }),
			collection("leaf", "Refunds", { mode: "none" })
		);

		const { container } = render(<InheritanceChain collectionId="leaf" />);

		const card = container.firstElementChild!;
		expect(card.classList.contains("bg-card")).toBe(true);
		expect(card.classList.contains("surface-card")).toBe(true);

		const rows = ["Acme", "Payments", "Refunds"].map((name) =>
			screen.getByText(name).closest(".py-1\\.5")!
		);
		const [first, second, last] = rows.map((row) => row.classList);
		for (const divided of [first, second]) {
			expect(divided.contains("border-rule")).toBe(true);
			expect(divided.contains("border-border")).toBe(false);
		}
		// The last row has nothing beneath it to divide from.
		expect(last.contains("border-b")).toBe(false);
	});
});
