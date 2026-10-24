/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * One run's concurrency, one word for it.
 *
 * The history sidebar row said "256 workers" and the dashboard header said
 * "64 VUs" - the same `summary.concurrency` field, described two ways
 * depending on which screen you were on. Worse, "workers" is a name the engine
 * already owns (the libcurl event-loop thread count, a Settings key), so a
 * sidebar row reading "256 workers" for a run executed with `workers = 8` was
 * not just inconsistent, it was answering a question the reader did not ask.
 *
 * The defect is a *disagreement*, so pinning one component's string would not
 * catch it - the next rename to the other side would re-open the split with
 * both tests green. These render both surfaces over the same number and
 * compare the word each chose.
 *
 * Agreeing with each other is not enough: two surfaces can both be wrong the
 * same way. So every surface that names the count is also scanned for the words
 * the owner retired (#2128) - VUs, connections, concurrency, concurrent users -
 * after asserting it rendered text at all, so an empty render cannot pass as
 * clean. A Constant RPS run holds no virtual users, only requests in flight, and
 * is checked for saying so.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, screen, cleanup } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { render } from "@/test/render-with-tooltips";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import RunItem from "@/modules/history/sidebar/RunItem";
import DashboardHeader from "@/modules/dashboard/components/DashboardHeader";
import LoadTestConfigDialog from "@/modules/request-builder/components/LoadTestConfigDialog";
import { BUDGET_FIELDS } from "@/modules/request-builder/components/LoadTestConfigDialog/budgets";
import RunCollectionDialog from "@/modules/collections/RunCollectionDialog";
import { RunConfigSection } from "@/components/layout/context-bar/RunConfigSection";
import { AchievedThroughputCard } from "@/modules/dashboard/components/hero/AchievedThroughputCard";
import { ConcurrencyUtilCard } from "@/modules/dashboard/components/hero/ConcurrencyUtilCard";
import { CurrentConcurrencyCard } from "@/modules/dashboard/components/hero/CurrentConcurrencyCard";
import { SaturationCard } from "@/modules/dashboard/components/hero/SaturationCard";
import { ModeStatsRow } from "@/modules/dashboard/components/stats/ModeStatsRow";
import { TOOLTIPS } from "@/modules/dashboard/components/tooltips";
import { APP_SETTINGS } from "@/modules/settings/main/app-settings";
import {
	CONCURRENCY_LABEL,
	CONCURRENCY_UNIT,
	IN_FLIGHT_LABEL,
	LOAD_TEST_MODES,
	formatConcurrency,
} from "@/constants/load-test-modes";
import type { Collection, LoadTestMode, Run } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

type LoadMode = DashboardDerived["mode"];

/*
 * The dialogs read the engine's config and the collection tree. Only what they
 * call is replaced; the rest of each module stays real, because RunItem and the
 * dashboard import from the same barrels.
 */
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useConfigQuery: () => ({ data: { entries: [] } }),
	useCollectionsQuery: () => ({ data: [] }),
	useFullCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
	useRequestDefaultsQuery: () => ({ data: { headers: [] } }),
	useStartScenarioRunMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
	useRunQuery: () => ({ data: runUnderConfig, isLoading: false }),
}));
vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => ({
		mutate: vi.fn(),
		isPending: false,
		isError: false,
		error: null,
	}),
	useDataFileReadingMutation: () => ({
		mutate: vi.fn(),
		isPending: false,
		isError: false,
		error: null,
	}),
}));
vi.mock("@/modules/request-builder/components/OAuth2LoadTestGuard", () => ({
	default: () => null,
}));

let runUnderConfig: Run | undefined;

afterEach(cleanup);

const srcRoot = dirname(fileURLToPath(import.meta.url));

const CONCURRENCY = 64;

/**
 * Every text node under an element, separately.
 *
 * Not `textContent`: it runs the badges together ("3s" + "64 VUs" reads as
 * "3s64 VUs"), which loses the boundary the unit has to be read against.
 */
function textNodes(root: Element): string[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const out: string[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.textContent?.trim()) out.push(n.textContent);
	}
	return out;
}

/**
 * The unit a surface put immediately after the concurrency number, or null.
 * "virtual users" is two words, so a trailing "user(s)" belongs to the unit.
 */
