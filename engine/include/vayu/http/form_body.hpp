#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <optional>
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
 *
 * The one question a *file* part adds - "is this file actually sendable?" - is
 * answered here too, because it has to be answered identically by both drivers
 * and before either of them starts a transfer. See `unsendable_file_part`.
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
 * @brief Enabled parts rendered as a string, with file parts named.
 *
 * The multipart counterpart to `encode_urlencoded`, and a *rendering* rather
 * than an encoding: multipart bytes belong to libcurl (see `wire_body_bytes`),
 * so this exists only for the surfaces that must show a form-data body as a
 * string - today `pm.request.body`.
 *
 * A text part reads exactly as `encode_urlencoded` writes it. A **file part**
 * reads `key=@filename`, borrowing curl's own `-F` spelling: it carries its
 * content in `src` rather than `value`, so encoding it as a pair rendered
 * `avatar=` - indistinguishable from a text part whose value is empty, which is
 * the one case where the rendering lost information a reader could not recover
 * (issue #411).
 *
 * The filename is the one the *server* is told (`file_name`, else the basename
 * of `src`), not the path: a path discloses this machine's layout to anything a
 * script logs, and adds nothing the request itself sends. The `@` cannot be
 * confused with a text value that starts with one, because percent-encoding
 * escapes `@` to `%40` in a value and this marker is written unescaped.
 */
[[nodiscard]] std::string render_form_data_parts (const std::vector<FormField>& fields);

/**
 * @brief `key=value&…` parsed back into fields - the inverse of the encoder.
 *
 * Decoding is libcurl's `curl_easy_unescape` for the same reason the encoder
 * uses `curl_easy_escape`. `+` decodes to a space first, because that is what
 * the `application/x-www-form-urlencoded` media type says it means; a literal
 * plus travels as `%2B` and survives. `encode_urlencoded` never emits a bare
 * `+`, so encode-then-parse round-trips exactly.
 *
 * A pair with no `=` becomes a field with an empty value, and an empty segment
 * is skipped - a body is a list of pairs, so there is no "malformed" here to
 * reject. Every parsed field is enabled: the string carries no disabled rows,
 * and inventing one would send a field the caller did not write.
 */
[[nodiscard]] std::vector<FormField> parse_urlencoded (const std::string& encoded);

/**
 * @brief True when this body puts bytes in the request's body frame.
 *
 * The one predicate every caller uses, because "has a body" is mode-dependent:
 * a content mode needs a non-empty `content`, a form mode needs at least one
 * enabled field.
 */
[[nodiscard]] bool has_wire_body (const Body& body);

/**
 * @brief The bytes this body puts in the request's body frame.
 *
 * The one answer to "what actually goes on the wire", because it is not
 * `body.content` for three of the six modes: the form modes carry their
 * content as fields, and a `graphql` body is enveloped on the way out. Both
 * HTTP drivers read it, and so does the raw-request view - a view that
 * rebuilt the body itself would show something the transfer did not send.
 *
 * Empty for a body with nothing to send (`has_wire_body` is false) and empty
 * for **multipart**, whose bytes belong to libcurl: it encodes the parts and
 * generates the boundary, so no faithful string exists outside the transfer.
 */
[[nodiscard]] std::string wire_body_bytes (const Body& body);

/**
 * @brief The Content-Type this body implies when the request declares none.
 *
 * Every mode whose bytes have one right answer has one here.
 * `x-www-form-urlencoded` because its encoding is chosen engine-side, so
 * nothing else can name it; `graphql` and `jsonrpc` because the engine is what
 * writes their envelope (see `graphql_body.hpp`), and a body the engine shaped
 * into JSON cannot be left to libcurl's `x-www-form-urlencoded` default; `xml`
 * and `json` because the mode *is* the type.
 *
 * **`json` was absent until issue #889, and that was a bug rather than the
 * restraint it read as.** The old rule here - "those clients own the header and
 * the request builder writes it" - was true of exactly one client. The request
 * builder does write the row, so a request authored in the UI went out
 * correctly; every other origin did not. A request created over MCP, imported,
 * or posted straight to `/execute` with `mode: "json"` reached the server as
 * `application/x-www-form-urlencoded`, which is libcurl's default for a POST
 * carrying a body - the same failure `graphql` was fixed for, one mode over.
 * Deriving it here takes no header away from anyone, because a declared one
 * still wins.
 *
 * Empty for **text** and **binary**, and that one *is* restraint: `text/plain`,
 * `text/csv`, a JWT and a raw signature are all `text`, so there is no answer to
 * derive and the header stays the author's.
 *
 * Only ever a *default*: a Content-Type the caller set wins in every case
 * (`body_content_type_value`), which is how an explicit `application/graphql` -
 * or an `application/vnd.api+json` on a JSON body - still reaches the server.
 */
[[nodiscard]] std::string implied_content_type (const Body& body);

/**
 * @brief The same three questions, asked of the whole request.
 *
 * One body mode's transport depends on the **method**: a `graphql` body goes
 * out as query parameters on a GET and as a JSON envelope on everything else
 * (`graphql_get_parameters`, issue #1228). So "has a body?", "which bytes?" and
 * "which Content-Type?" have a request-level answer that the `Body` overloads
 * above cannot give - a `Body` does not know the method it will be sent with.
 *
 * **Every send site asks these**, and the raw-request view with them, so what
 * is shown is what went out. The `Body` overloads remain for the callers that
 * genuinely hold only a body - the script surface's `pm.request.body`, and the
 * three functions here - and reaching for one at a send site is how a request
 * would go back to carrying a GraphQL body on a GET.
 *
 * `wire_url` is the fourth question, and it is only ever asked here: it is the
 * URL a request is sent to, which is `request.url` for everything except the
 * GET transport, where the document rides in the query string.
 */
[[nodiscard]] bool has_wire_body (const Request& request);

/// @copydoc has_wire_body(const Request&)
[[nodiscard]] std::string wire_body_bytes (const Request& request);

/// @copydoc has_wire_body(const Request&)
[[nodiscard]] std::string implied_content_type (const Request& request);

/// @copydoc has_wire_body(const Request&)
[[nodiscard]] std::string wire_url (const Request& request);

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

/**
 * @brief True when this body has at least one enabled file part.
 *
 * The cheap gate every hot-path caller checks first: a body without one pays
 * nothing for the filesystem check below, which is one `stat` per transfer.
 */
[[nodiscard]] bool has_file_parts (const Body& body);

/**
 * @brief The filename the server is told a file part carries.
 *
 * `file_name` when the part declares one, else the basename of `src`, with
 * separators for both platforms because the path is whatever the client on this
 * machine wrote. It mirrors what the transfer setup hands libcurl
 * (`curl_mime_filedata` declares the basename, an explicit `curl_mime_filename`
 * overrides it), so nothing that shows a part can name one thing while the send
 * names another.
 *
 * The path itself is deliberately not part of any answer built from this: it
 * discloses this machine's layout to anything a script logs and adds nothing the
 * request sends. `render_form_data_parts` and `pm.request.body.formdata` (issue
 * #1003) are the two surfaces that show a part, and they show this.
 */
[[nodiscard]] std::string declared_file_name (const FormField& field);

/**
 * @brief Why this body's file parts cannot be sent, if any of them cannot.
 *
 * A part with no `src` (a row authored but never pointed at a file, or one
 * imported from another machine) and a part naming a file this process cannot
 * read are both failures of the *request*, not of the transfer, and both are
 * answered here rather than left to libcurl: curl reports an unreadable file as
 * a generic read error naming nothing, and the failure mode this whole feature
 * exists to remove is a part that disappears without a word.
 *
 * The returned message names the field and the path. `std::nullopt` means every
 * enabled file part is readable *right now* - the file can still vanish between
 * this check and the send, which libcurl then reports on its own terms; this is
 * the loud, attributable answer for the case that is actually common.
 */
[[nodiscard]] std::optional<std::string> unsendable_file_part (const Body& body);

} // namespace vayu::http
