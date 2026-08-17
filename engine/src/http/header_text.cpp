/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/header_text.hpp"

#include "vayu/http/form_body.hpp"

namespace vayu::http {

namespace {

/// One clause saying what the offending byte does to the line, so every
/// refusal below explains the same failure the same way.
constexpr std::string_view kEndsTheLine =
"a CR or LF ends the header line rather than sitting in it, so the rest would "
"be read as headers of its own";
constexpr std::string_view kCutsTheLine =
"a NUL cuts the header line short, so the rest of it would be dropped on the "
"wire without a word";

/// Why @p text cannot be written into a header line, or nullopt when it can.
/// Both faults are asked about together everywhere except the bind-time cell
/// check, which predates the NUL rule and owns its own message (#732).
std::optional<std::string_view> line_fault (std::string_view text) {
    if (ends_a_header_line (text)) {
        return kEndsTheLine;
    }
    if (truncates_a_header_line (text)) {
        return kCutsTheLine;
    }
    return std::nullopt;
}

/// The refusal @p what reads as, given the fault its text carries.
///
/// @p what never quotes the offending text itself: the faulty string is the one
/// carrying a line break, and pasting it into the message would break the
/// message the same way. Text that is quoted here has already been checked.
std::string refusal (std::string_view what, std::string_view fault) {
    return std::string (what) + " cannot be sent as written - " +
    std::string (fault) + "; the request is refused rather than sent forging a header";
}

} // namespace

bool ends_a_header_line (std::string_view text) {
    return text.find_first_of ("\r\n") != std::string_view::npos;
}

bool truncates_a_header_line (std::string_view text) {
    return text.find ('\0') != std::string_view::npos;
}

std::optional<std::string> unsendable_header_text (const Request& request) {
    for (const auto& [name, value] : request.headers) {
        if (auto fault = line_fault (name)) {
            return refusal ("a request header name", *fault);
        }
        if (auto fault = line_fault (value)) {
            return refusal ("the value of header '" + name + "'", *fault);
        }
    }

    // Multipart only: the other body modes carry no per-part header block, and
    // a urlencoded field's bytes are percent-encoded before they reach one.
    if (request.body.mode != BodyMode::FormData) {
        return std::nullopt;
    }
    for (const auto& field : enabled_fields (request.body.fields)) {
        // libcurl writes all three into the part's own headers:
        // `Content-Disposition: form-data; name="..."; filename="..."` and
        // `Content-Type`. The part's *value* is content, not header text.
        if (auto fault = line_fault (field.key)) {
            return refusal ("a multipart form field name", *fault);
        }
        if (auto fault = line_fault (field.file_name)) {
            return refusal ("the file name on form field '" + field.key + "'", *fault);
        }
        if (auto fault = line_fault (field.content_type)) {
            return refusal ("the content type on form field '" + field.key + "'", *fault);
        }
    }
    return std::nullopt;
}

} // namespace vayu::http
