#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>
#include <vector>

#include "vayu/types.hpp"

/**
 * @file form_body.hpp
 * @brief The two form body modes, from the stored shape to the wire.
 *
 * `x-www-form-urlencoded` and `form-data` are the only modes whose content is
 * a list of fields rather than a string, so every question the transfer setup
 * asks about a body ("are there bytes to send?", "which Content-Type?") has a
 * different answer for them. Those questions are answered here, once, as pure
 * functions of the body - both HTTP drivers (the single-request client and the
 * event loop) read the same answers, and the rules are unit-testable without a
 * curl handle or a socket.
 *
 * Multipart is *not* encoded here: its body carries a boundary, which libcurl
 * generates as part of `curl_mime`, so the encoder and the Content-Type that
 * describes it stay together inside libcurl. See `content_type_is_engine_owned`.
 */

namespace vayu::http {

/**
 * @brief True when the mode carries its content in `Body::fields`.
 */
[[nodiscard]] bool is_form_mode (BodyMode mode);

/**
 * @brief The fields that go on the wire - enabled only, in order.
 *
 * A disabled row is stored (the user can switch it back on) but never sent,
 * matching the rule params and headers already follow.
 */
[[nodiscard]] std::vector<FormField> enabled_fields (const std::vector<FormField>& fields);

/**
 * @brief Enabled fields percent-encoded as `application/x-www-form-urlencoded`.
 *
 * Percent-encoding is libcurl's `curl_easy_escape`, not a hand-rolled table:
 * a private copy would not receive its fixes. Empty when no field is enabled.
 */
[[nodiscard]] std::string encode_urlencoded (const std::vector<FormField>& fields);

/**
 * @brief True when this body puts bytes in the request's body frame.
 *
 * The one predicate every caller uses, because "has a body" is mode-dependent:
 * a content mode needs a non-empty `content`, a form mode needs at least one
 * enabled field.
 */
[[nodiscard]] bool has_wire_body (const Body& body);

/**
 * @brief The Content-Type this body implies when the request declares none.
 *
 * Empty for every mode but `x-www-form-urlencoded`. The engine has never
 * derived a Content-Type for json/text/graphql - clients own that header, and
 * the request builder writes it - so adding one here would take a header away
 * from the user who typed it. The form modes are different: their encoding is
 * chosen engine-side, so nothing else can name it.
 */
[[nodiscard]] std::string implied_content_type (const Body& body);

/**
 * @brief True when the engine writes the Content-Type and a caller's is dropped.
 *
 * Only multipart. Its Content-Type must carry the same boundary as the body
 * libcurl encoded, so a caller-supplied `multipart/form-data` - which has no
 * way to name a boundary that does not exist yet - would make the body
 * unparseable. Dropping it is what every code generator in the app already
 * does for multipart (`services/codegen/prepare.ts`).
 */
[[nodiscard]] bool content_type_is_engine_owned (const Body& body);

} // namespace vayu::http
