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
 * The Test button's spinner used to mount beside its label for the length of a
 * test, widening the button by an icon and a gap and shrinking the URL field
 * beside it, then handing the width back when the result landed. jsdom has no
 * layout, so the guard is the mechanism: one glyph box is there before the
 * click and is the same node while the test runs, with the spinner inside it.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ConnectionTestResult } from "@/types";
import { ConnectionTestCard } from "./ConnectionTestCard";

const never = () => new Promise<ConnectionTestResult>(() => {});
const testConnection = vi.fn((_url: string) => never());
vi.mock("@/services/api", () => ({
	apiService: { testConnection: (url: string) => testConnection(url) },
}));

beforeEach(() => {
	testConnection.mockReset();
	testConnection.mockImplementation(never);
});

describe("ConnectionTestCard's Test button", () => {
	it("swaps its glyph for a spinner in place rather than mounting one", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<ConnectionTestCard />
			</QueryClientProvider>
		);
		const button = screen.getByRole("button", { name: "Test" });
		const glyphBox = button.firstElementChild;
		expect(glyphBox, "the idle button carries no glyph box").not.toBeNull();
		// Scoped to the live cell: `IconSwap` keeps an invisible spinner twin
		// in the box at all times, which is what reserves its width.
		expect(button.querySelector(".enter-fade .animate-spin")).toBeNull();

		await act(async () => {
			fireEvent.click(button);
		});

		expect(testConnection).toHaveBeenCalledTimes(1);
		expect(button.firstElementChild).toBe(glyphBox);
		expect(button.querySelector(".enter-fade .animate-spin")).not.toBeNull();
	});
});

/**
 * What the proxy line says for each `proxy` node the engine can answer with.
 * The engine strips credentials before the node leaves it, so the card prints
 * `url` as given; the cases here are the wording around it, which is where the
 * card used to claim the environment's proxy was unknown to the engine.
 */
describe("ConnectionTestCard's proxy line", () => {
	async function lineFor(proxy: ConnectionTestResult["proxy"]): Promise<string> {
		testConnection.mockResolvedValueOnce({
			url: "https://api.github.com/",
			outcome: "ok",
			proxy,
			clientCertificate: "",
			status: 200,
		});
		render(
			<QueryClientProvider client={new QueryClient()}>
				<ConnectionTestCard />
			</QueryClientProvider>
		);
		fireEvent.click(screen.getByRole("button", { name: "Test" }));
		const line = await screen.findByText(/Through|Sent direct|Nothing resolved/);
		return line.textContent ?? "";
	}

	it("names a proxy configured in Vayu with its mode", async () => {
		expect(await lineFor({ mode: "manual", url: "http://proxy.corp:8080" })).toBe(
			"Through http://proxy.corp:8080 (manual)"
		);
	});

	it("names the environment's proxy when the probe went through it", async () => {
		expect(
			await lineFor({ mode: "environment", source: "environment", url: "http://env:3128" })
		).toBe("Through the environment's proxy: http://env:3128");
	});

	it("says system resolved nothing and the environment's proxy carried the probe", async () => {
		expect(
			await lineFor({ mode: "system", source: "environment", url: "http://env:3128" })
		).toBe(
			"Nothing resolved from this system, so the environment's proxy was used: http://env:3128"
		);
	});

	it("does not claim an address it could not read", async () => {
		expect(await lineFor({ mode: "environment", source: "environment" })).toBe(
			"Through the environment's proxy (its address could not be read)"
		);
	});

	it("says a probe the environment did not proxy went direct", async () => {
		expect(await lineFor({ mode: "environment" })).toBe(
			"Sent direct - the environment named no proxy for this URL"
		);
	});

	it("says system with nothing resolved and nothing in the environment went direct", async () => {
		expect(await lineFor({ mode: "system" })).toBe(
			"Sent direct - nothing resolved from this system, and the environment named no proxy for this URL"
		);
	});

	it("says a switched-off proxy went direct", async () => {
		expect(await lineFor({ mode: "off" })).toBe("Sent direct - the proxy is switched off");
	});
});

/**
 * The engine's `clientCertificate` is the entry the probe offered, `""` for an
 * `http://` URL or a host nothing matched (#3260). The card says "offered", not
 * "presented": the handshake may still have refused it, and `outcome` reports
 * that.
 */
describe("ConnectionTestCard's client-certificate line", () => {
	async function textAfterTest(clientCertificate: string) {
		testConnection.mockResolvedValueOnce({
			url: "https://api.example.com/",
			outcome: "ok",
			proxy: { mode: "off" },
			clientCertificate,
			status: 200,
		});
		render(
			<QueryClientProvider client={new QueryClient()}>
				<ConnectionTestCard />
			</QueryClientProvider>
		);
		fireEvent.click(screen.getByRole("button", { name: "Test" }));
		await screen.findByText("Reached");
	}

	it("says which registered certificate was offered", async () => {
		await textAfterTest("*.example.com");
		expect(
			screen.getByText("Client certificate registered for *.example.com was offered")
		).toBeInTheDocument();
	});

	it("says nothing when none was offered", async () => {
		await textAfterTest("");
		expect(screen.queryByText(/Client certificate registered for/)).toBeNull();
	});
});
