/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Anomaly detection over a run's per-tick series - the windows a cumulative
 * summary hides.
 *
 * A run's averages answer "how did it go overall"; they cannot answer "when did
 * it go wrong". A p99 that quadrupled for three seconds and recovered moves the
 * run's mean by almost nothing, so the only trace of it is a bump on a chart the
 * reader has to notice unaided. This scans the same per-tick series the charts
 * plot and *names* those windows, so the finding is stated rather than left to
 * be spotted.
 *
 * Deliberately dumb: fixed factors over a trailing median, a minimum run length,
 * and nothing tunable. A detector with knobs is a detector nobody trusts the
 * defaults of, and one with a model is a detector that flags different windows
 * on the same data twice. Every constant below is exported so the tests pin the
 * rule rather than restate it.
 *
 * Pure over `LoadTestMetrics[]`, like {@link computeBreakpoint} beside it: the
 * live dashboard and the history view both derive from their own series and pass
 * the result down, so no card re-derives from raw metrics.
 *
 * ## One-shot, or incremental over a live buffer
 *
 * {@link detectAnomalies} is the one-shot: a whole series in, its windows out,
 * no state. That is what the history view wants, and it is the definition every
 * rule here is written against.
 *
 * The live dashboard cannot afford it. Its buffer is handed over again on every
 * store commit - twice a second by default, and the array reference changes each
 * time - so a from-scratch pass re-derived a trailing median *per tick, per
 * series* over the whole retained window: ~9,000 fifteen-element sorts twice a
 * second at the default 5-minute window, up to ~150,000 during a full-run soak,
 * on the renderer's main thread (#1151). So the live path holds a
 * {@link createAnomalyDetector} instead, which recognises the next buffer as the
 * last one with ticks appended and the oldest dropped, and derives only what
 * actually arrived.
 *
 * The two agree exactly, and the split that makes that true is worth stating,
 * because every future rule has to honour it:
 *
 * - What a tick's own value and its **predecessors** decide - a trailing median,
 *   a failure-rate delta, whether the rule is satisfied - is computed once, when
 *   the tick arrives, and cached under an absolute tick index that no later trim
 *   renumbers. None of it can change afterwards.
 * - What a tick's **position in the buffer** decides is the part a trim moves:
 *   there is no baseline for the first {@link BASELINE_TICKS} ticks and no delta
 *   for the first tick, so a window resting on history that has since rolled out
 *   has to go quiet, exactly as a from-scratch pass over the shortened buffer
 *   does. A position only ever *falls*, so that is a one-way door - hotness is
 *   monotone, and re-applying the rule is {@link clipRunsFront} moving the
 *   leading window's start to the oldest tick the rule can still speak for. A
 *   trim clips a window and can never split one.
 *
 * Which is why the front clip is load-bearing rather than defensive: it is the
 * only thing that re-applies a positional rule after ingest, and reverting it
 * makes the equivalence tests fail on the first trim.
 */

import type { LoadTestMetrics } from "@/types";

export type AnomalyKind = "latency_spike" | "error_burst" | "throughput_drop" | "first_5xx";

export interface Anomaly {
	kind: AnomalyKind;
	/** Elapsed seconds at the first affected tick. */
	startSeconds: number;
	/** Elapsed seconds at the last affected tick; equal to the start for a point. */
	endSeconds: number;
	/**
	 * How far past normal, as a multiple: 4.2 on a latency spike is "4.2x the
	 * baseline", on an error burst "4.2x the 1% burst threshold", on a throughput
	 * drop "throughput fell to 1/4.2 of baseline". Always >= 1 for a detection,
	 * and exactly 1 for a point event, which has no scale. One comparable number
	 * across kinds is what {@link MAX_ANOMALIES} ranks by.
	 */
	magnitude: number;
	/** The finding in words, e.g. "p99 4.2x baseline for 3s". */
	label: string;
}

/**
 * Ticks of history a baseline is taken over. The median (not the mean) of the
 * trailing window, so the two ticks that open a spike cannot drag the baseline
 * up to meet themselves.
 */
export const BASELINE_TICKS = 15;

/** p99 above this multiple of baseline is a spike. */
export const LATENCY_SPIKE_FACTOR = 3;

