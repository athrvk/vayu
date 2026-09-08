/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "seed.hpp"

#include "vayu/core/constants.hpp"

#include <string>

namespace vayu::db::config_seeds {

// =============================================================================
// SERVICES (services)
// The long-lived surfaces: streaming requests, the webhook inboxes and mock
// servers the Dock calls Services, and the OAuth issuers behind them. Before
// #586 these were filed under Observability, which is the drawer's word for
// none of them - a user managing a service found no matching word in the
// tree.
// =============================================================================
void seed_services (ConfigSeeder& seed, int64_t now) {
    // SSE requests (issue #573). All six - these five and `sseMaxStoredEvents`,
    // which #703 moved to Data & retention as the per-run storage budget it is -
    // are read once when a stream starts, so a change applies to the next
    // stream - no restart - and one run's events are all bounded by a single
    // rule rather than by whatever the setting happened to be at each arrival.
    seed (keywords ({ "eventsource", "server-sent", "event stream" }) (ConfigEntry{ "sseMaxRetainedEvents",
    std::to_string (vayu::core::constants::sse::MAX_RETAINED_EVENTS), "integer", "Stream Events Retained",
    "How many of a streaming request's events are held in memory for the "
    "Events "
    "timeline. Older ones are dropped as new ones arrive, so this is how far "
    "back a long stream can be scrolled while it is running; the completed run "
    "stores its own, separate list. Each event costs roughly its own size in "
    "memory.",
    "services", std::to_string (vayu::core::constants::sse::MAX_RETAINED_EVENTS),
    std::to_string (vayu::core::constants::sse::MIN_RETAINED_EVENTS),
    std::to_string (vayu::core::constants::sse::RETAINED_EVENTS_CEILING),
    std::nullopt, now }));

    seed (unit ("bytes") (
    keywords ({ "eventsource", "server-sent", "event stream" }) (ConfigEntry{ "sseMaxEventBytes",
    std::to_string (vayu::core::constants::sse::MAX_EVENT_BYTES), "integer", "Stream Event Size Limit",
    "How much of a single streamed event is kept. A larger event is held as a "
    "prefix and flagged as truncated, never silently cut - the event reports "
    "the size as received either way. This is also what bounds the parser "
    "itself, so a server that sends without a line break cannot exhaust "
    "memory.",
    "services", std::to_string (vayu::core::constants::sse::MAX_EVENT_BYTES),
    std::to_string (vayu::core::constants::sse::MIN_EVENT_BYTES),
    std::to_string (vayu::core::constants::sse::EVENT_BYTES_CEILING), std::nullopt, now })));

    seed (unit ("ms") (keywords ({ "eventsource", "server-sent", "event stream" }) (
    ConfigEntry{ "sseMaxStreamDurationMs",
    std::to_string (vayu::core::constants::sse::MAX_STREAM_DURATION_MS), "integer", "Stream Duration Limit",
    "How long a streaming request may run before the engine ends it and says "
    "so. A stream has no content length and no promise to end, so this is the "
    "backstop that keeps one from holding a worker forever. A request may ask "
    "for a shorter limit of its own.",
    "services", std::to_string (vayu::core::constants::sse::MAX_STREAM_DURATION_MS),
    std::to_string (vayu::core::constants::sse::MIN_STREAM_DURATION_MS),
    std::to_string (vayu::core::constants::sse::STREAM_DURATION_MS_CEILING),
    std::nullopt, now })));

    seed (keywords ({ "eventsource", "server-sent", "event stream" }) (ConfigEntry{ "sseMaxStreamEvents",
    std::to_string (vayu::core::constants::sse::MAX_STREAM_EVENTS), "integer", "Stream Event Limit",
    "How many events a streaming request may receive before the engine ends it "
    "and says so. The count backstop beside the time one, for a stream that "
    "talks fast rather than long. A request may ask for a lower limit of its "
    "own.",
    "services", std::to_string (vayu::core::constants::sse::MAX_STREAM_EVENTS),
    std::to_string (vayu::core::constants::sse::MIN_STREAM_EVENTS),
    std::to_string (vayu::core::constants::sse::STREAM_EVENTS_CEILING), std::nullopt, now }));

    seed (advanced (unit ("ms") (
    keywords ({ "eventsource", "server-sent", "event stream" }) (ConfigEntry{ "sseIdleTimeoutMs",
    std::to_string (vayu::core::constants::sse::IDLE_TIMEOUT_MS), "integer", "Stream Idle Timeout",
    "How long a stream may deliver nothing before the engine ends it. This is "
    "the one deadline a stream gets - a whole-transfer timeout would kill a "
    "healthy stream mid-flight - so it must be longer than the quietest gap "
    "the endpoint you are watching leaves between events. Enforced at whole-"
    "second resolution.",
    "services", std::to_string (vayu::core::constants::sse::IDLE_TIMEOUT_MS),
    std::to_string (vayu::core::constants::sse::MIN_IDLE_TIMEOUT_MS),
    std::to_string (vayu::core::constants::sse::IDLE_TIMEOUT_MS_CEILING), std::nullopt, now }))));

    // Webhook inbox. All three are read once when an inbox starts, so a change
    // applies to the next inbox started - no restart. The running listener keeps
    // what it was started with, which is what makes one inbox's captures a set
    // truncated and retained by a single rule rather than by whatever the
    // setting happened to be at each arrival.
    seed (unit ("bytes") (ConfigEntry{ "inboxMaxBodyBytes",
    std::to_string (vayu::core::constants::inbox::MAX_BODY_BYTES), "integer", "Inbox Capture Body Limit",
    "How much of an inbound webhook body an inbox stores. A larger "
    "payload is kept as a prefix and flagged as truncated, never silently cut "
    "- "
    "the capture reports the size as received either way. Raise it for a "
    "provider that posts large documents; the transport still refuses anything "
    "over 8 MB outright, which is not a webhook.",
    "services", std::to_string (vayu::core::constants::inbox::MAX_BODY_BYTES),
    std::to_string (vayu::core::constants::inbox::MIN_BODY_BYTES),
    std::to_string (vayu::core::constants::inbox::MAX_PAYLOAD_BYTES), std::nullopt, now }));

    seed (ConfigEntry{ "inboxMaxCaptures",
    std::to_string (vayu::core::constants::inbox::MAX_CAPTURES), "integer", "Inbox Captures Retained",
    "How many requests one inbox keeps before the oldest are dropped. Also the "
    "most a single page of the capture list may ask for. Raise it to keep a "
    "long webhook session whole; every capture is a stored row, so this and "
    "the body limit above together bound what an inbox costs on disk.",
    "services", std::to_string (vayu::core::constants::inbox::MAX_CAPTURES),
    std::to_string (vayu::core::constants::inbox::MIN_CAPTURES),
    std::to_string (vayu::core::constants::inbox::CAPTURES_CEILING), std::nullopt, now });

    seed (advanced (unit ("ms") (ConfigEntry{ "inboxLivePollIntervalMs",
    std::to_string (vayu::core::constants::inbox::LIVE_POLL_INTERVAL_MS), "integer", "Inbox Live Poll Interval",
    "How often a watched inbox checks for newly arrived "
    "captures. This is the delay between a webhook landing and its row "
    "appearing. Lower costs a few more wakeups per second on the one thread "
    "holding that stream and nothing on the capture path itself.",
    "services", std::to_string (vayu::core::constants::inbox::LIVE_POLL_INTERVAL_MS),
    std::to_string (vayu::core::constants::inbox::MIN_LIVE_POLL_INTERVAL_MS),
    std::to_string (vayu::core::constants::inbox::MAX_LIVE_POLL_INTERVAL_MS),
    std::nullopt, now })));

    // Mid-run OAuth 2.0 refresh. A load run renews a header-placed access token
    // before it expires, so a run longer than its token does not turn into a
    // 401 storm. All five are read once when the run arms its watchdog, so a
    // change applies to the next run started - no restart. They sat in Network
    // & connectivity until #703, where they were five of its eight entries; a
    // user tuning token renewal arrives at Services, which is where the Dock
    // files the OAuth issuer itself.
    seed (unit ("ms") (ConfigEntry{ "oauth2RefreshLeadMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_LEAD_MS),
    "integer", "OAuth 2.0 Refresh Lead Time",
    "How far ahead of an access token's expiry a running load "
    "test renews it. Wider than the 45-second skew the token cache already "
    "applies, so the new credential is published while the old one is still "
    "accepted and no request falls in the gap. Raise it for a provider that is "
    "slow to issue tokens.",
    "services", std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_LEAD_MS),
    "1000",    // 1 second
    "3600000", // 1 hour
    std::nullopt, now }));

