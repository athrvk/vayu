/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Per-phase explanations for the network timing breakdown (DNS -> Connect -> TLS -> TTFB ->
 * Download), one string per phase for every renderer of those numbers, as `formatPhaseDuration` is
 * for the numbers.
 */
export const PHASE_TIPS = {
	dns: "Hostname → IP resolution. Usually a few ms once cached; >50ms suggests slow DNS or a fresh lookup.",
	connect: "TCP three-way handshake. Zero on connection reuse (HTTP keep-alive / HTTP/2).",
	tls: "SSL/TLS handshake (HTTPS only). Zero for plain HTTP and on resumed connections.",
	ttfb: "Time to first byte - server processing + propagation. If this dominates, the bottleneck is the server, not the network.",
	download:
		"Response body transfer time. Large for big payloads or slow links; near-zero for small JSON.",
} as const;
