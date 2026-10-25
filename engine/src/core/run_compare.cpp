/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/run_compare.cpp
 * @brief `compareReports` (`app/src/lib/run-compare.ts`) in C++, for the
 *        run-report export's comparison block (#2127).
 *
 * Every reading rule is the app's, JavaScript semantics included: a value is
 * a number only when finite, a string only when non-empty, a flag only when
 * `true`; a number is spelled as `String(number)` spells it. A figure the
 * report flags as unrecorded reads as absent (`recorded_number_node`).
 */

#include "vayu/core/run_compare.hpp"

#include "js_json.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/parse.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <format>
#include <initializer_list>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using json    = nlohmann::json;
using ordered = nlohmann::ordered_json;
using Path    = std::initializer_list<std::string_view>;
using Text    = std::optional<std::string>;

/// Past this ratio between two measured durations, the runs are different
/// experiments.
constexpr double DURATION_RATIO_LIMIT = 2;

const json* walk (const json& report, Path path) {
    const json* at = &report;
    for (const std::string_view key : path) {
        if (!at->is_object ()) {
            return nullptr;
        }
        const auto found = at->find (key);
        if (found == at->end ()) {
            return nullptr;
        }
        at = &*found;
    }
    return at;
}

/// The finite number at @p path, as the report spells it.
const json* number_node (const json& report, Path path) {
    const json* value = walk (report, path);
    return value != nullptr && value->is_number () &&
    std::isfinite (value->get<double> ()) ?
    value :
    nullptr;
}

std::optional<double> number_at (const json& report, Path path) {
    const json* value = number_node (report, path);
    return value == nullptr ? std::nullopt : std::optional (value->get<double> ());
}

Text text_at (const json& report, Path path) {
    const json* value = walk (report, path);
    if (value == nullptr || !value->is_string () ||
    value->get_ref<const std::string&> ().empty ()) {
        return std::nullopt;
    }
    return value->get<std::string> ();
}

bool flag_at (const json& report, Path path) {
    const json* value = walk (report, path);
    return value != nullptr && value->is_boolean () && value->get<bool> ();
}

std::optional<double> config_number (const json& report, std::string_view key) {
    return number_at (report, { "metadata", "configuration", key });
}

Text config_text (const json& report, std::string_view key) {
    return text_at (report, { "metadata", "configuration", key });
}

std::string number_text (double value) {
    return js::js_number_text (js::json (value));
}

/// `String(Number(seconds.toFixed(1)))` for a positive @p seconds. `toFixed`
/// rounds an exact half away from zero where `std::format` may round it to
/// even, and a tenth's exact half is a double only at an odd multiple of 0.25.
std::string one_decimal (double seconds) {
    const double quarters = seconds * 4;
    if (std::trunc (quarters) == quarters && std::fmod (quarters, 2.0) != 0) {
        return number_text (std::ceil (seconds * 10) / 10);
    }
    std::string fixed = std::format ("{:.1f}", seconds);
    fixed.erase (fixed.find ('.'), 1);
    const auto tenths = vayu::utils::parse_number<int64_t> (fixed);
    return number_text (tenths ? static_cast<double> (*tenths) / 10 : seconds);
}

// --- differences ---------------------------------------------------------------

struct Difference {
    std::string_view field;
    std::string base;
    std::string target;
};

using Rule = std::optional<Difference> (*) (const json& base, const json& target);

/// A difference only when both runs recorded a value: a report without the
/// field says nothing about it.
std::optional<Difference> differ (std::string_view field,
const Text& base,
const Text& target,
std::string (*show) (const std::string&) = nullptr) {
    if (!base || !target || *base == *target) {
        return std::nullopt;
    }
    if (show == nullptr) {
        return Difference{ field, *base, *target };
    }
    return Difference{ field, show (*base), show (*target) };
}

Text run_type (const json& report) {
    return text_at (report, { "metadata", "runType" });
}

