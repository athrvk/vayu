#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The wait a `Retry-After` header value asks for (RFC 9110 section
 *        10.2.3), read by a load run's back-off (#3782).
 *
 * The value is delta-seconds (`1*DIGIT`) or an HTTP-date. The date goes to
 * libcurl's `curl_getdate`, which reads all three forms RFC 9110 says a
 * recipient must (IMF-fixdate, RFC 850, asctime) and refuses text without a
 * day, a month and a year. Anything else, a negative number included, asks
 * for no wait: guessing one for a malformed header would change what the run
 * measures on the strength of the server's mistake.
 *
 * Declared without `curl/curl.h`, for the reason `client.hpp` gives.
 */

#include <chrono>
#include <cstdint>
#include <optional>
#include <string_view>

namespace vayu::http {

/**
 * @brief Milliseconds from @p now until @p value says to retry, or nothing
 *        when it says nothing usable.
 *
 * A date at or before @p now is 0: the moment it named has passed. A
 * delta-seconds too large for the arithmetic saturates rather than being
 * refused, since it is a well-formed "wait a very long time" that the caller's
 * cap clamps. A value is refused by returning nothing, never by throwing:
 * this runs on an event-loop worker.
 */
[[nodiscard]] std::optional<int64_t> retry_after_delay_ms (std::string_view value,
std::chrono::system_clock::time_point now);

} // namespace vayu::http
