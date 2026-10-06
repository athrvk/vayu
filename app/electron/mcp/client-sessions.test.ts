/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test } from "vitest";
import { CLIENT_SESSION_IDLE_MS, ClientSessions, MAX_CLIENT_SESSIONS } from "./client-sessions.js";

/** A session map on a clock the test moves by hand. */
function sessionsAt(start = 1_000_000, cap?: number, idleMs?: number) {
	const clock = { now: start };
	const sessions = new ClientSessions(() => clock.now, cap, idleMs);
	return { sessions, clock };
}

describe("ClientSessions", () => {
	test("answers the name recorded under a session id", () => {
		const { sessions } = sessionsAt();
		sessions.remember("s1", "claude-code");
		sessions.remember("s2", "cursor");
		expect(sessions.clientName("s1")).toBe("claude-code");
		expect(sessions.clientName("s2")).toBe("cursor");
	});

	test("answers nothing for a missing or unknown id", () => {
		const { sessions } = sessionsAt();
		sessions.remember("s1", "claude-code");
		expect(sessions.clientName(undefined)).toBeUndefined();
		expect(sessions.clientName("never-issued")).toBeUndefined();
	});

	test("forgets a session idle past the expiry, and only then", () => {
		const { sessions, clock } = sessionsAt(1_000_000, 8, 1_000);
		sessions.remember("s1", "claude-code");
		clock.now += 1_000;
		expect(sessions.clientName("s1")).toBe("claude-code");
		clock.now += 1_001;
		expect(sessions.clientName("s1")).toBeUndefined();
		expect(sessions.size).toBe(0);
	});

	test("a lookup restarts the idle clock", () => {
		const { sessions, clock } = sessionsAt(1_000_000, 8, 1_000);
		sessions.remember("s1", "claude-code");
		for (let i = 0; i < 5; i++) {
			clock.now += 900;
			expect(sessions.clientName("s1")).toBe("claude-code");
		}
	});

	test("past the cap, the least recently seen session goes first", () => {
		const { sessions } = sessionsAt(1_000_000, 3);
		sessions.remember("a", "A");
		sessions.remember("b", "B");
		sessions.remember("c", "C");
		// Seen again, so `b` is now the stalest.
		expect(sessions.clientName("a")).toBe("A");
		sessions.remember("d", "D");
		expect(sessions.size).toBe(3);
		expect(sessions.clientName("b")).toBeUndefined();
		expect(sessions.clientName("a")).toBe("A");
		expect(sessions.clientName("c")).toBe("C");
		expect(sessions.clientName("d")).toBe("D");
	});

	test("recording sweeps out expired sessions even under the cap", () => {
		const { sessions, clock } = sessionsAt(1_000_000, 8, 1_000);
		sessions.remember("old", "A");
		clock.now += 5_000;
		sessions.remember("new", "B");
		expect(sessions.size).toBe(1);
	});

	test("the default bounds hold however many handshakes arrive", () => {
		const { sessions } = sessionsAt();
		for (let i = 0; i < MAX_CLIENT_SESSIONS * 4; i++) sessions.remember(`s${i}`, "x");
		expect(sessions.size).toBe(MAX_CLIENT_SESSIONS);
	});

	test("the default expiry is the exported one", () => {
		const { sessions, clock } = sessionsAt();
		sessions.remember("s1", "claude-code");
		clock.now += CLIENT_SESSION_IDLE_MS;
		expect(sessions.clientName("s1")).toBe("claude-code");
		clock.now += CLIENT_SESSION_IDLE_MS + 1;
		expect(sessions.clientName("s1")).toBeUndefined();
	});
});