/// The run type as the app names it in History.
std::string run_type_label (const std::string& type) {
    if (type == "design") {
        return "Send";
    }
    if (type == "load") {
        return "Load test";
    }
    if (type == "scenario") {
        return "Collection run";
    }
    return type;
}

constexpr std::string_view NOT_RECORDED = "not recorded";

/// `differ` for a field of the run's configuration (#2438). `metadata.runType`
/// marks a report from an engine that records each field a run was given, so
/// once both reports carry it, a field only one recorded is one the other run
/// was not given: a real difference, not an older engine's silence.
std::optional<Difference> config_differ (std::string_view field,
const json& base,
const json& target,
Text (*read) (const json&)) {
    const Text b = read (base);
    const Text t = read (target);
    if (b.has_value () != t.has_value () && run_type (base) && run_type (target)) {
        const std::string missing (NOT_RECORDED);
        return Difference{ field, b.value_or (missing), t.value_or (missing) };
    }
    return differ (field, b, t);
}

std::string capitalized (const std::string& word) {
    std::string out = word;
    if (!out.empty ()) {
        out.front () = vayu::utils::ascii_upper (out.front ());
    }
    return out;
}

/// The concurrency, and for a ramp its start level and ramp time too.
Text virtual_users (const json& report) {
    const auto peak = config_number (report, "concurrency");
    if (!peak) {
        return std::nullopt;
    }
    if (config_text (report, "mode") != "ramp_up") {
        return number_text (*peak);
    }
    const auto start = config_number (report, "startConcurrency");
    const Text ramp  = config_text (report, "rampUpDuration");
    return (start ? number_text (*start) + " to " : "") + number_text (*peak) +
    (ramp ? ", ramp " + *ramp : "");
}

Text test_mode (const json& report) {
    return config_text (report, "mode");
}

Text target_rps (const json& report) {
    const auto rps = config_number (report, "targetRps");
    return rps ? Text (number_text (*rps) + " rps") : std::nullopt;
}

/// `auto` negotiates whatever the server offers, so it differs from nothing.
Text pinned_http_version (const json& report) {
    Text version = config_text (report, "httpVersion");
    return version == "auto" ? std::nullopt : version;
}

std::string duration_label (const json& report, double seconds) {
    const Text status = text_at (report, { "metadata", "status" });
    std::string label = one_decimal (seconds) + " s";
    if (status && (*status == "stopped" || *status == "failed")) {
        label += ", " + *status;
    }
    return label;
}

std::optional<Difference> duration_difference (const json& base, const json& target) {
    const auto b = number_at (base, { "summary", "testDuration" });
    const auto t = number_at (target, { "summary", "testDuration" });
    if (!b || !t || *b <= 0 || *t <= 0) {
        return std::nullopt;
    }
    if (std::max (*b, *t) / std::min (*b, *t) <= DURATION_RATIO_LIMIT) {
        return std::nullopt;
    }
    return Difference{ "duration", duration_label (base, *b), duration_label (target, *t) };
}

bool data_file_cast (const json& report) {
    return flag_at (report, { "metadata", "configuration", "dataFileCastNumbers" });
}

Text data_file_label (const json& report) {
    const Text hash = config_text (report, "dataFileHash");
    if (!hash) {
        return std::nullopt;
    }
    const Text name = config_text (report, "dataFileName");
    const std::string label =
    name ? *name + " (" + hash->substr (0, 8) + ")" : hash->substr (0, 8);
    return data_file_cast (report) ? label + ", numbers read as numbers" : label;
}

/// Unlike the other fields, no file against a file is a real difference. The
/// hash is of the file's bytes, so one file read with and without its numbers
/// cast (#2540) differs too.
std::optional<Difference> data_file_difference (const json& base, const json& target) {
    const Text hash = config_text (base, "dataFileHash");
    if (hash == config_text (target, "dataFileHash") &&
    (!hash || data_file_cast (base) == data_file_cast (target))) {
        return std::nullopt;
    }
    return Difference{ "data_file", data_file_label (base).value_or ("none"),
        data_file_label (target).value_or ("none") };
}