function unitAfterConcurrency(texts: string[]): string | null {
	const pattern = new RegExp(`(?:^|\\s)${CONCURRENCY}\\s+(\\S+(?:\\s+users?)?)`);
	for (const text of texts) {
		const unit = pattern.exec(text)?.[1];
		if (unit) return unit;
	}
	return null;
}

/**
 * The words the owner retired for this count (#2128), as the user would read
 * them. `connections?` is in it because a closed-loop surface that says
 * "connections" is naming the count by the wrong word; the one place the word
 * is right (a real TCP/TLS connection) is allowlisted by name, never by
 * loosening this.
 */
const RETIRED_WORDS = /\bVUs?\b|connections?|concurrency|concurrent users/i;

/** What a surface says that a person can read: text nodes plus the labels they hear. */
function readable(root: Element): string[] {
	const attributes = Array.from(
		root.querySelectorAll("[aria-label], [placeholder], [title]")
	).flatMap((el) =>
		["aria-label", "placeholder", "title"].flatMap((name) => el.getAttribute(name) ?? [])
	);
	return [...textNodes(root), ...attributes];
}

/**
 * The surface said something, named the count by @p expected, and used none of
 * the retired words. The non-empty check comes first: a render that failed to
 * produce text would otherwise pass the ban vacuously.
 */
function expectVocabulary(surface: string, texts: string[], expected: string[]) {
	expect(texts.join("").trim(), `${surface} rendered no text`).not.toBe("");
	const text = texts.join(" ");
	for (const phrase of expected) {
		expect(text.toLowerCase(), `${surface} lacks "${phrase}"`).toContain(phrase.toLowerCase());
	}
	expect(text.match(RETIRED_WORDS)?.[0], `${surface} uses a retired word`).toBeUndefined();
}

function sidebarRow(): string[] {
	const run = {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: "https://api.example.test/users",
			method: "GET",
			mode: "constant_concurrency",
			duration: "3s",
			concurrency: CONCURRENCY,
		},
	} as Run;

	const { container } = render(
		<RunItem run={run} onSelect={() => {}} onDelete={vi.fn()} isDeleting={false} />
	);
	return textNodes(container);
}

function detailHeader(): string[] {
	const { container } = render(
		<DashboardHeader
			mode="completed"
			isStreaming={false}
			isStopping={false}
			onStop={async () => {}}
			requestUrl="https://api.example.test/users"
			requestMethod="GET"
			configuration={{ mode: "constant_concurrency", concurrency: CONCURRENCY }}
		/>
	);
	return textNodes(container);
}

/**
 * How @p code builds the count's unit by hand, or null if it does not. Two
 * shapes: the unit glued after an interpolated number (`${n} VUs`), and the unit
 * passed to `pluralize` as a literal, which is what History's scenario line did
 * and the first pattern could not see.
 */
function handBuiltUnit(code: string): string | null {
	const unit = "(?:virtual users?|VUs?|workers)";
	if (new RegExp(`\\}\\s*${unit}\\b`, "i").test(code)) return "appends the unit itself";
	if (new RegExp(`pluralize\\([^;]*?["'\`]${unit}["'\`]`, "i").test(code)) {
		return "pluralizes a unit it wrote itself";
	}
	return null;
}

