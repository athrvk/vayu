/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The reconnect backoff every hand-reconnected `EventSource` uses: the inbox
 * capture stream, a streaming send's events, and the change feed. Each one
 * reconnects on its own because an `EventSource` treats a non-200 as fatal;
 * what differs between them is only where the ladder starts and where it
 * stops, which each states beside the reason for its numbers.
 */

/**
 * How much of each step is added at random on top of it, at most. Half a step
 * spreads several streams that lost the engine together far enough apart that
 * they do not retry in lockstep, while keeping each delay above its step.
 */
export const STREAM_RETRY_JITTER = 0.5;

export interface StreamBackoff {
	/** The first step; each attempt doubles it. */
	baseMs: number;
	/** The step stops doubling here. Jitter still adds on top of it. */
	maxMs: number;
	/** Fraction of the step added at random; {@link STREAM_RETRY_JITTER} unless stated. */
	jitter?: number;
}

/** How long to wait before reconnect attempt @p attempt (1-based). */
export function streamRetryDelayMs(
	attempt: number,
	{ baseMs, maxMs, jitter = STREAM_RETRY_JITTER }: StreamBackoff,
	random: () => number = Math.random
): number {
	const step = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
	return Math.round(step + random() * step * jitter);
}
