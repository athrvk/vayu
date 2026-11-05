/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { sortVariableEntriesByCreatedAt } from "./variable-order";
import type { VariableValue } from "@/types";

const row = (createdAt?: number): VariableValue => ({
	value: "",
	enabled: true,
	...(createdAt === undefined ? {} : { createdAt }),
});

const names = (entries: [string, VariableValue][]) => entries.map(([name]) => name);

describe("sortVariableEntriesByCreatedAt", () => {
	it("orders oldest first, whatever the names say", () => {
		const sorted = sortVariableEntriesByCreatedAt([
			["alpha", row(30)],
			["zulu", row(10)],
			["mike", row(20)],
		]);
		expect(names(sorted)).toEqual(["zulu", "mike", "alpha"]);
	});

	it("sorts a missing createdAt as older than every stamped row", () => {
		const sorted = sortVariableEntriesByCreatedAt([
			["stamped", row(1)],
			["unstamped", row()],
		]);
		expect(names(sorted)).toEqual(["unstamped", "stamped"]);
	});

	it("breaks a tie by name, ignoring case", () => {
		const sorted = sortVariableEntriesByCreatedAt([
			["beta", row(5)],
			["Alpha", row(5)],
			["gamma", row(5)],
		]);
		expect(names(sorted)).toEqual(["Alpha", "beta", "gamma"]);
	});

	it("returns a new array and leaves its input alone", () => {
		const input: [string, VariableValue][] = [
			["b", row(2)],
			["a", row(1)],
		];
		const sorted = sortVariableEntriesByCreatedAt(input);
		expect(sorted).not.toBe(input);
		expect(names(input)).toEqual(["b", "a"]);
	});
});
