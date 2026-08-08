/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

TransferData::~TransferData () {
    if (headers_list) {
        curl_slist_free_all (headers_list);
    }
    if (resolve_list) {
        curl_slist_free_all (resolve_list);
    }
    // Freed after the transfer is done with the handle, which is what
    // curl_mime_free requires; the pool's curl_easy_reset on the next acquire
    // drops the handle's reference to it either way.
    if (mime) {
        curl_mime_free (mime);
    }
}

} // namespace vayu::http::detail
