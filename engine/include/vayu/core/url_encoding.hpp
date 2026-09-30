#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/url_encoding.hpp
 * @brief A whole URL written as Postman puts it on the wire.
 */

#include <string>
#include <string_view>

namespace vayu::core {

/**
 * @brief @p url percent-encoded component by component, as
 *        `postman-url-encoder` 3.0.8's `toNodeUrl (url, false)` writes it.
 *
 * The URL is split by Postman's parser (`postman-url-encoder/parser`): leading
 * whitespace is dropped, the fragment starts at the first `#`, the query at
 * the first `?` before it, a backslash before the query is a `/`, and the
 * authority's user info runs to its last `@`. Then:
 *
 * - user and password (split at the first `:`): `USERINFO_ENCODE_SET`;
 * - host: ASCII lowercased, otherwise as typed (see below);
 * - path: `PATH_ENCODE_SET`, as `encode_path_variable_value` writes it;
 * - query: each `&`-separated pair split at its first `=` and written by
 *   `encode_query_component`, which is `QUERY_ENCODE_SET` applied to the
 *   query text, since a pair read this way holds no `&` and its key no `=`;
 * - fragment: `FRAGMENT_ENCODE_SET`. Postman does not send it, nor does
 *   libcurl, but libcurl refuses a URL with a raw space anywhere.
 *
 * `%` is in no set, so an escape already in the text passes and the result
 * is idempotent. A whole `{{...}}` token is kept verbatim, as it is by every
 * other Vayu URL encoder; Postman would write a brace in the path as `%7B`.
 *
 * `toNodeUrl` also converts an IDN host to punycode (`url.domainToASCII`).
 * That is not done here: libcurl is built without IDN support (no `idn`
 * feature in `vcpkg.json`), so a non-ASCII host fails to resolve on every
 * Vayu send path alike, and the answer belongs in libcurl's build.
 */
[[nodiscard]] std::string encode_url_as_postman (std::string_view url);

} // namespace vayu::core
