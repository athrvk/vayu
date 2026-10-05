/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	parseTimeValue,
	describeInstant,
	formatDayHeading,
	formatInstant,
	formatRelative,
	resolveTimeZone,
} from "./time-value";

const NOON = "2026-10-05T12:00:00.000Z";

describe("parseTimeValue", () => {
	const recognised: [string, string, string, boolean][] = [
		["2026-10-05T08:10:00.672Z", "2026-10-05T08:10:00.672Z", "iso", true],
		["2026-10-05T17:40:00+05:30", "2026-10-05T12:10:00.000Z", "iso", true],
		["2026-10-05T17:40:00+0530", "2026-10-05T12:10:00.000Z", "iso", true],
		["2026-10-05T07:00:00-05:00", NOON, "iso", true],
		["2026-10-05T12:00:00", NOON, "iso", false],
		["2026-10-05", "2026-10-05T00:00:00.000Z", "iso", false],
		["Sun, 05 Oct 2026 12:00:00 GMT", NOON, "http-date", true],
		["Sunday, 05-Oct-26 12:00:00 GMT", NOON, "http-date", true],
		["Sun Oct  5 12:00:00 2026", NOON, "http-date", true],
		["Mon, 05-Oct-2026 12:00:00 GMT", NOON, "http-date", true],
		["1791201600", NOON, "epoch-seconds", true],
		["1791201600000", NOON, "epoch-milliseconds", true],
	];
	it.each(recognised)("reads %s", (text, iso, form, hasZone) => {
		const parsed = parseTimeValue(text);
		expect(parsed?.instant.toISOString()).toBe(iso);
		expect(parsed?.form).toBe(form);
		expect(parsed?.hasZone).toBe(hasZone);
	});

	const nearMisses = [
		"2026.10.05",
		"20261005",
		"1791201600000000",
		"2026-02-31",
		"2026-10-05-10",
		"2026-13-01",
		"2026-10-05T25:00:00Z",
		"999999999",
		"1000000000000000",
		"Mon, 05 Foo 2026 12:00:00 GMT",
		"text 2026-10-05",
		"12345",
		"",
	];
	it.each(nearMisses)("reads %j as no time", (text) => {
		expect(parseTimeValue(text)).toBeNull();
	});

	it("keeps ten-digit numbers outside the epoch window out", () => {
		expect(parseTimeValue("9999999999")).toBeNull();
		expect(parseTimeValue("0123456789")).toBeNull();
	});
});

describe("describeInstant", () => {
	const instant = new Date(NOON);
	const now = new Date("2026-10-05T14:00:00.000Z");

	it("names the user's zone, UTC and the relative phrase", () => {
		const rows = describeInstant(instant, { timeZone: "Asia/Kolkata", locale: "en-US", now });
		expect(rows.map((r) => r.label)).toEqual(["Asia/Kolkata", "UTC", "Relative"]);
		expect(rows[0].value).toContain("5:30:00 PM");
		expect(rows[0].value).toContain("GMT+5:30");
		expect(rows[1].value).toContain("12:00:00 PM");
		expect(rows[1].value).toContain("UTC");
		expect(rows[2].value).toBe("2 hours ago");
	});

	it("shows one row, not two UTC rows, when the user's zone is UTC", () => {
		const rows = describeInstant(instant, { timeZone: "UTC", locale: "en-US", now });
		expect(rows.map((r) => r.label)).toEqual(["UTC", "Relative"]);
	});

	it("converts to a second zone, so no case reads the host zone", () => {
		const rows = describeInstant(instant, {
			timeZone: "America/New_York",
			locale: "en-US",
			now,
		});
		expect(rows[0].label).toBe("America/New_York");
		expect(rows[0].value).toContain("8:00:00 AM");
		expect(rows[0].value).toContain("EDT");
	});

	it("appends the original text when one is given", () => {
		const rows = describeInstant(
			instant,
			{ timeZone: "UTC", locale: "en-US", now },
			{ text: "1791201600", hasZone: true }
		);
		expect(rows[rows.length - 1]).toEqual({ label: "Original", value: "1791201600" });
	});

	it("shows a zoneless value as written and says why", () => {
		const rows = describeInstant(
			instant,
			{ timeZone: "UTC", locale: "en-US", now },
			{ text: "2026-10-05", hasZone: false }
		);
		expect(rows[0]).toEqual({ label: "As written", value: "2026-10-05" });
		expect(rows[1].value).toMatch(/no zone/);
		expect(rows.some((r) => r.label === "UTC")).toBe(false);
	});
});

describe("formatRelative", () => {
	const now = new Date("2026-10-05T12:00:00.000Z");
	const at = (offsetSeconds: number) => new Date(now.getTime() + offsetSeconds * 1000);

	it.each([
		[-10, "now"],
		[-59 * 60, "59 minutes ago"],
		[-3 * 3600, "3 hours ago"],
		[-2 * 86400, "2 days ago"],
		[-14 * 86400, "2 weeks ago"],
		[3 * 86400, "in 3 days"],
	])("%d seconds out reads %s", (offset, phrase) => {
		expect(formatRelative(at(offset), { now, locale: "en-US" })).toBe(phrase);
	});
});

describe("formatInstant", () => {
	const instant = new Date(NOON);
	it("formats each style in the explicit zone", () => {
		expect(formatInstant(instant, "time", { timeZone: "Asia/Kolkata", locale: "en-US" })).toBe(
			"5:30:00 PM"
		);
		expect(formatInstant(instant, "date", { timeZone: "UTC", locale: "en-US" })).toBe(
			"10/5/26"
		);
		expect(formatInstant(instant, "datetime", { timeZone: "UTC", locale: "en-US" })).toBe(
			"10/5/26, 12:00:00 PM"
		);
	});
	it("keeps milliseconds on a time-ms row, in 24-hour form", () => {
		const ms = new Date("2026-10-05T12:00:00.045Z");
		expect(formatInstant(ms, "time-ms", { timeZone: "Asia/Kolkata", locale: "en-US" })).toBe(
			"17:30:00.045"
		);
	});
	it("returns empty text for an invalid date rather than throwing", () => {
		expect(formatInstant("nope")).toBe("");
	});
});

describe("resolveTimeZone", () => {
	it("echoes an explicit zone", () => {
		expect(resolveTimeZone({ timeZone: "Asia/Kolkata" })).toBe("Asia/Kolkata");
	});
});

describe("formatDayHeading", () => {
	const now = new Date("2026-10-05T12:00:00.000Z");
	const options = { timeZone: "UTC", locale: "en-US" };
	it("drops the year inside the current one and keeps it outside", () => {
		expect(formatDayHeading(new Date("2026-09-05T12:00:00Z"), now, options)).toBe("Sep 5");
		expect(formatDayHeading(new Date("2025-12-31T12:00:00Z"), now, options)).toBe(
			"Dec 31, 2025"
		);
	});
	it("reads the year in the heading's own zone", () => {
		const newYear = new Date("2025-12-31T20:00:00Z");
		const sameYearNow = new Date("2026-01-02T12:00:00Z");
		expect(
			formatDayHeading(newYear, sameYearNow, { ...options, timeZone: "Asia/Kolkata" })
		).toBe("Jan 1");
		expect(formatDayHeading(newYear, sameYearNow, options)).toBe("Dec 31, 2025");
	});
});
