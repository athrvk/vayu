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
 * `resolvedConfig` is not only a display. `TokenStatusRow` derives the token
 * cache key from it (`services/oauth/cache-key.ts`, which reads the
 * access-token URL, the client id, the credentials id and the password grant's
 * username) and queries the engine on that string, and the same object is what
 * a Get Token posts.
 *
 * So a `{{$guid}}`-class value in one of those fields did more than flicker:
 * it resolved fresh on every call (`lib/dynamic-variables.ts`'s own contract),
 * and the builder's Auth tab is not force-mounted
 * (`RequestTabs/index.tsx` force-mounts Body and Elements only), so Auth →
 * Headers → Auth rebuilt this form and pointed the status row at a cache key
 * nothing had ever fetched - a token that was on screen a moment ago reading
 * as "No token cached", with nothing edited. The `useMemo` around the
 * resolution could not answer that, because it dies with the component;
 * `stableConfigField` is the module-scope cache from
 * `lib/dynamic-variable-cache.ts`, keyed by the `resolveKey` its host passes
 * plus the field name.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { OAuth2Config } from "@/types";
import OAuth2Form from "./OAuth2Form";

/** Stands in for the status row, showing what the form resolved the key to. */
vi.mock("./TokenStatusRow", () => ({
	default: ({ resolvedConfig }: { resolvedConfig: OAuth2Config }) => (
		<>
			<div data-testid="resolved-client-id">{resolvedConfig.clientId}</div>
			<div data-testid="resolved-params">
				{JSON.stringify({
					authorizationParams: resolvedConfig.authorizationParams,
					tokenParams: resolvedConfig.tokenParams,
					refreshParams: resolvedConfig.refreshParams,
				})}
			</div>
		</>
	),
}));

const CONFIG: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://idp.test/token",
	clientId: "client-{{$randomInt}}",
};

/**
 * A resolver that behaves the way the dynamic-variable table does: every call
 * hands back a *different* value for the same input. Anything that resolves
 * twice therefore shows two different strings, which is the defect itself.
 */
function makeRerollingResolver() {
	let n = 0;
	return vi.fn((input: string) => input.replace("{{$randomInt}}", String(++n)));
}

function form(
	resolveString: (s: string) => string,
	resolveKey: string | undefined,
	value = CONFIG
) {
	return (
		// The secret fields' reveal toggles are tooltip triggers - Radix requires
		// the provider the app mounts at its root.
		<TooltipProvider>
			<OAuth2Form
				value={value}
				onChange={() => {}}
				resolveString={resolveString}
				resolveKey={resolveKey}
			/>
		</TooltipProvider>
	);
}

const clientId = () => screen.getByTestId("resolved-client-id").textContent;

describe("the resolved OAuth config", () => {
	it("survives the unmount a tab switch causes", () => {
		const resolveString = makeRerollingResolver();

		const first = render(form(resolveString, "req_remount"));
		const before = clientId();
		// Sanity: the row really carries a generated value, not the raw token.
		expect(before).toMatch(/^client-\d+$/);
		first.unmount();

		const second = render(form(resolveString, "req_remount"));
		expect(clientId()).toBe(before);
		second.unmount();
	});

	it("re-resolves once the field's text actually changes", () => {
		const resolveString = makeRerollingResolver();

		const first = render(form(resolveString, "req_edit"));
		const before = clientId();
		first.unmount();

		const edited = { ...CONFIG, clientId: "other-{{$randomInt}}" };
		const second = render(form(resolveString, "req_edit", edited));
		expect(clientId()).not.toBe(before);
		second.unmount();
	});

	it("gives two requests their own value rather than one keyed by the text", () => {
		// Byte-identical templates on two different requests. Keying the cache on
		// the text alone would collapse them, which is the collision the resolver
		// conformance fixture forbids for two distinct occurrences.
		const resolveString = makeRerollingResolver();

		const a = render(form(resolveString, "req_a"));
		const aId = clientId();
		a.unmount();

		const b = render(form(resolveString, "req_b"));
		expect(clientId()).not.toBe(aId);
		b.unmount();
	});

	it("bypasses the cache entirely for a host that names no key", () => {
		// The collection auth editor's case. It passes no resolver either, so
		// there is nothing to hold still - and sharing one cache entry between
		// unrelated hosts would be worse than resolving twice.
		const resolveString = makeRerollingResolver();

		const first = render(form(resolveString, undefined));
		const before = clientId();
		first.unmount();

		const second = render(form(resolveString, undefined));
		expect(clientId()).not.toBe(before);
		second.unmount();
	});

	describe("the extra parameter rows (#2536)", () => {
		const WITH_ROWS: OAuth2Config = {
			...CONFIG,
			clientId: "cid",
			authorizationParams: [{ key: "prompt", value: "{{$randomInt}}", enabled: true }],
			tokenParams: [
				{
					key: "k-{{$randomInt}}",
					value: "v-{{$randomInt}}",
					enabled: true,
					sendAs: "url",
				},
				{ key: "off", value: "x", enabled: false },
			],
			refreshParams: [{ key: "audience", value: "api-{{$randomInt}}" }],
		};
		const params = () =>
			JSON.parse(screen.getByTestId("resolved-params").textContent ?? "{}") as Pick<
				OAuth2Config,
				"authorizationParams" | "tokenParams" | "refreshParams"
			>;

		it("resolves every row's key and value, in every list, keeping the rest of the row", () => {
			const view = render(form(makeRerollingResolver(), "req_rows", WITH_ROWS));
			const { authorizationParams, tokenParams, refreshParams } = params();
			expect(authorizationParams?.[0]).toEqual({
				key: "prompt",
				value: expect.stringMatching(/^\d+$/),
				enabled: true,
			});
			expect(tokenParams?.[0]).toEqual({
				key: expect.stringMatching(/^k-\d+$/),
				value: expect.stringMatching(/^v-\d+$/),
				enabled: true,
				sendAs: "url",
			});
			expect(tokenParams?.[1]).toEqual({ key: "off", value: "x", enabled: false });
			expect(refreshParams?.[0].value).toMatch(/^api-\d+$/);
			view.unmount();
		});

		it("holds a row's resolved text still across the unmount a tab switch causes", () => {
			const resolveString = makeRerollingResolver();
			const first = render(form(resolveString, "req_rows_remount", WITH_ROWS));
			const before = screen.getByTestId("resolved-params").textContent;
			first.unmount();

			const second = render(form(resolveString, "req_rows_remount", WITH_ROWS));
			expect(screen.getByTestId("resolved-params").textContent).toBe(before);
			second.unmount();
		});

		it("leaves a list that is absent absent, and a malformed one as it is", () => {
			const malformed = {
				...CONFIG,
				tokenParams: "audience=api",
				refreshParams: [3, { key: 7, value: null }],
			} as unknown as OAuth2Config;
			const view = render(form(makeRerollingResolver(), "req_malformed", malformed));
			expect(JSON.parse(screen.getByTestId("resolved-params").textContent ?? "{}")).toEqual({
				tokenParams: "audience=api",
				refreshParams: [3, { key: 7, value: null }],
			});
			view.unmount();
		});
	});
});