    seed (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshMinIntervalMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS),
    "integer", "Min OAuth 2.0 Refresh Interval",
    "Floor on the wait between two mid-run renewals. A token "
    "whose whole lifetime is shorter than the lead time above is always inside "
    "its refresh window, so without this floor a run would re-acquire in a "
    "tight "
    "loop and hammer the token endpoint. Lower it only for a provider that "
    "issues very short-lived tokens.",
    "services", std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS),
    "100",     // 0.1 second - a floor, never 0: that is the tight loop
    "3600000", // 1 hour
    std::nullopt, now })));

    seed (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshRetryMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MS), "integer", "OAuth 2.0 Refresh Retry Delay",
    "First wait after a mid-run renewal is refused, doubled "
    "per consecutive failure up to the ceiling below. The run keeps sending "
    "the "
    "credential it already has - a failed renewal is reported in the run's "
    "report, never fatal - so this is about recovering from a token endpoint "
    "that blipped.",
    "services", std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MS),
    "250", "600000", std::nullopt, now })));

    seed (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshRetryMaxMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MAX_MS),
    "integer", "Max OAuth 2.0 Refresh Retry Delay",
    "Ceiling on that backoff, so a token endpoint that is "
    "down for an hour costs the run a bounded number of attempts rather than "
    "one every few seconds.",
    "services", std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MAX_MS),
    "1000", "3600000", std::nullopt, now })));

    seed (advanced (unit ("ms") (ConfigEntry{ "oauth2RefreshPollIntervalMs",
    std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS),
    "integer", "OAuth 2.0 Refresh Poll Interval",
    "How often the renewal watchdog wakes while it waits, to "
    "notice that the run has ended. A finished run joins that thread before it "
    "writes its report, so this bounds how long the run's last moments take. "
    "Lower costs a few more wakeups per second on one sleeping thread and "
    "nothing on the request path.",
    "services", std::to_string (vayu::core::constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS),
    "10",   // 10ms - below this the wakeups outweigh what they save
    "5000", // 5s - past this a finished run visibly waits on the join
    std::nullopt, now })));
}

} // namespace vayu::db::config_seeds
