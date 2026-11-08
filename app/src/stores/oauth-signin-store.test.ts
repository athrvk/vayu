/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { oauthSignin, useIsSigningIn, useOAuthSigninStore } from "./oauth-signin-store";

const active = () => [...useOAuthSigninStore.getState().active];

/** Cancel through the store so the module's maps empty as well as the state. */
function resetStore() {
	for (const key of active()) oauthSignin.cancel(key);
}

beforeEach(resetStore);

describe("oauthSignin.begin", () => {
	it("hands out a live signal and marks the key active", () => {
		const signal = oauthSignin.begin("a");

		expect(signal).not.toBeNull();
		expect(signal?.aborted).toBe(false);
		expect(active()).toEqual(["a"]);
	});

	it("refuses a second sign-in for a key that is running", () => {
		oauthSignin.begin("a");

		expect(oauthSignin.begin("a")).toBeNull();
	});

	it("runs different keys side by side", () => {
		expect(oauthSignin.begin("a")).not.toBeNull();
		expect(oauthSignin.begin("b")).not.toBeNull();

		expect(active().sort()).toEqual(["a", "b"]);
	});
});

describe("oauthSignin.end", () => {
	it("frees the key for the next sign-in without aborting", () => {
		const signal = oauthSignin.begin("a")!;

		oauthSignin.end("a", signal);

		expect(signal.aborted).toBe(false);
		expect(active()).toEqual([]);
		expect(oauthSignin.begin("a")).not.toBeNull();
	});

	it("ignores a flow that was cancelled and has settled late", () => {
		const first = oauthSignin.begin("a")!;
		oauthSignin.cancel("a");
		const second = oauthSignin.begin("a")!;

		oauthSignin.end("a", first);

		expect(active()).toEqual(["a"]);
		expect(second.aborted).toBe(false);
	});
});

describe("oauthSignin.cancel", () => {
	it("aborts the signal and clears the key at once", () => {
		const signal = oauthSignin.begin("a")!;

		oauthSignin.cancel("a");

		expect(signal.aborted).toBe(true);
		expect(active()).toEqual([]);
	});

	it("leaves another key running", () => {
		oauthSignin.begin("a");
		const other = oauthSignin.begin("b")!;

		oauthSignin.cancel("a");

		expect(other.aborted).toBe(false);
		expect(active()).toEqual(["b"]);
	});

	it("does nothing for a key that is not running", () => {
		const before = useOAuthSigninStore.getState().active;

		oauthSignin.cancel("never");

		expect(useOAuthSigninStore.getState().active).toBe(before);
	});
});

describe("oauthSignin.acquire", () => {
	it("keeps the sign-in while any owner is left, and stops it with the last", () => {
		const releaseFirst = oauthSignin.acquire("a");
		const releaseSecond = oauthSignin.acquire("a");
		const signal = oauthSignin.begin("a")!;

		releaseFirst();
		expect(signal.aborted).toBe(false);
		expect(active()).toEqual(["a"]);

		releaseSecond();
		expect(signal.aborted).toBe(true);
		expect(active()).toEqual([]);
	});

	it("counts one owner once, however many times its release is called", () => {
		const releaseFirst = oauthSignin.acquire("a");
		const releaseSecond = oauthSignin.acquire("a");
		const signal = oauthSignin.begin("a")!;

		releaseFirst();
		releaseFirst();

		expect(signal.aborted).toBe(false);
		releaseSecond();
		expect(signal.aborted).toBe(true);
	});

	it("starts a fresh count once everyone has left", () => {
		oauthSignin.acquire("a")();
		const release = oauthSignin.acquire("a");
		const signal = oauthSignin.begin("a")!;

		expect(signal.aborted).toBe(false);
		release();
		expect(signal.aborted).toBe(true);
	});

	it("does not touch another key's sign-in", () => {
		const release = oauthSignin.acquire("a");
		oauthSignin.acquire("b");
		const other = oauthSignin.begin("b")!;

		release();

		expect(other.aborted).toBe(false);
	});
});

describe("useIsSigningIn", () => {
	it("follows the key, and is false without one", () => {
		const { result } = renderHook(() => useIsSigningIn("a"));
		const { result: keyless } = renderHook(() => useIsSigningIn(null));
		expect(result.current).toBe(false);

		let signal: AbortSignal | null = null;
		act(() => {
			signal = oauthSignin.begin("a");
		});
		expect(result.current).toBe(true);
		expect(keyless.current).toBe(false);

		act(() => {
			oauthSignin.end("a", signal!);
		});
		expect(result.current).toBe(false);
	});
});
