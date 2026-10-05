/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one place a piece of text becomes a time (issue #1786).
 *
 * `parseTimeValue` decides whether API data - a body string, a header, a
 * variable - is a time; `describeInstant` builds the rows the hover card shows;
 * `formatInstant` is the one formatter Vayu's own surfaces render a time with.
 * Everything is built on `Intl`, so the OS locale and zone decide and no setting
 * exists. Nothing else under `app/src` calls `toLocale*String` or hand-rolls a
 * relative phrase - `time-surfaces.test.ts` fails on it.
 */

export type TimeForm = "iso" | "http-date" | "epoch-seconds" | "epoch-milliseconds";

export interface ParsedTime {
	instant: Date;
	form: TimeForm;
	/**
	 * Whether the text named a zone. A value without one (`2026-10-05`,
	 * `2026-10-05T08:10:00`) has no instant of its own: `instant` reads its
	 * fields as UTC only so the value can be ordered, and the card shows it as
	 * written rather than converting it.
	 */
	hasZone: boolean;
}

/**
 * Epoch integers are accepted in this window only (2001-09-09 to 2100-01-01),
 * so an id, a port or a counter that happens to be ten digits long is not
 * painted as a time. The digit count then picks the unit: 10 is seconds, 13 is
 * milliseconds; any other length is not an epoch.
 */
const EPOCH_MIN_SECONDS = 1_000_000_000;
const EPOCH_MAX_SECONDS = 4_102_444_800;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const ISO_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** `Sun, 05 Oct 2026 07:23:00 GMT` - IMF-fixdate, the form RFC 7231 requires. */
const IMF_FIXDATE = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
/**
 * `Sunday, 05-Oct-26 07:23:00 GMT` - the obsolete RFC 850 form, and the
 * four-digit-year variant servers send in `Set-Cookie` (`Wed, 21-Oct-2026 ...`).
 */
const RFC_850 = /^[A-Za-z]{3,9}, (\d{2})-([A-Za-z]{3})-(\d{2}|\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
/** `Sun Oct  5 07:23:00 2026` - asctime(), always UTC in HTTP. */
const ASCTIME = /^[A-Za-z]{3} ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** Build a UTC instant, or null when a field is out of range (`2026-02-31`). */
function utcInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	millisecond = 0
): Date | null {
	if (hour > 23 || minute > 59 || second > 60) return null;
	const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millisecond));
	// `Date.UTC` maps years 0-99 to 19xx; setting the year afterwards keeps `0050`.
	date.setUTCFullYear(year);
	// `Date.UTC` rolls 31 February into March; a roundtrip that moved the day
	// means the text was not a date.
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date;
}

function monthNumber(name: string): number | null {
	const index = MONTHS.indexOf(name.toLowerCase());
	return index === -1 ? null : index + 1;
}

/** Offset text (`Z`, `+05:30`, `+0530`, `+05`) in minutes, or null when invalid. */
function offsetMinutes(text: string): number | null {
	if (text === "Z" || text === "z") return 0;
	const sign = text[0] === "-" ? -1 : 1;
	const digits = text.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
	if (hours > 23 || minutes > 59) return null;
	return sign * (hours * 60 + minutes);
}

function parseIso(text: string): ParsedTime | null {
	const match = ISO_PATTERN.exec(text);
	if (!match) return null;
	const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone] = match;
	// Milliseconds only: `Date` cannot hold finer, and the card shows seconds.
	const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3));
	const wall = utcInstant(
		Number(year),
		Number(month),
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
		millisecond
	);
	if (!wall) return null;
	if (zone === undefined) return { instant: wall, form: "iso", hasZone: false };
	const offset = offsetMinutes(zone);
	if (offset === null) return null;
	return {
		instant: new Date(wall.getTime() - offset * 60_000),
		form: "iso",
		hasZone: true,
	};
}

function httpDate(instant: Date | null): ParsedTime | null {
	return instant ? { instant, form: "http-date", hasZone: true } : null;
}

