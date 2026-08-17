#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <optional>
#include <string>
#include <string_view>

#include "vayu/types.hpp"

/**
 * @file header_text.hpp
 * @brief What a header line can and cannot be made of - one rule, one place.
 *
 * A header is `Key: value` terminated by CRLF, and it has no escape for either
 * of those bytes. So text carrying a CR or an LF does not *sit* in the header
 * it was written into - it ends the line, and whatever follows is read as a
 * header of its own. That is a request nobody wrote, assembled from a value
 * somebody supplied.
 *
 * ## Where the rule is enforced, and why in more than one place
 *
 * The bytes reach a header from several origins, and each origin knows
 * something the next one down has already lost:
 *
 * - **A bound data cell** (`core/scenario_data.cpp`, issue #732) refuses at
 *   bind time, naming the column and the row - the only place that knows them.
 * - **A composed `{{variable}}`** (`http/request_composer.cpp`, issue #738)
 *   refuses at composition, naming the variable - the only place that knows
 *   *which* variable carried the byte. `POST /compose` is otherwise a pure
 *   resolution step, and this is the one payload it rejects over a value:
 *   substituting the byte and answering 200 would hand the caller a payload
 *   whose only remaining fate is the refusal below, with the name that would
 *   have explained it already discarded.
 * - **Every origin at once** (`unsendable_header_text`, called by
 *   `validate_transferable`) refuses before any driver configures a handle.
 *   This is the backstop that cannot be bypassed: a script that assigned to
 *   `pm.request.headers`, an importer, a client posting straight to
 *   `POST /execute`, an auth credential - none of them pass through the two
 *   above, and all three drivers (the single-request client, the load event
 *   loop, the SSE stream consumer) call the gate.
 *
 * The layers are not three rules: they are three messages for one rule, whose
 * single definition is `ends_a_header_line` / `truncates_a_header_line` below.
 * A new origin that wants a better message adds a layer *and* keeps the gate;
 * one that does not need it needs nothing at all.
 *
 * ## Refusal, never repair
 *
 * Stripping or encoding the bytes is the option this file deliberately does not
 * take, for the reason an XML comment is refused rather than escaped: a header
 * has no encoding for a line break, so every candidate either changes the value
 * or leaves the line ended - and a header arriving with something its author
 * did not write is the quiet wrong request the whole binding discipline exists
 * to remove.
 */

namespace vayu::http {

/**
 * @brief True when @p text carries a byte that ends the header line it is
 *        written into (CR or LF).
 *
 * The forgery case: everything after the break is read as a header of its own.
 */
[[nodiscard]] bool ends_a_header_line (std::string_view text);

/**
 * @brief True when @p text carries a NUL, which cuts the header line short.
 *
 * The engine spells a header `key + ": " + value` and hands it to
 * `curl_slist_append`, which reads to the first NUL - so a value carrying one
 * is *truncated* on the wire rather than refused. It forges nothing, but the
 * header that arrives is not the header that was asked for, which is the same
 * class of quiet wrong request (issue #738, item 3).
 */
[[nodiscard]] bool truncates_a_header_line (std::string_view text);

/**
 * @brief Why this request's header text cannot go on the wire as written, if
 *        any of it cannot.
 *
 * Covers every string the engine writes into a header line:
 *
 * - each request header's **name** and **value**, including the `Authorization`
 *   line `apply_auth` builds and anything a script assigned;
 * - a multipart part's **field name**, **file name** and **content type**,
 *   which libcurl writes into that part's own `Content-Disposition` /
 *   `Content-Type` header block. A part's *value* is not header text - it is
 *   content, where a line break is ordinary - and is deliberately not checked.
 *
 * A disabled part is skipped, because it is not sent; a request header is
 * checked whether or not it would survive `header_value_reaches_wire`, so this
 * answer does not depend on a second decision made elsewhere.
 *
 * The returned message names the header (or the part) and what the byte does.
 * `std::nullopt` means every header this request would send is spellable.
 */
[[nodiscard]] std::optional<std::string> unsendable_header_text (const Request& request);

} // namespace vayu::http
