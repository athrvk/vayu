#pragma once

/**
 * @file import_parse_fixture.hpp
 * @brief The helpers shared by more than one `import_parse*_test.cpp`.
 *
 * The suites keep their names across those files (a plain `TEST` suite may span files), so
 * `--gtest_filter` and the ctest regexes see them whole.
 */

#include <gtest/gtest.h>

#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/import_document.hpp"
#include "vayu/utils/diagnostics.hpp"

namespace vayu::tests::import_parse {

using nlohmann::json;
using vayu::core::ImportOptions;
using vayu::core::ImportParse;
using vayu::core::ImportSource;
using vayu::core::parse_import;

/**
 * The first request anywhere under a parsed document's root collection - a
 * request whose path has a segment is filed under a folder named by that path
 * (issue #710), not under the root's own `requests`, so a case that does not
 * care which folder needs this rather than `collections[0].at("requests")[0]`.
 *
 * `nlohmann::ordered_json`, not this file's `json` alias (`nlohmann::json`):
 * `ImportParse::result` is `ordered_json`, and a `const json&` parameter here
 * would bind to a *converted temporary* rather than to `parsed.result` itself,
 * so the reference this returns would dangle the moment the call expression
 * ends - a real instance of the shape `VAYU_IGNORE_FALSE_DANGLING_REFERENCE`
 * exists to tell apart from, not one of its false positives.
 *
 * `VAYU_IGNORE_FALSE_NULL_DEREFERENCE`: a release build inlines `at(0)`'s
 * `is_array()` check deep enough at `-O3` that GCC loses track of the
 * iterator's non-nullness and reports a `-Wnull-dereference` on nlohmann's
 * own internals - the traced-into-libstdc++ family that macro exists for,
 * not a real path through this function.
 *
 * The descent is `children.at (0)` behind an emptiness check, not a range-for
 * that returns on its first iteration: MSVC's `/Od` build reports such a
 * loop's never-reached increment as C4702, fatal under the `/WX` that is
 * unconditional on that compiler, and only the Windows ASan leg builds at
 * `/Od` (`/O2` folds the loop away, so `windows-prod` never sees it).
 */
VAYU_IGNORE_FALSE_NULL_DEREFERENCE
inline const nlohmann::ordered_json& first_request (const nlohmann::ordered_json& collection) {
    if (const auto requests = collection.find ("requests");
    requests != collection.end () && !requests->empty ()) {
        return requests->at (0);
    }
    if (const nlohmann::ordered_json& children = collection.at ("children");
    !children.empty ()) {
        return first_request (children.at (0));
    }
    ADD_FAILURE () << "no request found under " << collection.dump ();
    static const nlohmann::ordered_json none;
    return none;
}

VAYU_DIAGNOSTIC_POP

/// `meta.skipped` as `{kind: count}` - see the file comment of
/// `import_parse_test.cpp`.
inline json skip_counts (const json& skipped) {
    json counts = json::object ();
    for (const json& entry : skipped) {
        const std::string kind = entry.at ("kind").get<std::string> ();
        counts[kind]           = counts.contains (kind) ?
        counts[kind].get<int> () + entry.at ("count").get<int> () :
        entry.at ("count").get<int> ();
    }
    return counts;
}

/// The item a count is about, by the name the preview shows. An OpenAPI
/// count taken while a walk was on an operation names that operation's
/// request, a document-level one names none, and Postman's per-request
/// counters name the request they grew on.
inline std::vector<std::string>
skipped_named (const ImportParse& parsed, const std::string& kind) {
    for (const auto& item : parsed.result.at ("meta").at ("skipped")) {
        if (item.at ("kind") == kind) {
            return item.contains ("requests") ?
            item.at ("requests").get<std::vector<std::string>> () :
            std::vector<std::string>{};
        }
    }
    ADD_FAILURE () << "no " << kind << " counted";
    return {};
}

using Names = std::vector<std::string>;

inline constexpr const char* POSTMAN_SCHEMA =
"https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

inline Names names_in (const json& meta, const char* member) {
    return meta.contains (member) ? meta.at (member).get<Names> () : Names{};
}

/// One Postman request with a single `prerequest` script whose lines are
/// @p exec, an already-JSON array.
inline std::string request_with_script (const std::string& name, const std::string& exec) {
    return R"j({"name":")j" + name + R"j(","event":[{"listen":"prerequest","script":{"exec":)j" +
    exec + R"j(}}],"request":{"method":"GET","url":"https://x.com"}})j";
}

inline ImportParse parse_postman_items (const std::string& items,
const ImportOptions& options = {}) {
    return parse_import (R"({"info":{"name":"Legacy API","schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},"item":[)" + items + "]}",
    options, {});
}

using HeaderPairs = std::vector<std::pair<std::string, std::string>>;

/// @p headers as `{key, value}` pairs, in order.
inline HeaderPairs header_pairs (const json& headers) {
    HeaderPairs pairs;
    for (const json& row : headers) {
        pairs.emplace_back (row.at ("key").get<std::string> (),
        row.at ("value").get<std::string> ());
        EXPECT_TRUE (row.at ("enabled").get<bool> ()) << row.dump ();
    }
    return pairs;
}

/// How many times an import's `meta.skipped` reports @p kind.
inline int skipped_count (const json& meta, const std::string& kind) {
    for (const json& entry : meta.at ("skipped")) {
        if (entry.at ("kind") == kind) {
            return entry.at ("count").get<int> ();
        }
    }
    return 0;
}

} // namespace vayu::tests::import_parse
