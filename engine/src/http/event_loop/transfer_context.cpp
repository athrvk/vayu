/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

TransferData::~TransferData() {
    if (headers_list) {
        curl_slist_free_all(headers_list);
    }
    if (resolve_list) {
        curl_slist_free_all(resolve_list);
    }
}

}  // namespace vayu::http::detail