/**
 * A spike window stays open until p99 falls back under this multiple. Lower than
 * the opening factor on purpose: a recovery that stalls at 2x baseline is still
 * the same degradation, and ending the window at 3x would report it as over.
 */
export const LATENCY_RECOVERY_FACTOR = 1.5;

/** Per-tick failures above this share of that tick's completions is a burst. */
export const ERROR_BURST_RATE = 0.01;

/** Throughput under this share of its trailing median is a drop. */
export const THROUGHPUT_DROP_FACTOR = 0.6;

/**
 * Ticks a condition must hold for. One tick is noise - a single scrape landing
 * beside a GC pause - and flagging it would fill a clean run with events.
 */
export const MIN_CONSECUTIVE_TICKS = 2;

/** Most anomalies reported; beyond this the list stops being readable. */
export const MAX_ANOMALIES = 20;

/** Seconds, at the precision a reader can act on: "3s", "0.4s". */
function formatSeconds(seconds: number): string {
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${Number(seconds.toFixed(1))}s`;
}

/* -------------------------------------------------------------------------- */
/* Per-tick storage                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Values derived once per tick and addressed by *absolute* tick index - the
 * count of ticks the detector has ever seen, which no trim renumbers. Dropping
 * the oldest is then a pointer move; the backing array is compacted only once
 * the dead prefix outweighs the live one, so it tracks what is retained rather
 * than the length of the whole run.
 */
class TickCache<T> {
	private values: T[] = [];
	private head = 0;
	private baseAbs = 0;

	push(value: T): void {
		this.values.push(value);
	}

	at(abs: number): T {
		return this.values[this.head + (abs - this.baseAbs)];
	}

	dropBefore(abs: number): void {
		const drop = abs - this.baseAbs;
		if (drop <= 0) return;
		this.head += drop;
		this.baseAbs = abs;
		if (this.head * 2 > this.values.length) {
			this.values = this.values.slice(this.head);
			this.head = 0;
		}
	}
}

/** One number read off a tick, with the same `?? 0` the from-scratch pass used. */
type Reader = (m: LoadTestMetrics) => number;

const readP99: Reader = (m) => m.latency_p99_ms ?? 0;
const readRps: Reader = (m) => m.current_rps ?? 0;
const readConcurrency: Reader = (m) => m.current_concurrency ?? 0;

/**
 * Trailing-median baselines for one series: the median of the
 * {@link BASELINE_TICKS} ticks *before* each tick, computed when that tick
 * arrives and never revisited - the values behind it cannot change.
 *
 * `null` for a tick that arrived without that much history in front of it, which
 * is what makes the opening seconds of a run (where every value is its own
 * outlier) produce nothing. A tick that *loses* its lead-in to a later trim is
 * not handled here - it keeps a baseline no rule may use any more, and
 * {@link clipRunsFront} is what stops any of them using it.
 */
function createBaselines(read: Reader) {
	const cache = new TickCache<number | null>();
	const scratch = new Array<number>(BASELINE_TICKS);

	return {
		dropBefore(abs: number): void {
			cache.dropBefore(abs);
		},

		push(history: LoadTestMetrics[], pos: number): void {
			if (pos < BASELINE_TICKS) {
				cache.push(null);
				return;
			}
			for (let k = 0; k < BASELINE_TICKS; k++) {
				scratch[k] = read(history[pos - BASELINE_TICKS + k]);
			}
			scratch.sort((a, b) => a - b);
			const mid = BASELINE_TICKS >> 1;
			cache.push(
				BASELINE_TICKS % 2 === 0 ? (scratch[mid - 1] + scratch[mid]) / 2 : scratch[mid]
			);
		},

		at(abs: number): number | null {
			return cache.at(abs);
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Runs of consecutive hot ticks                                               */
/* -------------------------------------------------------------------------- */

/**
 * A maximal run of consecutive ticks satisfying one rule, in absolute indices
 * and inclusive of both ends. Runs shorter than {@link MIN_CONSECUTIVE_TICKS}
 * are kept but never reported: they are still the run a later contiguous tick
 * extends, and dropping them would report that pair a tick late.
 */
interface Run {
	startAbs: number;
	endAbs: number;
}

function runLength(run: Run): number {
	return run.endAbs - run.startAbs + 1;
}

/**
 * Extend the trailing run to `abs`, or open a new one. Returns the run that
 * changed, so the caller can refresh whatever it caches on it.
 */
function extendOrOpen<R extends Run>(runs: R[], abs: number, open: () => R): R {
	const last = runs[runs.length - 1];
	if (last && last.endAbs === abs - 1) {
		last.endAbs = abs;
		return last;
	}
	const run = open();
	runs.push(run);
	return run;
}

/**
 * Drop runs the buffer no longer holds, and clip the first survivor to
 * `minStartAbs` - the oldest tick the rule can still speak for. Hotness only
 * ever falls away at the front, so this clips a run and can never split one.
 * Returns whether the leading run moved, which is what invalidates the caller's
 * cached window for it.
 */
function clipRunsFront(runs: Run[], minStartAbs: number): boolean {
	let expired = 0;
	while (expired < runs.length && runs[expired].endAbs < minStartAbs) expired++;
	if (expired > 0) runs.splice(0, expired);

	const first = runs[0];
	if (first && first.startAbs < minStartAbs) {
		first.startAbs = minStartAbs;
		return true;
	}
	// An expired run leaves the survivor behind it untouched, so nothing the
	// caller cached about it went stale.
	return false;
}

/**
 * The windows a rule reports, one per run long enough to count, built once and
 * kept on the run until its bounds move.
 *
 * The spike rule does not use this: its windows extend past their own hot run
 * and swallow the ones behind them, which is a fold over the runs rather than a
 * map across them. Burst and drop are maps, and were the same eight lines twice.
 */
function collectWindows<R extends Run & { window: Anomaly | null }>(
	runs: R[],
	build: (run: R) => Anomaly
): Anomaly[] {
	const out: Anomaly[] = [];
	for (const run of runs) {
		if (runLength(run) < MIN_CONSECUTIVE_TICKS) continue;
		if (!run.window) run.window = build(run);
		out.push(run.window);
	}
	return out;
}

/**
 * One rule's incremental state. `trim` and `push` are the ingest half - called
 * once per commit and once per arriving tick - and `windows` is the read half,
 * which materialises what the rule currently says about the buffer it is given.
 *
 * A rule with nothing to derive per tick omits `push` and does its reading in
 * `windows`, from a cursor it carries itself.
 */
interface RuleDetector {
	trim(firstAbs: number): void;
	push?(history: LoadTestMetrics[], firstAbs: number, pos: number): void;
	windows(history: LoadTestMetrics[], firstAbs: number): Anomaly[];
}

function elapsedAt(history: LoadTestMetrics[], firstAbs: number, abs: number): number {
	return history[abs - firstAbs].elapsed_seconds;
}

function spanOf(history: LoadTestMetrics[], firstAbs: number, from: number, to: number): string {
	return formatSeconds(elapsedAt(history, firstAbs, to) - elapsedAt(history, firstAbs, from));
}

/* -------------------------------------------------------------------------- */
/* Latency spikes                                                              */
/* -------------------------------------------------------------------------- */

interface SpikeRun extends Run {
	/**
	 * The baseline frozen at the opening tick. Recomputing it as the window
	 * extends would fold the spike's own ticks into the trailing median, so a
	 * long degradation would raise its own bar and report itself as recovered
	 * while it was still happening.
	 */
	base: number;
	/** Highest p99 over the hot ticks `[startAbs, endAbs]`. */
	hotPeak: number;
	/** Last tick of the window including its recovery tail. */
	tailAbs: number;
	/** True once a tick has ended the tail, which it then cannot re-open. */
	tailClosed: boolean;
	/** Highest p99 over the tail ticks `(endAbs, tailAbs]`. */
	tailPeak: number;
	window: Anomaly | null;
}

function createSpikeDetector(): RuleDetector {
	const baselines = createBaselines(readP99);
	const runs: SpikeRun[] = [];
	let clipped = false;

	/**
	 * Re-derive what a clipped start invalidates. The clip took hot ticks off the
	 * front, one of which may have been the peak, and moved the baseline the whole
	 * window is measured against - so the frozen base, the peak and the reach of
	 * the recovery tail are all in question.
	 *
	 * Re-walking the tail is the expensive part, and it is avoidable whenever the
	 * clip left the baseline where it was - which is the usual case, and the one
	 * that matters, since a window aging out of the buffer is clipped on every
	 * commit for as many commits as its hot span is long.
	 */
	function reseat(run: SpikeRun, history: LoadTestMetrics[], firstAbs: number): void {
		// The clipped start is the oldest tick this rule can speak for, so it
		// arrived with a full lead-in and its baseline is there.
		const base = baselines.at(run.startAbs) ?? 0;

		// The hot span is the spike itself, so this is short whatever the tail did.
		run.hotPeak = 0;
		for (let abs = run.startAbs; abs <= run.endAbs; abs++) {
			run.hotPeak = Math.max(run.hotPeak, readP99(history[abs - firstAbs]));
		}

		if (base !== run.base) {
			// The threshold the walk measured itself against has moved, so the walk
			// has to happen again. Salvaging it would mean re-justifying every tick
			// it accepted *and* the tick that ended it against the new threshold -
			// more subtlety than the saving is worth, because a clip usually does not
			// move the baseline at all: it advances the start by one tick through a
			// window whose lead-in is mostly unchanged.
			run.tailAbs = run.endAbs;
			run.tailClosed = false;
			run.tailPeak = 0;
		}

		run.base = base;
		run.window = null;
	}

	/** Walk the recovery tail forward from where the last commit left it. */
	function advanceTail(run: SpikeRun, history: LoadTestMetrics[], firstAbs: number): void {
		if (run.tailClosed) return;
		const lastAbs = firstAbs + history.length - 1;
		let end = run.tailAbs;
		while (end < lastAbs) {
			const next = readP99(history[end + 1 - firstAbs]);
			if (next <= run.base * LATENCY_RECOVERY_FACTOR) {
				run.tailClosed = true;
				break;
			}
			end++;
			run.tailPeak = Math.max(run.tailPeak, next);
		}
		if (end !== run.tailAbs) {
			run.tailAbs = end;
			run.window = null;
		}
	}

	return {
		trim(firstAbs) {
			baselines.dropBefore(firstAbs);
			clipped = clipRunsFront(runs, firstAbs + BASELINE_TICKS) || clipped;
		},

		push(history, firstAbs, pos) {
			baselines.push(history, pos);
			const abs = firstAbs + pos;
			const base = baselines.at(abs);
			const p99 = readP99(history[pos]);
			if (base == null || base <= 0 || p99 <= base * LATENCY_SPIKE_FACTOR) return;

			const run = extendOrOpen<SpikeRun>(runs, abs, () => ({
				startAbs: abs,
				endAbs: abs,
				base,
				hotPeak: p99,
				tailAbs: abs,
				tailClosed: false,
				tailPeak: 0,
				window: null,
			}));
			// A hot tick can only ever extend a run whose tail is empty: the walk
			// only covers ticks the rule already found cold, and a tick's hotness
			// never comes back. So the tail ends where the hot span does.
			run.tailAbs = run.endAbs;
			run.hotPeak = Math.max(run.hotPeak, p99);
			run.window = null;
		},

		windows(history, firstAbs) {
			if (clipped && runs.length > 0) reseat(runs[0], history, firstAbs);
			clipped = false;

			const out: Anomaly[] = [];
			let consumedThrough = -Infinity;
			for (const run of runs) {
				if (runLength(run) < MIN_CONSECUTIVE_TICKS) continue;
				// A window the previous one already swallowed during its recovery
				// extension is the same degradation, not a second one.
				if (run.startAbs <= consumedThrough) continue;
				advanceTail(run, history, firstAbs);
				consumedThrough = run.tailAbs;
				if (!run.window) {
					const magnitude = Math.max(run.hotPeak, run.tailPeak) / run.base;
					run.window = {
						kind: "latency_spike",
						startSeconds: elapsedAt(history, firstAbs, run.startAbs),
						endSeconds: elapsedAt(history, firstAbs, run.tailAbs),
						magnitude,
						label: `p99 ${magnitude.toFixed(1)}x baseline for ${spanOf(history, firstAbs, run.startAbs, run.tailAbs)}`,
					};
				}
				out.push(run.window);
			}
			return out;
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Error bursts                                                                */
/* -------------------------------------------------------------------------- */

interface BurstRun extends Run {
	/** Peak per-tick failure rate over the run. */
	peak: number;
	window: Anomaly | null;
}

function createBurstDetector(): RuleDetector {
	/*
	 * `requests_failed` and `requests_completed` are cumulative counters, so the
	 * rate that matters is the per-tick delta. Reading them undiffed would report
	 * a run that failed early and recovered as failing for the rest of its life.
	 * The delta is a property of a tick and the one before it, so it is cached;
	 * that the *first* tick in the buffer has no predecessor is a property of the
	 * buffer, so it is applied on read.
	 */
	const rates = new TickCache<number>();
	const runs: BurstRun[] = [];
	let clipped = false;

	const rateAt = (abs: number) => rates.at(abs);

	function reseat(run: BurstRun): void {
		run.peak = 0;
		for (let abs = run.startAbs; abs <= run.endAbs; abs++) {
			run.peak = Math.max(run.peak, rateAt(abs));
		}
		run.window = null;
	}

	return {
		trim(firstAbs) {
			rates.dropBefore(firstAbs);
			// The first tick of the buffer has no predecessor to diff against, so
			// it is the one position this rule cannot speak for.
			clipped = clipRunsFront(runs, firstAbs + 1) || clipped;
		},

		push(history, firstAbs, pos) {
			if (pos === 0) {
				rates.push(0);
			} else {
				const m = history[pos];
				const prev = history[pos - 1];
				const failed = Math.max(0, (m.requests_failed ?? 0) - (prev.requests_failed ?? 0));
				const completed = Math.max(0, m.requests_completed - prev.requests_completed);
				rates.push(completed > 0 ? failed / completed : 0);
			}

			const abs = firstAbs + pos;
			const rate = rateAt(abs);
			if (rate <= ERROR_BURST_RATE) return;

			const run = extendOrOpen<BurstRun>(runs, abs, () => ({
				startAbs: abs,
				endAbs: abs,
				peak: rate,
				window: null,
			}));
			run.peak = Math.max(run.peak, rate);
			run.window = null;
		},

		windows(history, firstAbs) {
			if (clipped && runs.length > 0) reseat(runs[0]);
			clipped = false;

			return collectWindows(runs, (run) => ({
				kind: "error_burst",
				startSeconds: elapsedAt(history, firstAbs, run.startAbs),
				endSeconds: elapsedAt(history, firstAbs, run.endAbs),
				magnitude: run.peak / ERROR_BURST_RATE,
				label: `errors ${(run.peak * 100).toFixed(1)}% of requests for ${spanOf(history, firstAbs, run.startAbs, run.endAbs)}`,
			}));
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Throughput drops                                                            */
/* -------------------------------------------------------------------------- */

interface DropRun extends Run {
	/** The rps baseline at the opening tick, which the share is measured against. */
	base: number;
	/** Lowest rps over the run. */
	trough: number;
	window: Anomaly | null;
}

function createDropDetector(): RuleDetector {
	const rpsBaselines = createBaselines(readRps);
	const concurrencyBaselines = createBaselines(readConcurrency);
	const runs: DropRun[] = [];
	let clipped = false;

	function reseat(run: DropRun, history: LoadTestMetrics[], firstAbs: number): void {
		// See the spike detector: a clipped start always has its baseline.
		run.base = rpsBaselines.at(run.startAbs) ?? 0;
		run.trough = Infinity;
		for (let abs = run.startAbs; abs <= run.endAbs; abs++) {
			run.trough = Math.min(run.trough, readRps(history[abs - firstAbs]));
		}
		run.window = null;
	}

	return {
		trim(firstAbs) {
			rpsBaselines.dropBefore(firstAbs);
			concurrencyBaselines.dropBefore(firstAbs);
			clipped = clipRunsFront(runs, firstAbs + BASELINE_TICKS) || clipped;
		},

		push(history, firstAbs, pos) {
			rpsBaselines.push(history, pos);
			concurrencyBaselines.push(history, pos);

			const abs = firstAbs + pos;
			const base = rpsBaselines.at(abs);
			if (base == null || base <= 0) return;
			const rps = readRps(history[pos]);
			// Concurrency held: a ramp winding down, or a stopped run, produces less
			// throughput because it was asked to. That is not a degradation.
			const heldConcurrency =
				readConcurrency(history[pos]) >= (concurrencyBaselines.at(abs) ?? 0);
			if (!heldConcurrency || rps >= base * THROUGHPUT_DROP_FACTOR) return;

			const run = extendOrOpen<DropRun>(runs, abs, () => ({
				startAbs: abs,
				endAbs: abs,
				base,
				trough: rps,
				window: null,
			}));
			run.trough = Math.min(run.trough, rps);
			run.window = null;
		},

		windows(history, firstAbs) {
			if (clipped && runs.length > 0) reseat(runs[0], history, firstAbs);
			clipped = false;

			return collectWindows(runs, (run) => {
				const share = run.trough / run.base;
				return {
					kind: "throughput_drop",
					startSeconds: elapsedAt(history, firstAbs, run.startAbs),
					endSeconds: elapsedAt(history, firstAbs, run.endAbs),
					// trough can be 0 (throughput stopped entirely) - report that as the
					// worst possible multiple rather than as Infinity.
					magnitude: share > 0 ? 1 / share : Number.MAX_SAFE_INTEGER,
					label: `throughput ${Math.round(share * 100)}% of baseline for ${spanOf(history, firstAbs, run.startAbs, run.endAbs)}`,
				};
			});
		},
	};
}

/* -------------------------------------------------------------------------- */
/* First 5xx                                                                   */
/* -------------------------------------------------------------------------- */

function first5xxCode(m: LoadTestMetrics): string | null {
	// The map is cumulative, so the tick a 5xx key first appears on with a
	// non-zero count IS the onset - no diffing needed to find the first one.
	const code = Object.entries(m.status_codes ?? {}).find(
		([status, count]) => count > 0 && Number(status) >= 500 && Number(status) < 600
	);
	return code ? code[0] : null;
}

function createFirst5xxDetector(): RuleDetector {
	/** Absolute index the status maps have been scanned up to, exclusive. */
	let scannedTo = 0;
	let foundAbs: number | null = null;
	let foundCode = "";
	let window: Anomaly | null = null;

	return {
		trim(firstAbs) {
			if (foundAbs != null && foundAbs < firstAbs) {
				// The onset rolled out of the buffer. Every tick before it was
				// scanned and clean, and those went first - so the search for the
				// next onset resumes at the new front having re-read nothing.
				foundAbs = null;
				window = null;
				scannedTo = firstAbs;
			}
			if (scannedTo < firstAbs) scannedTo = firstAbs;
		},

		windows(history, firstAbs) {
			const lastAbs = firstAbs + history.length - 1;
			// Only ever forward, and only while nothing has been found: once the
			// onset is known the rest of the run's status maps are never read.
			for (let abs = scannedTo; foundAbs == null && abs <= lastAbs; abs++) {
				scannedTo = abs + 1;
				const code = first5xxCode(history[abs - firstAbs]);
				if (code == null) continue;
				foundAbs = abs;
				foundCode = code;
				window = null;
			}

			if (foundAbs == null) return [];
			if (!window) {
				const seconds = elapsedAt(history, firstAbs, foundAbs);
				window = {
					kind: "first_5xx",
					startSeconds: seconds,
					endSeconds: seconds,
					magnitude: 1,
					label: `first ${foundCode} response`,
				};
			}
			return [window];
		},
	};
}

/* -------------------------------------------------------------------------- */
/* The detector                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How the buffer just handed over relates to the last one: how many ticks fell
 * off the front, or `null` when it is not the same buffer at all (a new run, a
 * replay, a remount) and the detector has to start over.
 *
 * The store only ever drops from the front of a time-ordered buffer, so the new
 * head sits at the first tick with its elapsed time - found by search, then
 * confirmed by object identity at both ends. Anything that does not confirm is
 * refused rather than guessed at: a wrong alignment would silently report a
 * different run's windows.
 */
function droppedFromFront(prev: LoadTestMetrics[], next: LoadTestMetrics[]): number | null {
	if (prev.length === 0 || next.length === 0) return null;

	const head = next[0].elapsed_seconds;
	let lo = 0;
	let hi = prev.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (prev[mid].elapsed_seconds < head) lo = mid + 1;
		else hi = mid - 1;
	}
	if (prev[lo] !== next[0]) return null;

	const overlap = prev.length - lo;
	if (next.length < overlap) return null;
	if (next[overlap - 1] !== prev[prev.length - 1]) return null;
	return lo;
}

/**
 * Every anomaly in the buffer, in time order - the shared tail of both entry
 * points, so the one-shot and the incremental detector cannot report differently
 * ranked or differently ordered lists.
 */
function assemble(rules: RuleDetector[], history: LoadTestMetrics[], firstAbs: number): Anomaly[] {
	const found = rules.flatMap((rule) => rule.windows(history, firstAbs));

	const byTime = (a: Anomaly, b: Anomaly) => a.startSeconds - b.startSeconds;
	if (found.length <= MAX_ANOMALIES) return found.sort(byTime);

	// Over the cap the list is triaged, not truncated: the worst survive, and the
	// last one says how many did not - a silently shortened list reads as a
	// complete one.
	const kept = [...found].sort((a, b) => b.magnitude - a.magnitude).slice(0, MAX_ANOMALIES);
	kept.sort(byTime);
	const dropped = found.length - kept.length;
	const last = kept[kept.length - 1];
	kept[kept.length - 1] = { ...last, label: `${last.label} (+${dropped} more)` };
	return kept;
}

/**
 * The rules, in the order they report. That order fixes the report's order for
 * anomalies sharing a start second, since the sort in {@link assemble} is stable.
 */
function makeRules(): RuleDetector[] {
	return [
		createSpikeDetector(),
		createBurstDetector(),
		createDropDetector(),
		createFirst5xxDetector(),
	];
}

/**
 * A detector that carries its derivation across calls, for a caller handing over
 * the same growing buffer again and again.
 *
 * `detect` answers exactly what {@link detectAnomalies} would answer for the
 * buffer it is given - including for a buffer that is not a continuation of the
 * last one, which it starts over on. It is safe to call twice with the same
 * array (React renders it twice under StrictMode): the second call is served
 * from the memo, not re-ingested.
 */
export interface AnomalyDetector {
	detect(history: LoadTestMetrics[]): Anomaly[];
}

export function createAnomalyDetector(): AnomalyDetector {
	let rules = makeRules();
	let seen: LoadTestMetrics[] = [];
	let reported: Anomaly[] = [];
	let firstAbs = 0;

	function ingest(history: LoadTestMetrics[], dropped: number, from: number): void {
		firstAbs += dropped;
		for (const rule of rules) rule.trim(firstAbs);
		for (let pos = from; pos < history.length; pos++) {
			for (const rule of rules) rule.push?.(history, firstAbs, pos);
		}
	}

	return {
		detect(history) {
			if (history === seen) return reported;

			const dropped = droppedFromFront(seen, history);
			if (dropped == null) {
				rules = makeRules();
				firstAbs = 0;
				ingest(history, 0, 0);
			} else {
				ingest(history, dropped, seen.length - dropped);
			}

			seen = history;
			// A series too short to say anything about is the same answer as a clean
			// run, for the same reason: nothing here is established enough to be
			// abnormal. Applied after ingest so the state stays in step with the
			// buffer either way.
			reported = history.length < 2 ? [] : assemble(rules, history, firstAbs);
			return reported;
		},
	};
}

/**
 * Every anomaly in a run's per-tick series, in time order.
 *
 * Returns `[]` for a clean run - and for a run too short to have a baseline,
 * which is the same answer for the same reason: nothing here is established
 * enough to be abnormal.
 *
 * This is the one-shot form, for a series that arrives whole. A caller handing
 * the same buffer over on a timer wants {@link createAnomalyDetector}.
 */
export function detectAnomalies(history: LoadTestMetrics[]): Anomaly[] {
	return createAnomalyDetector().detect(history);
}
