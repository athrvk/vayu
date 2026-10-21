/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	selectedCertificates,
	unselectedCertificateCount,
	withCertificateTicked,
} from "./client-certificate-selection";
import type { ImportResult } from "./types";

const candidates = [
	{ host: "a.example.com", certPath: "/c/a.pem" },
	{ host: "b.example.com", certPath: "/c/b.pem" },
];

const offered = { clientCertificates: candidates } as unknown as ImportResult;
const none = {} as unknown as ImportResult;

describe("selectedCertificates", () => {
	it("is empty when nothing is selected, however many are offered", () => {
		expect(selectedCertificates(offered)).toEqual([]);
		expect(selectedCertificates(offered, [])).toEqual([]);
	});

	it("is empty for a parse that lists no candidates", () => {
		expect(selectedCertificates(none, [])).toEqual([]);
	});

	it("returns the selected candidates once each, in the order offered", () => {
		expect(selectedCertificates(offered, [1, 0, 1])).toEqual(candidates);
	});

	it("throws on an index the preview did not list", () => {
		expect(() => selectedCertificates(offered, [2])).toThrow(/lists 2/);
		expect(() => selectedCertificates(none, [0])).toThrow(/lists 0/);
	});
});

describe("unselectedCertificateCount", () => {
	it("counts the candidates left out", () => {
		expect(unselectedCertificateCount(offered)).toBe(2);
		expect(unselectedCertificateCount(offered, [0])).toBe(1);
		expect(unselectedCertificateCount(offered, [0, 1])).toBe(0);
		expect(unselectedCertificateCount(none)).toBe(0);
	});
});

describe("withCertificateTicked", () => {
	it("adds an index in order and removes it again", () => {
		const ticked = withCertificateTicked(withCertificateTicked(undefined, 1, true), 0, true);
		expect(ticked).toEqual([0, 1]);
		expect(withCertificateTicked(ticked, 0, false)).toEqual([1]);
	});

	it("does not repeat an index ticked twice", () => {
		expect(withCertificateTicked([1], 1, true)).toEqual([1]);
	});
});
