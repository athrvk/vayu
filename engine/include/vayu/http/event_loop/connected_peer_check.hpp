#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <optional>
#include <string>

#include "vayu/http/loopback_guard.hpp"

namespace vayu::http::detail {

/**
 * @brief The host and port a URL dials.
 */
struct UrlAuthority {
    /// Hostname, or the address of an IP-literal URL with its brackets removed.
    /// Empty when the URL names no authority. A non-ASCII name is in its
    /// punycode form, the one the transfer dials (`ascii_host`).
    std::string host;
    /// Explicit port, or the scheme default when the URL names none.
    int port = 0;
    /// True when `host` is an address rather than a name, so there is nothing
    /// to resolve and nothing to pin.
    bool is_ip_literal = false;
};

/**
 * @brief One transfer's connect-time state beyond the process-wide reserved
 *        ports: what `apply_transport_policy` hands libcurl as
 *        `CURLOPT_PREREQDATA`, so it must outlive the transfer.
 *
 * The single-request client builds one per send, and the event loop keeps one
 * on every `TransferData`; the SSE consumer passes none. Only a
 * `/import/fetch` reference sets `local_peers` (#2364).
 */
struct ConnectedPeerCheck {
    /// The rule a reference fetch runs under, or null for none.
    const LocalPeerRule* local_peers = nullptr;
    /// The proxy the transfer names (`configured_proxy`), written by
    /// `apply_transport_policy`. `local_peers` does not refuse it (#2605).
    std::optional<UrlAuthority> proxy;
    /// Set by the callback when `local_peers` refused the connection, so
    /// `curl_to_error` can name that rule rather than libcurl's abort.
    bool refused_local_peer = false;
    /// How many times libcurl was about to write this transfer's request on a
    /// connection: once, plus once per redirect hop or auth reload
    /// (`CURLINFO_REDIRECT_COUNT`), plus once per request libcurl re-sent on a
    /// new connection after a reused one was dropped or refused before
    /// answering (#2799), which nothing else records. `connection_replays`
    /// reads it back. A plain int: a transfer's callbacks run on one thread.
    int requests_started = 0;
};

} // namespace vayu::http::detail