bool is_scheme (std::string_view text) {
    const auto alpha = [] (char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    };
    const auto scheme_char = [&alpha] (char c) {
        return alpha (c) || (c >= '0' && c <= '9') || c == '+' || c == '.' || c == '-';
    };
    return !text.empty () && alpha (text.front ()) && std::ranges::all_of (text, scheme_char);
}

/// The request URL with its query, fragment and userinfo dropped: a
/// difference is shown verbatim, and a credential must never ride in it.
Text request_url (const json& report) {
    const Text url = text_at (report, { "metadata", "requestUrl" });
    if (!url) {
        return std::nullopt;
    }
    std::string out       = url->substr (0, url->find_first_of ("?#"));
    const auto scheme_end = out.find ("://");
    if (scheme_end == std::string::npos ||
    !is_scheme (std::string_view (out).substr (0, scheme_end))) {
        return out;
    }
    const auto authority = scheme_end + 3;
    const auto at        = std::string_view (out)
                    .substr (authority, out.find ('/', authority) - authority)
                    .rfind ('@');
    if (at != std::string_view::npos) {
        out.erase (authority, at + 1);
    }
    return out;
}

Text request_method (const json& report) {
    return text_at (report, { "metadata", "requestMethod" });
}

std::string request_label (const json& report) {
    const Text method = request_method (report);
    const Text url    = request_url (report);
    if (method && url) {
        return *method + " " + *url;
    }
    return method.value_or (url.value_or (""));
}

std::optional<Difference> request_difference (const json& base, const json& target) {
    const auto differs = [&base, &target] (Text (*read) (const json&)) {
        const Text b = read (base);
        const Text t = read (target);
        return b && t && *b != *t;
    };
    if (!differs (request_method) && !differs (request_url)) {
        return std::nullopt;
    }
    return Difference{ "request", request_label (base), request_label (target) };
}

std::optional<Difference> compression_difference (const json& base, const json& target) {
    const bool b = flag_at (base, { "metadata", "configuration", "acceptEncoding" });
    const bool t = flag_at (target, { "metadata", "configuration", "acceptEncoding" });
    if (b == t) {
        return std::nullopt;
    }
    const auto show = [] (bool negotiated) {
        return std::string (negotiated ? "negotiated" : "not negotiated");
    };
    return Difference{ "compression", show (b), show (t) };
}

std::optional<Difference> expect_continue_difference (const json& base, const json& target) {
    const bool b = flag_at (base, { "metadata", "configuration", "expectContinue" });
    const bool t = flag_at (target, { "metadata", "configuration", "expectContinue" });
    if (b == t) {
        return std::nullopt;
    }
    const auto show = [] (bool allowed) {
        return std::string (allowed ? "allowed" : "not allowed");
    };
    return Difference{ "expect_continue", show (b), show (t) };
}

/// In `compareReports`' `comparability` order. A collection's load run is
/// `load` too, so it compares with a single request's without a `run_type`.
constexpr std::array<Rule, 11> DIFFERENCE_RULES = { {
[] (const json& b, const json& t) {
    return differ ("run_type", run_type (b), run_type (t), run_type_label);
},
[] (const json& b, const json& t) {
    return config_differ ("mode", b, t, test_mode);
},
[] (const json& b, const json& t) {
    return config_differ ("concurrency", b, t, virtual_users);
},
[] (const json& b, const json& t) {
    return config_differ ("target_rps", b, t, target_rps);
},
duration_difference,
[] (const json& b, const json& t) {
    return differ ("status", text_at (b, { "metadata", "status" }),
    text_at (t, { "metadata", "status" }), capitalized);
},
[] (const json& b, const json& t) {
    return differ ("http_version", pinned_http_version (b), pinned_http_version (t));
},
data_file_difference,
request_difference,
compression_difference,
expect_continue_difference,
} };

