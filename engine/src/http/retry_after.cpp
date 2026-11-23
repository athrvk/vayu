/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/retry_after.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <ctime>
#include <limits>
#include <string>

#include "vayu/http/header_names.hpp"
#include "vayu/utils/parse.hpp"

namespace vayu::http {

std::optional<int64_t> retry_after_delay_ms (std::string_view value,
std::chrono::system_clock::time_point now) {
    value = trim_optional_whitespace (value);
    if (value.empty ()) {
        return std::nullopt;
    }

    constexpr int64_t MAX_SECONDS = std::numeric_limits<int64_t>::max () / 1000;
    if (std::ranges::all_of (value, [] (char c) { return c >= '0' && c <= '9'; })) {
        const auto seconds = vayu::utils::parse_number<int64_t> (value);
        return std::min (seconds.value_or (MAX_SECONDS), MAX_SECONDS) * 1000;
    }

    const std::string text (value);
    const time_t date = curl_getdate (text.c_str (), nullptr);
    if (date == -1) {
        return std::nullopt;
    }
    const int64_t now_ms =
    std::chrono::duration_cast<std::chrono::milliseconds> (now.time_since_epoch ())
    .count ();
    return std::max<int64_t> (0, (static_cast<int64_t> (date) * 1000) - now_ms);
}

} // namespace vayu::http
