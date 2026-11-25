#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The log record for the end of one send a person or a script made
 *        (#3677): a design Send (`cat: "http"`) and a `pm.sendRequest` call
 *        (`cat: "script"`).
 *
 * The request line (`request_log.hpp`) records the call into the engine, and
 * the Console records what the app sent; without this record, a send the engine
 * made on its own behalf that fails - a token endpoint refusing the connection,
 * a Send whose host does not resolve - would leave nothing in the log files.
 * This is the one place the record's shape and level are decided; each caller
 * supplies the category as a literal, as `tests/log_category_scan_test.cpp`
 * requires, and logs what this builds.
 */

#include <cmath>
#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

#include "vayu/types.hpp"
#include "vayu/utils/log_text.hpp"

namespace vayu::http {

/// How a send ended, in the terms both callers can state.
struct SendOutcome {
    /// Fixed text that opens `msg` (`"Send"`, `"pm.sendRequest"`), never
    /// anything a request or a script chose.
    std::string_view subject;
    std::string_view method;
    /// The URL as the caller holds it; the logger strips its credentials, query
    /// and fragment because the field is named `url`.
    std::string_view url;
    /// The answer's status, 0 when none came back.
    int status_code      = 0;
    double elapsed_ms    = 0.0;
    ErrorCode error_code = ErrorCode::None;
    /// The transport's own words (a curl message), which a script or a server
    /// can influence, so it is a bounded field and never part of `msg`.
    std::string_view error_message;
    /// Set only where a run row names the send; a transient Send and a script
    /// request have none, and the field is then absent.
    std::optional<std::string_view> run_id;
};

/// A record ready for `log_warning` or `log_debug` under the caller's category.
struct SendOutcomeRecord {
    /// A send that ended in an error. A cancelled one is not: the person or
    /// the server stopping it is not the send failing, so it is a debug line.
    bool failed = false;
    std::string msg;
    nlohmann::json fields = nlohmann::json::object ();
};

[[nodiscard]] inline SendOutcomeRecord describe_send_outcome (const SendOutcome& outcome) {
    const bool cancelled = outcome.error_code == ErrorCode::Cancelled;
    SendOutcomeRecord record;
    record.failed = outcome.error_code != ErrorCode::None && !cancelled;

    std::string_view verb = "completed";
    if (record.failed) {
        verb = "failed";
    } else if (cancelled) {
        verb = "cancelled";
    }
    record.msg = std::string (outcome.subject) + " " + std::string (verb);

    auto& fields     = record.fields;
    fields["method"] = outcome.method;
    fields["url"]    = outcome.url;
    fields["ms"]     = std::round (outcome.elapsed_ms * 10.0) / 10.0;
    if (outcome.status_code > 0) {
        fields["status"] = outcome.status_code;
    }
    if (outcome.error_code != ErrorCode::None) {
        fields["errorCode"] = to_string (outcome.error_code);
    }
    if (!outcome.error_message.empty ()) {
        fields["error"] = vayu::utils::bounded_log_text (outcome.error_message);
    }
    if (outcome.run_id) {
        fields["runId"] = *outcome.run_id;
    }
    return record;
}

} // namespace vayu::http
