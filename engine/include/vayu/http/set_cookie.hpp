/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/set_cookie.hpp
 * @brief Parse a response's `Set-Cookie` header into name / value / attributes.
 *
 * The renderer has had this parser since the response Cookies tab was fixed
 * (`app/src/modules/request-builder/components/ResponseViewer/parse-set-cookie.ts`);
 * this is the engine's copy, for `pm.response.cookies`. Two copies of a parser
 * drift, so they are pinned to each other by the cross-language fixture
 * `tests/fixtures/set-cookie-conformance.json`, read by
 * `tests/set_cookie_test.cpp` (gtest) and
 * `parse-set-cookie.conformance.test.ts` (vitest) - the same arrangement
 * `variable-resolution-conformance.json` uses for `{{variable}}` resolution.
 *
 * The two cases a naive `split(",")` / `split("=")` corrupts - and that the
 * fixture exists to keep both sides handling - are documented on
 * `parse_set_cookie` below.
 */

#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace vayu::http {

/**
 * @brief One cookie read off a `Set-Cookie` header.
 */
struct SetCookie {
    std::string name;
    std::string value;
    /// Everything after the name=value pair, one entry per `;` chunk, in wire
    /// order and unparsed ("Path=/", "HttpOnly"). Structured attribute
    /// accessors wait for the cookie jar (#301 step 2) - a script that needs
    /// one reads the string today rather than being handed a field the engine
    /// does not really keep.
    std::vector<std::string> attrs;
};

/**
 * @brief Parse a `Set-Cookie` header value.
 *
 * Handles the two cases that make this more than a split:
 *
 *   - **The expiry comma.** Multiple `Set-Cookie` headers reach a single
 *     header value joined by ", ", so a comma is a cookie boundary - except
 *     inside `Expires=Wed, 21 Oct 2015 07:28:00 GMT`. A new cookie only starts
 *     where a comma is followed by `name=`, which the remainder of a date
 *     never matches.
 *   - **The `=` in a value.** Session cookies are routinely base64 and end in
 *     `=` padding, so the pair splits at the *first* `=` and the rest of the
 *     chunk is the value verbatim.
 *
 * A chunk with no `=`, or one whose `=` is the first character (an unnamed
 * cookie), is dropped rather than reported as a cookie with an empty name.
 *
 * @param header Raw header value, e.g. `id=a3fWa; Path=/; HttpOnly`.
 * @return The cookies in wire order; empty for a header that names none.
 */
std::vector<SetCookie> parse_set_cookie (std::string_view header);

} // namespace vayu::http
