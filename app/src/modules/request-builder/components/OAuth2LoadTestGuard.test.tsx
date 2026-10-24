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
 * A load run fetches its OAuth 2.0 token once, before any script, from the
 * stored values (#2742). When a pre-request script may change a name the config uses,
 * a Send would judge another token, so each verdict says which one it is about;
 * with no such script the wording is the one it always had.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OAuth2Config } from "@/types";
import OAuth2LoadTestGuard from "./OAuth2LoadTestGuard";

const statusQuery = { data: undefined as unknown };
const fetchMutation = { mutate: vi.fn(), isPending: false };

vi.mock("@/queries/oauth", () => ({
	useOAuth2TokenStatusQuery: () => statusQuery,
	useFetchOAuth2TokenMutation: () => fetchMutation,
}));

vi.mock("@/stores", () => ({
	useToastStore: (select: (state: { showToast: () => void }) => unknown) =>
		select({ showToast: vi.fn() }),
}));

const config: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://auth.example.com/token",
	clientId: "{{clientId}}",
};

/** A cached token with @p remainingS left of a @p lifetimeS life. */
function cacheToken(lifetimeS: number, remainingS: number) {
	statusQuery.data = {
		found: true,
		token: {
			expiresIn: lifetimeS,
			expiresAt: Date.now() + remainingS * 1000,
			hasRefreshToken: true,
		},
	};
}

function renderGuard(props: {
	scriptMayChangeSettings?: boolean;
	durationSeconds?: number;
	config?: OAuth2Config;
}) {
	render(
		<OAuth2LoadTestGuard
			config={props.config ?? config}
			durationSeconds={props.durationSeconds ?? 600}
			scriptMayChangeSettings={props.scriptMayChangeSettings}
			onGateChange={vi.fn()}
		/>
	);
}

/** The engine cannot renew this one, so a token shorter than the run is a warning. */
const unrenewable: OAuth2Config = { ...config, autoRefreshToken: false };

interface Verdict {
	name: string;
	arrange: () => void;
	config?: OAuth2Config;
	plain: RegExp;
	scripted: RegExp;
}

const VERDICTS: Verdict[] = [
	{
		name: "covered",
		arrange: () => cacheToken(7200, 7200),
		plain: /^Access token covers the whole run\.$/,
		scripted: /^The token fetched before scripts covers the whole run\.$/,
	},
	{
		name: "covered by the engine's renewal",
		arrange: () => cacheToken(300, 300),
		plain: /^Access token expires during the run - Vayu's engine refreshes it mid-run\.$/,
		scripted:
			/^The token fetched before scripts expires during the run - Vayu's engine refreshes it mid-run\.$/,
	},
	{
		name: "no token cached",
		arrange: () => {
			statusQuery.data = { found: false };
		},
		plain: /^No token cached yet$/,
		scripted: /^No token cached for the stored settings$/,
	},
	{
		name: "token expires before the run ends",
		arrange: () => cacheToken(3600, 30),
		config: unrenewable,
		plain: /^Token expires before the run ends$/,
		scripted: /^Token fetched before scripts expires before the run ends$/,
	},
	{
		name: "token shorter than the run",
		arrange: () => cacheToken(120, 60),
		config: unrenewable,
		plain: /^Token is shorter than the run$/,
		scripted: /^Token fetched before scripts is shorter than the run$/,
	},
];

describe("OAuth2LoadTestGuard's verdict wording", () => {
	beforeEach(() => {
		statusQuery.data = undefined;
	});

	it.each(VERDICTS)("$name: keeps its usual wording with no script", (v) => {
		v.arrange();
		renderGuard({ config: v.config, scriptMayChangeSettings: false });

		expect(screen.getByText(v.plain)).toBeInTheDocument();
	});

	it.each(VERDICTS)(
		"$name: names the token fetched before scripts when a script may change a name",
		(v) => {
			v.arrange();
			renderGuard({ config: v.config, scriptMayChangeSettings: true });

			expect(screen.getByText(v.scripted)).toBeInTheDocument();
			expect(screen.queryByText(v.plain)).toBeNull();
		}
	);
});
