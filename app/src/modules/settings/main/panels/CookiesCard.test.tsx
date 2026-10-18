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
 * The cookie jar card (issue #301).
 *
 * The assertion that matters is which scope a Clear sends. The engine draws
 * three cases apart - every jar, the jar for one environment, and the jar used
 * when no environment is selected - and the last two are the ones a careless
 * edit collapses into "clear everything", which silently signs the user out of
 * every environment they were working in. So each Clear is asserted on the
 * argument, not just on the call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { CookiesCard } from "./CookiesCard";

const COOKIES_EMPTY_TITLE = "Cookies appear here after a response sets one.";

const mutateAsync = vi.fn(() => Promise.resolve({ cleared: 1 }));

const scopes = [
	{
		environmentId: null,
		cookies: [
			{
				name: "anon",
				value: "a1",
				domain: "example.com",
				path: "/",
				secure: false,
				httpOnly: false,
				expires: 0,
			},
		],
	},
	{
		environmentId: "env_staging",
		cookies: [
			{
				name: "session",
				value: "s1",
				domain: ".staging.example.com",
				path: "/app",
				secure: true,
				httpOnly: true,
				expires: 4102444800,
			},
		],
	},
];

let queryResult: { data?: { scopes: typeof scopes }; isError: boolean; isLoading?: boolean } = {
	data: { scopes },
	isError: false,
};

vi.mock("@/queries", () => ({
	useCookiesQuery: () => queryResult,
	useClearCookiesMutation: () => ({ mutateAsync, isPending: false }),
	useEnvironmentsQuery: () => ({ data: [{ id: "env_staging", name: "Staging" }] }),
}));

beforeEach(() => {
	mutateAsync.mockClear();
	queryResult = { data: { scopes }, isError: false };
});

/** Click a Clear button, then confirm in the dialog it opens. */
async function clearAndConfirm(button: HTMLElement) {
	fireEvent.click(button);
	const dialog = await screen.findByRole("dialog");
	fireEvent.click(within(dialog).getByRole("button", { name: /^clear$/i }));
	await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
}

describe("CookiesCard", () => {
	it("names each jar and shows what makes a cookie identifiable", () => {
		render(<CookiesCard />);

		// The environment id is resolved to its name; the null scope reads as
		// what it is rather than as a blank.
		expect(screen.getByText("Staging")).toBeInTheDocument();
		expect(screen.getByText("No environment")).toBeInTheDocument();
		expect(screen.getByText("session")).toBeInTheDocument();
		// The value, not just the name: without it the card cannot answer which
		// session a request is using, which is the question it exists for.
		expect(screen.getByText("s1")).toBeInTheDocument();
		expect(screen.getByText(".staging.example.com/app")).toBeInTheDocument();
		expect(screen.getByText("Secure")).toBeInTheDocument();
		expect(screen.getByText("HttpOnly")).toBeInTheDocument();
		// expires: 0 is the engine's session sentinel, not the epoch - rendering
		// it as a date would claim the cookie expired in 1970.
		expect(screen.getByText("Session")).toBeInTheDocument();
	});

	it("opens the time card on an expiry, and none on a session cookie", async () => {
		const { container } = render(<CookiesCard />);

		// `expires` is epoch seconds, so 4102444800 is 2100-01-01T00:00:00Z.
		const expiry = container.querySelector("time") as HTMLElement;
		expect(container.querySelectorAll("time")).toHaveLength(1);
		expect(expiry.getAttribute("datetime")).toBe("2100-01-01T00:00:00.000Z");

		fireEvent.focus(expiry);
		const card = await screen.findByTestId("time-hover-card");
		expect(card.textContent).toContain("2100");
		expect(card.textContent).toContain("UTC");
	});

	it("clears one environment's jar by id, not everything", async () => {
		render(<CookiesCard />);

		const staging = screen.getByText("Staging").closest("div")!;
		await clearAndConfirm(within(staging).getByRole("button", { name: /clear/i }));

		expect(mutateAsync).toHaveBeenCalledWith({ environmentId: "env_staging" });
	});

	it("clears the no-environment jar with null, which is not the same as clearing all", async () => {
		render(<CookiesCard />);

		const anonymous = screen.getByText("No environment").closest("div")!;
		await clearAndConfirm(within(anonymous).getByRole("button", { name: /clear/i }));

		// `undefined` here would empty every environment's jar as well.
		expect(mutateAsync).toHaveBeenCalledWith({ environmentId: null });
	});

	it("clears everything with no scope at all", async () => {
		render(<CookiesCard />);

		await clearAndConfirm(screen.getByRole("button", { name: /clear all cookies/i }));

		expect(mutateAsync).toHaveBeenCalledWith(undefined);
	});

	it("says the jar is unknown when the engine did not answer, rather than empty, with a next step", () => {
		queryResult = { isError: true };
		render(<CookiesCard />);

		// The empty-jar sentence would be a claim the app cannot make here, and the
		// one that stops someone looking for the session that is still live.
		expect(screen.queryByText(COOKIES_EMPTY_TITLE)).not.toBeInTheDocument();
		expect(screen.getByText(/didn't answer/i)).toHaveTextContent("Restart Vayu");
	});

	it("renders no verdict until the query settles", () => {
		queryResult = { data: undefined, isLoading: true, isError: false };
		render(<CookiesCard />);

		// The first paint has no data yet, and the empty-jar sentence would be a
		// claim the card cannot make before the engine has answered.
		expect(screen.queryByText(COOKIES_EMPTY_TITLE)).not.toBeInTheDocument();
	});

	it("says the jar is empty, through the empty-state primitive, when it holds no cookie", () => {
		queryResult = { data: { scopes: [] }, isError: false };
		const { container } = render(<CookiesCard />);

		expect(screen.getByText(COOKIES_EMPTY_TITLE)).toBeInTheDocument();
		expect(container.querySelector('[data-slot="empty-state"]')).toHaveTextContent(
			COOKIES_EMPTY_TITLE
		);
		// Nothing to clear, so no Clear all.
		expect(screen.queryByRole("button", { name: /clear all cookies/i })).toBeNull();
	});

	it("names each Clear button for the jar it empties", () => {
		render(<CookiesCard />);

		expect(
			screen.getByRole("button", { name: /clear cookies for staging/i })
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /clear cookies for no environment/i })
		).toBeInTheDocument();
		// A bare "Clear" repeated per scope is indistinguishable to a screen reader.
		expect(screen.queryAllByRole("button", { name: /^clear$/i })).toHaveLength(0);
	});

	it("declares the surface its cookie dividers read", () => {
		const { container } = render(<CookiesCard />);
		const rules = Array.from(container.querySelectorAll(".border-rule"));

		// One divider per scope.
		// A render that reached no divider would pass the loop below having
		// checked nothing.
		expect(rules.length).toBeGreaterThanOrEqual(2);
		for (const rule of rules) {
			expect(
				rule.closest(".surface-card, .surface-sunken"),
				`border-rule under no surface: ${rule.getAttribute("class")}`
			).not.toBeNull();
		}
	});
});