ordered differences (const json& base, const json& target) {
    ordered out = ordered::array ();
    for (const Rule rule : DIFFERENCE_RULES) {
        if (const auto difference = rule (base, target)) {
            out.push_back ({ { "field", difference->field },
            { "base", difference->base }, { "target", difference->target } });
        }
    }
    return out;
}

// --- deltas --------------------------------------------------------------------

/// The metric's figure, or null where the report says the engine did not
/// record it (#2904): `summary.summaryMissing` unrecords the counts and the
/// latency block, `summary.partial` the latency block alone. Judged per
/// report, so one unrecorded run nulls only its own side.
const json* recorded_number_node (const json& report, const ComparedMetric& metric) {
    const bool summary_missing = flag_at (report, { "summary", "summaryMissing" });
    const bool unrecorded = metric.section == "latency" ?
    summary_missing || flag_at (report, { "summary", "partial" }) :
    summary_missing;
    return unrecorded ? nullptr : number_node (report, { metric.section, metric.key });
}

ordered metric_delta (const ComparedMetric& metric, const json& base, const json& target) {
    const json* b = recorded_number_node (base, metric);
    const json* t = recorded_number_node (target, metric);
    ordered delta = nullptr;
    ordered pct   = nullptr;
    if (b != nullptr && t != nullptr) {
        const double from = b->get<double> ();
        const double d    = t->get<double> () - from;
        delta             = d;
        if (from != 0) {
            pct = (d / from) * 100;
        }
    }
    ordered out = ordered::object ();
    out["metric"] = std::string (metric.section) + "." + std::string (metric.key);
    out["base"]      = b == nullptr ? ordered () : ordered (*b);
    out["target"]    = t == nullptr ? ordered () : ordered (*t);
    out["delta"]     = std::move (delta);
    out["pctChange"] = std::move (pct);
    out["direction"] = metric.direction;
    return out;
}

// --- status codes ----------------------------------------------------------------

/// A status-code mix as `(code, count)` pairs from either wire shape: the
/// report's `[[code, count], ...]` or an object. A pair that is not a pair
/// names no code and is dropped.
std::vector<std::pair<std::string, const json*>> status_code_entries (const json& codes) {
    std::vector<std::pair<std::string, const json*>> entries;
    if (codes.is_array ()) {
        for (const json& entry : codes) {
            if (entry.is_array () && entry.size () >= 2) {
                entries.emplace_back (js::js_string_of (js::json (entry[0])), &entry[1]);
            }
        }
    } else if (codes.is_object ()) {
        for (const auto& [code, count] : codes.items ()) {
            entries.emplace_back (code, &count);
        }
    }
    return entries;
}

void collect_codes (const json& report, const char* side, json& merged) {
    const json* codes = walk (report, { "statusCodes" });
    if (codes == nullptr) {
        return;
    }
    for (const auto& [code, count] : status_code_entries (*codes)) {
        json& slot = merged[code];
        if (slot.is_null ()) {
            slot = { { "base", 0 }, { "target", 0 } };
        }
        if (count->is_number ()) {
            slot[side] = *count;
        }
    }
}

} // namespace

nlohmann::ordered_json
compare_run_reports (const nlohmann::json& base, const nlohmann::json& target) {
    ordered deltas = ordered::array ();
    for (const ComparedMetric& metric : COMPARED_METRICS) {
        deltas.push_back (metric_delta (metric, base, target));
    }
    json codes = json::object ();
    collect_codes (base, "base", codes);
    collect_codes (target, "target", codes);

    ordered out        = ordered::object ();
    out["differences"] = differences (base, target);
    out["deltas"]      = std::move (deltas);
    out["statusCodes"] = ordered (codes);
    return out;
}

} // namespace vayu::core