describe("concurrency vocabulary", () => {
	it("describes the same run's concurrency with the same word on both surfaces", () => {
		const sidebar = unitAfterConcurrency(sidebarRow());
		const detail = unitAfterConcurrency(detailHeader());

		// Both must have rendered something - a null here would let the equality
		// below pass by rendering no concurrency at all.
		expect(sidebar, "history sidebar rendered no concurrency").not.toBeNull();
		expect(detail, "dashboard header rendered no concurrency").not.toBeNull();
		expect(sidebar).toBe(detail);
		expect(sidebar).toBe(CONCURRENCY_UNIT);
	});

	it("does not call a run's concurrency 'workers' on either surface", () => {
		// The engine's own `workers` setting is a different number entirely.
		expect(sidebarRow().join(" ")).not.toMatch(/workers/i);
		expect(detailHeader().join(" ")).not.toMatch(/workers/i);
	});

	it("renders the shared formatter's exact output on both surfaces", () => {
		expect(sidebarRow().join(" ")).toContain(formatConcurrency(CONCURRENCY));
		expect(detailHeader().join(" ")).toContain(formatConcurrency(CONCURRENCY));
	});

	it("is the only place the unit is written", () => {
		// A third surface appending its own unit is how the first split happened,
		// and a render test cannot see a surface it does not know about.
		const offences: string[] = [];

		const files = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter(
			(f) => !f.includes("load-test-modes") && !f.includes(".test.")
		);
		expect(files.length, "scan matched nothing").toBeGreaterThan(100);

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			// Strip comments: prose legitimately discusses both words.
			const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
			const how = handBuiltUnit(code);
			if (how) offences.push(`${relative(".", file)} ${how}`);
		}

		expect(offences.join("\n")).toBe("");
	});

	describe("the guard's own reach", () => {
		// The scan above is only as good as its pattern, and it once missed the
		// shape History's scenario line used: the unit as a pluralize() argument.
		it.each([
			["a unit glued to an interpolated number", "`${n} VUs`", true],
			["a singular unit after an interpolation", "`${n} virtual user`", true],
			["a unit in JSX text after the number", "<b>{n} virtual users</b>", true],
			["a unit handed to pluralize", 'pluralize(n, "virtual user")', true],
			[
				"a unit handed to pluralize over several lines",
				'pluralize(\n\tn,\n\t"virtual user"\n)',
				true,
			],
			["the retired 'workers' glued on", "`${n} workers`", true],
			["the shared formatter", "formatConcurrency(n)", false],
			["the unit as a search synonym", '["concurrency", "virtual users"]', false],
			["the noun in prose with no number before it", "`Keeps the virtual users busy`", false],
		])("%s", (_name, code, caught) => {
			expect(handBuiltUnit(code) !== null).toBe(caught);
		});
	});
});

describe("no retired word names the count on a surface that shows it (#2128)", () => {
	const CLOSED_LOOP: LoadTestMode[] = [
		"constant_concurrency",
		"iterations",
		"ramp_up",
		"capacity",
	];

	describe("the load-test dialog, in each of its five modes", () => {
		it.each(LOAD_TEST_MODES.map((m) => [m.value, m.label] as const))(
			"%s speaks virtual users and nothing retired",
			(mode, label) => {
				render(
					<LoadTestConfigDialog
						onClose={vi.fn()}
						onStart={vi.fn()}
						isStarting={false}
						hasPreRequestScript={false}
						hasPostRequestScript={false}
						isStreamingRequest={false}
					/>
				);
				fireEvent.click(screen.getByRole("radio", { name: new RegExp(label, "i") }));

				expectVocabulary(`dialog in ${mode}`, readable(document.body), [CONCURRENCY_UNIT]);
				// Constant RPS has no count to label; every other mode does.
				const labelled = screen.queryAllByLabelText(new RegExp(CONCURRENCY_LABEL, "i"));
				expect(labelled.length > 0).toBe(CLOSED_LOOP.includes(mode));
			}
		);
	});

	it("the run-collection dialog, with its load test on", () => {
		const collection = {
			id: "col_1",
			name: "Checkout",
			parentId: null,
		} as unknown as Collection;
		render(<RunCollectionDialog collection={collection} onOpenChange={vi.fn()} />);
		fireEvent.click(screen.getByRole("switch", { name: /load test/i }));

		expectVocabulary("run-collection dialog", readable(document.body), [CONCURRENCY_LABEL]);
	});

	it("the run-config row in the context bar", () => {
		runUnderConfig = {
			id: "run_1",
			type: "load",
			status: "completed",
			startTime: 0,
			endTime: 0,
			configSnapshot: { mode: "ramp_up", concurrency: CONCURRENCY, startConcurrency: 8 },
		} as Run;
		const { container } = render(
			<RunConfigSection tab={{ id: "t1", type: "run", entityId: "run_1" } as never} />
		);

		expectVocabulary("run config", readable(container), [
			CONCURRENCY_LABEL,
			formatConcurrency(8),
		]);
	});

	it("the history sidebar row and the dashboard header", () => {
		expectVocabulary("history row", sidebarRow(), [formatConcurrency(CONCURRENCY)]);
		expectVocabulary("dashboard header", detailHeader(), [formatConcurrency(CONCURRENCY)]);
	});
});

