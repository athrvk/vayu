/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/implied_content_type_test.cpp
 * @brief The Content-Type each body mode implies, against the shared table
 *        (issue #2464).
 *
 * `tests/fixtures/implied-content-type-conformance.json` is the contract
 * between `vayu::http::implied_content_type` and the app's copies of the same
 * table; a row added there fails whichever side answers it differently. Each
 * row goes through `deserialize_request`, the parse `/execute` and `/runs`
 * share, so the mode spelling and the request-level rule (a GraphQL GET has
 * no body frame) are part of what is pinned.
 */

#include <gtest/gtest.h>

#include <cstddef>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>

#include <nlohmann/json.hpp>

#include "vayu/http/form_body.hpp"
#include "vayu/types.hpp"
#include "vayu/utils/json.hpp"

namespace {

using nlohmann::json;

/// How many `BodyMode`s there are, `Xml` being the last enumerator: a mode
/// inserted before it without a row in `modes` fails the coverage assertion
/// below, and one appended after it has to move this along with the enum.
constexpr std::size_t BODY_MODE_COUNT =
static_cast<std::size_t> (vayu::BodyMode::Xml) + 1;

json load_fixture () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    "tests" / "fixtures" / "implied-content-type-conformance.json";
    std::ifstream in (path);
    if (!in.good ()) {
        ADD_FAILURE () << "fixture missing: " << path;
        return json::object ();
    }
    return json::parse (in);
}

/// The request a fixture row describes, as a payload would carry it.
vayu::Request request_of (const json& row) {
    json body = { { "mode", row.at ("mode") } };
    for (const char* member : { "content", "fields", "file" }) {
        if (row.contains (member)) {
            body[member] = row.at (member);
        }
    }
    const auto parsed =
    vayu::json::deserialize_request (json{ { "method", row.value ("method", "POST") },
    { "url", "http://127.0.0.1/echo" }, { "body", body } });
    if (!parsed.is_ok ()) {
        ADD_FAILURE () << row.at ("name") << ": " << parsed.error ().message;
        return vayu::Request{};
    }
    return parsed.value ();
}

/// Checks every row of @p section and answers how many it checked.
std::size_t check_rows (const json& section, std::set<vayu::BodyMode>* modes) {
    for (const json& row : section) {
        const vayu::Request request = request_of (row);
        EXPECT_EQ (vayu::http::implied_content_type (request),
        row.at ("expected").get<std::string> ())
        << row.at ("name");
        if (modes != nullptr) {
            modes->insert (request.body.mode);
        }
    }
    return section.size ();
}

TEST (ImpliedContentTypeConformance, EveryModeImpliesTheTypeTheTableNames) {
    const json fixture = load_fixture ();
    std::set<vayu::BodyMode> modes;
    ASSERT_TRUE (fixture.contains ("modes"));
    EXPECT_EQ (check_rows (fixture.at ("modes"), &modes), BODY_MODE_COUNT);
    EXPECT_EQ (modes.size (), BODY_MODE_COUNT)
    << "`modes` must hold exactly one row per BodyMode";
}

TEST (ImpliedContentTypeConformance, EveryEdgeCaseImpliesTheTypeTheTableNames) {
    const json fixture = load_fixture ();
    ASSERT_TRUE (fixture.contains ("cases"));
    EXPECT_GT (check_rows (fixture.at ("cases"), nullptr), 0U)
    << "no case read";
}

// The app reads `panelWritesRow` from the mode rows; a row without it would
// read as false there and pass silently.
TEST (ImpliedContentTypeConformance, EveryModeRowSaysWhetherThePanelWritesIt) {
    const json fixture = load_fixture ();
    ASSERT_TRUE (fixture.contains ("modes"));
    for (const json& row : fixture.at ("modes")) {
        EXPECT_TRUE (row.contains ("panelWritesRow") &&
        row.at ("panelWritesRow").is_boolean ())
        << row.at ("name");
    }
}

} // namespace
