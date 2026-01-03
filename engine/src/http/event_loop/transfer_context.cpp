#include "vayu/http/event_loop/transfer_context.hpp"

namespace vayu::http::detail {

TransferData::~TransferData() {
    if (headers_list) {
        curl_slist_free_all(headers_list);
    }
}

}  // namespace vayu::http::detail