/** Every figure below is this one number, so a unit that disagrees with it is visible. */
function derivedIn(mode: LoadMode): DashboardDerived {
	return {
		mode,
		isCompleted: false,
		targetRps: 100,
		actualRps: 100,
		sendRate: 100,
		throughput: 640,
		currentRps: 100,
		avgQueueWaitMs: 0,
		totalRequests: 1000,
		failedRequests: 0,
		httpErrors: 0,
		noResponse: 0,
		statusCodes: {},
		requestsExpected: 1000,
		requestsSent: 500,
		peakConcurrency: CONCURRENCY,
		currentConcurrency: CONCURRENCY,
		configuredConcurrency: CONCURRENCY,
		backpressure: 0,
		p99Latency: 50,
		meanLatency: 20,
		medianLatency: 18,
		p95Latency: 40,
		testDuration: 30,
		elapsedSeconds: 10,
		setupOverhead: 0.1,
		cleanupOverhead: 0.05,
		droppedRequests: 0,
		showDropped: false,
		rampDeviationPct: 2,
		rampUpDurationSeconds: 10,
		startConcurrency: 1,
		targetConcurrency: CONCURRENCY,
		breakpoint: {
			crossed: true,
			concurrency: CONCURRENCY,
			timeSeconds: 5,
			p99Ms: 227,
			sloMs: 200,
			atRunStart: false,
		},
	};
}

/** What a rendered element says, as one string: `textContent` keeps "64" and "virtual users" apart by the space the card writes. */
const said = (container: Element): string[] => [container.textContent ?? ""];

describe("the dashboard's cards name the count in virtual users (#2128)", () => {
	// One case per card, so reverting one label reddens that case and no other.
	const CARDS: [string, ReactElement, string[]][] = [
		[
			"Achieved throughput",
			<AchievedThroughputCard throughput={640} configuredConcurrency={CONCURRENCY} />,
			[formatConcurrency(CONCURRENCY)],
		],
		[
			"Virtual user utilisation",
			<ConcurrencyUtilCard currentConcurrency={47} configuredConcurrency={CONCURRENCY} />,
			["Virtual user utilisation"],
		],
		[
			"Active virtual users",
			<CurrentConcurrencyCard
				currentConcurrency={47}
				targetConcurrency={CONCURRENCY}
				rampUpDurationSeconds={8}
				rampDeviationPct={2}
			/>,
			["Active virtual users"],
		],
		[
			"Saturation",
			<SaturationCard
				breakpoint={{
					crossed: true,
					concurrency: CONCURRENCY,
					timeSeconds: 5,
					p99Ms: 227,
					sloMs: 200,
					atRunStart: false,
				}}
				failedRequests={0}
			/>,
			[formatConcurrency(CONCURRENCY)],
		],
	];

	it.each(CARDS)("%s", (name, card, expected) => {
		const { container } = render(card);
		expectVocabulary(name, said(container), expected);
	});

	it("agrees with the singular for one virtual user", () => {
		const { container } = render(
			<AchievedThroughputCard throughput={10} configuredConcurrency={1} />
		);
		expect(said(container).join("")).toContain(formatConcurrency(1));
		expect(said(container).join("")).not.toContain("1 virtual users");
	});

	it.each([
		["constant_rps", "Peak in-flight requests", `Peak ${CONCURRENCY_UNIT}`],
		["constant_concurrency", "Throughput per virtual user", "Peak in-flight requests"],
		["ramp_up", `Peak ${CONCURRENCY_UNIT}`, "Peak in-flight requests"],
		["capacity", `Peak ${CONCURRENCY_UNIT}`, "Peak in-flight requests"],
		["iterations", "Elapsed", "Peak in-flight requests"],
	] as const)("%s stat row says %s, not %s", (mode, present, absent) => {
		const { container } = render(<ModeStatsRow d={derivedIn(mode)} />);
		expectVocabulary(`${mode} stat row`, said(container), [present]);
		expect(said(container).join("")).not.toContain(absent);
	});

	it("reads an unrecognised mode as open-loop, like the dashboard's default branch", () => {
		const { container } = render(<ModeStatsRow d={derivedIn("mystery" as LoadMode)} />);
		expect(said(container).join("")).toContain("Peak in-flight requests");
	});

	it("keeps 'In-flight requests' for the one mode that holds no users", () => {
		// The pair this test pins apart: the same series, named for what the mode
		// lets it count. A shared label would be wrong in one of them.
		expect(IN_FLIGHT_LABEL).not.toMatch(/virtual user/i);
		expect(CONCURRENCY_LABEL).not.toMatch(/in-flight/i);
	});
});

