#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief The follow-up requests `assert.snapshot` sends for a paged list
 *        (#3824), `ElementContext::send_list_page`: the one sender every path
 *        shares.
 */

#include <expected>
#include <string>

#include "vayu/core/elements.hpp"
#include "vayu/http/client.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/**
 * One list page: @p page_request sent through @p config, its reply read by the
 * reply reader, and the final JSON-RPC response's text answered. A page is part
 * of what the step does, so it is counted on @p step's `mcp_reply` and its time
 * and bytes are added to @p step, and to @p view as well when the elements read
 * a copy (`mcp_element_view`), so a later `assert.duration` reads the figure
 * the step records. A cancelled page answers `cancelled`, which is no verdict.
 */
[[nodiscard]] std::expected<std::string, core::ListPageFailure>
send_list_page (const ClientConfig& config, const Request& page_request, Response& step, Response* view);

} // namespace vayu::http
