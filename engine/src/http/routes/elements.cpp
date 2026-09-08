/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/elements.cpp
 * @brief `GET /elements/kinds` - the element registry's catalogue (#1513).
 */

#include "vayu/http/routes.hpp"

namespace vayu::http::routes {

void register_elements_routes (RouteContext& ctx) {
    /**
     * GET /elements/kinds
     * Every registered element kind: name, version, phases, config schema,
     * label, description, category and hot-path class. What #1516 (app) and
     * #1517 (MCP) render a kind's editor from, and what the engine test suite
     * writes to `tests/fixtures/element-kinds.json` on every run so the
     * app/MCP/docs conformance tests have it without a running engine.
     */
    ctx.server.Get ("/elements/kinds", [] (const httplib::Request&, httplib::Response& res) {
        res.set_content (vayu::core::elements_catalogue ().dump (), "application/json");
    });
}

} // namespace vayu::http::routes