describe("the exported copy tables do not use the retired words (#2128)", () => {
	/** Plain text of a copy value: a string as is, markup flattened to its words. */
	function words(value: ReactNode): string {
		if (typeof value === "string") return value;
		return renderToStaticMarkup(<>{value}</>).replace(/<[^>]*>/g, "");
	}

	/**
	 * Each entry the scan lets through, with the phrase it lets through and why.
	 * The phrase is removed before the ban is applied, so the rest of the entry
	 * is still held to it.
	 */
	const REAL_CONNECTIONS: Record<string, { phrase: RegExp; reason: string }> = {
		"TOOLTIPS.errorRateNoResponse": {
			phrase: /refused connection/,
			reason: "a TCP outcome: the request never reached an HTTP status",
		},
		"TOOLTIPS.statusCodesOverTime": {
			phrase: /connection-error/,
			reason: "failures with no HTTP status, not the user count",
		},
		"TOOLTIPS.serverVitals": {
			phrase: /connection count/,
			reason: "the target server's own scraped metric",
		},
		"TOOLTIPS.phasePercentiles": {
			phrase: /connection churn/,
			reason: "TCP/TLS handshake behaviour, which is what Connect and TLS time",
		},
		"APP_SETTINGS.mcp-connection.label": {
			phrase: /Connection/,
			reason: "the endpoint an agent connects to",
		},
		"APP_SETTINGS.connection-test.label": {
			phrase: /Connection/,
			reason: "the proxy and trust probe, a real TCP/TLS connection",
		},
		"BUDGET_FIELDS.maxErrorRatePct.hint": {
			phrase: /connection failures/,
			reason: "requests that failed to connect at all, counted as errors",
		},
	};

	function expectClean(table: string, entries: [string, string][]) {
		expect(entries.length, `${table} is empty - the scan covered nothing`).toBeGreaterThan(0);
		const offences: string[] = [];
		for (const [name, text] of entries) {
			const allowed = REAL_CONNECTIONS[`${table}.${name}`];
			const checked = allowed ? text.replace(allowed.phrase, "") : text;
			const hit = checked.match(RETIRED_WORDS)?.[0];
			if (hit) offences.push(`${table}.${name}: "${hit}"`);
		}
		expect(offences.join("\n")).toBe("");
	}

	it("TOOLTIPS", () => {
		expectClean(
			"TOOLTIPS",
			Object.entries(TOOLTIPS).map(([key, tip]) => [key, words(tip)])
		);
	});

	it("allowlists only phrases that are still there", () => {
		// An entry whose phrase was reworded away would otherwise sit in the list
		// forever, excusing nothing and hiding that the scan no longer needs it.
		const tooltipText = new Map(
			Object.entries(TOOLTIPS).map(([key, tip]) => [`TOOLTIPS.${key}`, words(tip)])
		);
		const budgetText = new Map(
			BUDGET_FIELDS.map((f) => [`BUDGET_FIELDS.${f.key}.hint`, f.hint ?? ""])
		);
		const settingText = new Map(
			APP_SETTINGS.map((setting) => [`APP_SETTINGS.${setting.anchor}.label`, setting.label])
		);
		for (const [name, { phrase }] of Object.entries(REAL_CONNECTIONS)) {
			const text = tooltipText.get(name) ?? budgetText.get(name) ?? settingText.get(name);
			expect(text, `${name} no longer exists`).toBeDefined();
			expect(text, `${name} no longer says ${phrase}`).toMatch(phrase);
		}
	});

	it("LOAD_TEST_MODES", () => {
		expectClean(
			"LOAD_TEST_MODES",
			LOAD_TEST_MODES.flatMap((m) => [
				[`${m.value}.label`, m.label],
				[`${m.value}.description`, m.description],
			])
		);
	});

	it("BUDGET_FIELDS", () => {
		expectClean(
			"BUDGET_FIELDS",
			BUDGET_FIELDS.flatMap((f) => [
				[`${f.key}.label`, f.label],
				[`${f.key}.unit`, f.unit],
				[`${f.key}.hint`, f.hint ?? ""],
			])
		);
	});

	it("the Settings entries' labels and descriptions", () => {
		// `keywords` is left out on purpose: they are what a user might type, and
		// "concurrency" or "VUs" there is how someone who still thinks in the old
		// word finds the setting.
		expectClean(
			"APP_SETTINGS",
			APP_SETTINGS.flatMap((setting) => [
				[`${setting.anchor}.label`, setting.label],
				[`${setting.anchor}.searchText`, setting.searchText],
			])
		);
	});
});
