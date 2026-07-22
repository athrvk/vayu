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
import type { Collection } from "@/types";
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
		preRequestScript: "",
		postRequestScript: "",
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
});