function parseHttpDate(text: string): ParsedTime | null {
	const imf = IMF_FIXDATE.exec(text);
	if (imf) {
		const month = monthNumber(imf[2]);
		if (!month) return null;
		return httpDate(utcInstant(+imf[3], month, +imf[1], +imf[4], +imf[5], +imf[6]));
	}
	const rfc850 = RFC_850.exec(text);
	if (rfc850) {
		const month = monthNumber(rfc850[2]);
		if (!month) return null;
		// RFC 7231 section 7.1.1.1: a two-digit year more than 50 years ahead
		// of now reads as the past century. Fixed pivot of 70 is what every
		// engine does in practice and keeps the parse independent of the clock.
		const short = +rfc850[3];
		const year = rfc850[3].length === 4 ? short : short >= 70 ? 1900 + short : 2000 + short;
		return httpDate(utcInstant(year, month, +rfc850[1], +rfc850[4], +rfc850[5], +rfc850[6]));
	}
	const asctime = ASCTIME.exec(text);
	if (asctime) {
		const month = monthNumber(asctime[1]);
		if (!month) return null;
		return httpDate(
			utcInstant(
				+asctime[6],
				month,
				+asctime[2].trim(),
				+asctime[3],
				+asctime[4],
				+asctime[5]
			)
		);
	}
	return null;
}

function parseEpoch(text: string): ParsedTime | null {
	if (!/^\d+$/.test(text)) return null;
	const value = Number(text);
	if (text.length === 10) {
		if (value < EPOCH_MIN_SECONDS || value > EPOCH_MAX_SECONDS) return null;
		return { instant: new Date(value * 1000), form: "epoch-seconds", hasZone: true };
	}
	if (text.length === 13) {
		const seconds = value / 1000;
		if (seconds < EPOCH_MIN_SECONDS || seconds > EPOCH_MAX_SECONDS) return null;
		return { instant: new Date(value), form: "epoch-milliseconds", hasZone: true };
	}
	return null;
}

/**
 * Whether @p text is a machine time, and which instant it names. Near misses -
 * a version `2026.10.05`, an id `20261005`, a sixteen-digit number - return
 * null: a false positive underlines data that is not a time, which costs more
 * trust than a missed time costs convenience.
 */
export function parseTimeValue(text: string): ParsedTime | null {
	const trimmed = text.trim();
	if (trimmed.length < 10 || trimmed.length > 40) return null;
	return parseIso(trimmed) ?? parseHttpDate(trimmed) ?? parseEpoch(trimmed);
}

export interface FormatOptions {
	/** IANA zone; the host's when omitted. Tests pass it so no case reads the machine. */
	timeZone?: string;
	/** BCP 47 locale; the host's when omitted. */
	locale?: string;
}

export interface DescribeOptions extends FormatOptions {
	/** The reference for the relative phrase; the clock when omitted. */
	now?: Date;
}

export interface TimeRow {
	label: string;
	value: string;
}

const CARD_FORMAT: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	second: "2-digit",
	timeZoneName: "short",
};

/** The zone the platform resolves for @p options - the host's unless one was passed. */
export function resolveTimeZone(options: FormatOptions = {}): string {
	// Echoed as given: ICU canonicalises `Asia/Kolkata` to `Asia/Calcutta`.
	if (options.timeZone) return options.timeZone;
	return new Intl.DateTimeFormat(options.locale, { timeZone: options.timeZone }).resolvedOptions()
		.timeZone;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
	["second", 1],
];

/**
 * "2 hours ago", "in 3 days", "now" - from `Intl.RelativeTimeFormat`, so the
 * phrase is in the user's language and pluralises the way that language does.
 * Under a minute reads as the platform's own "now".
 */
export function formatRelative(
	instant: Date | number | string,
	options: DescribeOptions = {}
): string {
	const target = new Date(instant).getTime();
	const now = (options.now ?? new Date()).getTime();
	const formatter = new Intl.RelativeTimeFormat(options.locale, { numeric: "auto" });
	const diffSeconds = Math.round((target - now) / 1000);
	if (Math.abs(diffSeconds) < 60) return formatter.format(0, "second");
	for (const [unit, size] of RELATIVE_UNITS) {
		if (Math.abs(diffSeconds) >= size) {
			return formatter.format(Math.trunc(diffSeconds / size), unit);
		}
	}
	return formatter.format(0, "second");
}

/** The rows the hover card shows for a parsed time or a bare instant. */
export function describeInstant(
	instant: Date,
	options: DescribeOptions = {},
	original?: { text: string; hasZone: boolean }
): TimeRow[] {
	const zone = resolveTimeZone(options);
	const asWritten = original !== undefined && !original.hasZone;
	if (asWritten) {
		return [
			{ label: "As written", value: original.text },
			{ label: "Zone", value: "the value names no zone, so it is shown as written" },
		];
	}
	const format = (timeZone: string | undefined) =>
		new Intl.DateTimeFormat(options.locale, { ...CARD_FORMAT, timeZone }).format(instant);
	// A user already in UTC gets one row, not two rows both labelled "UTC".
	const inUtc = zone === "UTC" || zone === "Etc/UTC";
	const rows: TimeRow[] = [
		{ label: zone, value: format(options.timeZone) },
		...(inUtc ? [] : [{ label: "UTC", value: format("UTC") }]),
		{ label: "Relative", value: formatRelative(instant, options) },
	];
	if (original) rows.push({ label: "Original", value: original.text });
	return rows;
}

/** How a surface wants its time spelled. */
export type TimeStyle =
	/** Date and time in the user's zone, the platform's default shape. */
	| "datetime"
	| "date"
	/** Wall-clock only - a list row where the day is the section heading. */
	| "time"
	/** Wall-clock with milliseconds - a live row that tells apart sends in one second. */
	| "time-ms"
	| "relative";

/**
 * The visible text of a time on one of Vayu's own surfaces. The only formatter
 * a display path may use; `TimeValue` calls it and adds the card.
 */
export function formatInstant(
	value: Date | number | string,
	style: TimeStyle = "datetime",
	options: DescribeOptions = {}
): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	switch (style) {
		case "relative":
			return formatRelative(date, options);
		case "date":
			return new Intl.DateTimeFormat(options.locale, {
				dateStyle: "short",
				timeZone: options.timeZone,
			}).format(date);
		case "time":
			return new Intl.DateTimeFormat(options.locale, {
				timeStyle: "medium",
				timeZone: options.timeZone,
			}).format(date);
		case "time-ms": {
			// `fractionalSecondDigits` is not in the DOM lib's typings, and a zone
			// never shifts milliseconds, so they are appended to the formatted time.
			const wall = new Intl.DateTimeFormat(options.locale, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
				timeZone: options.timeZone,
			}).format(date);
			return `${wall}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
		}
		case "datetime":
			return new Intl.DateTimeFormat(options.locale, {
				dateStyle: "short",
				timeStyle: "medium",
				timeZone: options.timeZone,
			}).format(date);
	}
}

/**
 * A calendar-day heading such as "Sep 5", with the year only when @p instant
 * falls outside @p now's year. Day groups are headings over rows that each carry
 * their own `TimeValue`, so the heading is plain text rather than an instant.
 */
export function formatDayHeading(instant: Date, now: Date, options: FormatOptions = {}): string {
	const yearOf = (date: Date) =>
		new Intl.DateTimeFormat(options.locale, {
			year: "numeric",
			timeZone: options.timeZone,
		}).format(date);
	return new Intl.DateTimeFormat(options.locale, {
		month: "short",
		day: "numeric",
		year: yearOf(instant) === yearOf(now) ? undefined : "numeric",
		timeZone: options.timeZone,
	}).format(instant);
}
