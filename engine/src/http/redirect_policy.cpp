/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/redirect_policy.cpp
 * @brief What the engine's own redirect loop decides between two hops.
 */

#include "vayu/http/redirect_policy.hpp"

#include <algorithm>
#include <memory>

#include "vayu/http/curl_options.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/ascii_case.hpp"

namespace vayu::http {

namespace {

using UrlHandle = std::unique_ptr<CURLU, decltype (&curl_url_cleanup)>;

UrlHandle new_url_handle () {
    return UrlHandle (curl_url (), &curl_url_cleanup);
}

/// The flags libcurl reads a transfer's own URL with, so a URL naming no
/// scheme is read as the one it dialled.
constexpr unsigned int TRANSFER_URL_FLAGS =
CURLU_GUESS_SCHEME | CURLU_NON_SUPPORT_SCHEME | CURLU_ALLOW_SPACE;

/// The flags libcurl resolved a `Location` with when it followed one, plus
/// `CURLU_NON_SUPPORT_SCHEME` so a scheme it was not built with is named by
/// the scheme rule below rather than failing the parse.
constexpr unsigned int LOCATION_FLAGS =
CURLU_URLENCODE | CURLU_ALLOW_SPACE | CURLU_NON_SUPPORT_SCHEME;

std::optional<std::string> url_field (CURLU* handle, CURLUPart part, unsigned int flags = 0) {
    char* value = nullptr;
    if (curl_url_get (handle, part, &value, flags) != CURLUE_OK || value == nullptr) {
        return std::nullopt;
    }
    std::string out (value);
    curl_free (value);
    return out;
}

Error unparsable_target (CURLUcode code) {
    return Error{ ErrorCode::InvalidUrl,
        std::string ("The redirect target URL could not be parsed: ") +
        curl_url_strerror (code) };
}

struct Origin {
    std::string scheme;
    std::string host;
    std::string port;
};

std::optional<Origin> origin_of (const std::string& url) {
    const UrlHandle handle = new_url_handle ();
    if (!handle ||
    curl_url_set (handle.get (), CURLUPART_URL, url.c_str (), TRANSFER_URL_FLAGS) != CURLUE_OK) {
        return std::nullopt;
    }
    auto scheme = url_field (handle.get (), CURLUPART_SCHEME);
    auto host   = url_field (handle.get (), CURLUPART_HOST);
    auto port   = url_field (handle.get (), CURLUPART_PORT, CURLU_DEFAULT_PORT);
    if (!scheme || !host || !port) {
        return std::nullopt;
    }
    return Origin{ std::move (*scheme), std::move (*host), std::move (*port) };
}

/// The tab-separated fields of a Netscape cookie line: domain, tailmatch,
/// path, secure, expires, name, value.
constexpr std::size_t NETSCAPE_FIELDS       = 7;
constexpr std::size_t EXPIRES_FIELD         = 4;
constexpr std::string_view HTTP_ONLY_PREFIX = "#HttpOnly_";

std::optional<std::vector<std::string_view>> netscape_fields (std::string_view line) {
    std::vector<std::string_view> fields;
    fields.reserve (NETSCAPE_FIELDS);
    while (fields.size () + 1 < NETSCAPE_FIELDS) {
        const std::size_t tab = line.find ('\t');
        if (tab == std::string_view::npos) {
            return std::nullopt;
        }
        fields.push_back (line.substr (0, tab));
        line.remove_prefix (tab + 1);
    }
    fields.push_back (line);
    return fields;
}

std::vector<std::string> engine_lines (CURL* curl) {
    std::vector<std::string> lines;
    struct curl_slist* held = nullptr;
    if (get_info<CURLINFO_COOKIELIST> (curl, &held) != CURLE_OK) {
        return lines;
    }
    for (const struct curl_slist* item = held; item != nullptr; item = item->next) {
        if (item->data != nullptr) {
            lines.emplace_back (item->data);
        }
    }
    curl_slist_free_all (held);
    return lines;
}

bool contains (const std::vector<std::string>& lines, const std::string& line) {
    return std::ranges::find (lines, line) != lines.end ();
}

/// The name of one header-list line: what precedes `:`, or `;` in libcurl's
/// spelling of a blank header, without blanks.
std::string_view header_line_name (std::string_view line) {
    return trim_optional_whitespace (line.substr (0, line.find_first_of (":;")));
}

/// @p first without the lines a hop to another origin, or a rewritten hop,
/// does not send; the caller owns the copy. Null when no line is left.
curl_slist* filtered_header_list (const curl_slist* first, bool other_origin, bool rewritten) {
    curl_slist* list = nullptr;
    for (const curl_slist* item = first; item != nullptr; item = item->next) {
        const std::string_view name = header_line_name (item->data);
        if ((other_origin && is_origin_bound_header (name)) ||
        (rewritten && is_body_header (name))) {
            continue;
        }
        list = curl_slist_append (list, item->data);
    }
    return list;
}

} // namespace

bool is_redirect_status (int status) {
    return status >= 300 && status < 400;
}

std::optional<std::string> location_of (const std::vector<HeaderLine>& lines) {
    for (const auto& line : lines) {
        if (vayu::utils::ascii_lower_equal (line.name, "location") &&
        !line.value.empty ()) {
            return line.value;
        }
    }
    return std::nullopt;
}

std::expected<std::string, Error>
resolve_redirect_target (const std::string& base_url, const std::string& location) {
    const UrlHandle handle = new_url_handle ();
    if (!handle) {
        return std::unexpected (unparsable_target (CURLUE_OUT_OF_MEMORY));
    }
    CURLUcode code =
    curl_url_set (handle.get (), CURLUPART_URL, base_url.c_str (), TRANSFER_URL_FLAGS);
    if (code == CURLUE_OK) {
        code = curl_url_set (handle.get (), CURLUPART_URL, location.c_str (), LOCATION_FLAGS);
    }
    if (code == CURLUE_OK) {
        code = curl_url_set (handle.get (), CURLUPART_FRAGMENT, nullptr, 0);
    }
    auto target = code == CURLUE_OK ? url_field (handle.get (), CURLUPART_URL) : std::nullopt;
    if (!target) {
        return std::unexpected (unparsable_target (code));
    }
    if (vayu::http::unsendable_scheme (*target)) {
        const auto scheme = url_field (handle.get (), CURLUPART_SCHEME).value_or ("");
        return std::unexpected (Error{ ErrorCode::InvalidUrl,
        "Protocol \"" + vayu::utils::ascii_lower (scheme) + "\" is disabled (in redirect)" });
    }
    return std::move (*target);
}

RedirectedRequest redirected_request (int status, HttpMethod method) {
    if (status != 301 && status != 302 && status != 303) {
        return { method, true };
    }
    return { method == HttpMethod::POST ? HttpMethod::GET : method, false };
}

bool same_origin (const std::string& a, const std::string& b) {
    const auto first  = origin_of (a);
    const auto second = origin_of (b);
    return first && second &&
    vayu::utils::ascii_lower_equal (first->scheme, second->scheme) &&
    vayu::utils::ascii_lower_equal (first->host, second->host) &&
    first->port == second->port;
}

bool is_origin_bound_header (std::string_view name) {
    return vayu::utils::ascii_lower_equal (name, "authorization") ||
    vayu::utils::ascii_lower_equal (name, "cookie");
}

bool is_body_header (std::string_view name) {
    return vayu::utils::ascii_lower_equal (name, "content-type") ||
    vayu::utils::ascii_lower_equal (name, "content-length");
}

bool redirect_limit_reached (int followed, int max_redirects) {
    return max_redirects >= 0 && followed >= max_redirects;
}

Error too_many_redirects_error (int max_redirects) {
    return Error{ ErrorCode::TooManyRedirects,
        too_many_redirects_message (max_redirects,
        "Maximum (" + std::to_string (max_redirects) + ") redirects followed") };
}

std::string too_many_redirects_message (std::optional<long> limit, std::string_view detail) {
    std::string text = "Too many redirects: the server redirected more than ";
    text += limit ? std::to_string (*limit) + " times" : "the allowed number of times";
    text += " (see Maximum redirects). ";
    text += detail;
    return text;
}

RedirectChain::RedirectChain (const Request& request,
curl_slist* first_headers,
detail::BodySource& body)
: request_ (&request), body_ (&body),
  hop_{ wire_url (request), request.method, has_wire_body (request) },
  first_headers_ (first_headers) {
}

void RedirectChain::SlistDeleter::operator() (curl_slist* list) const {
    curl_slist_free_all (list);
}

std::optional<NextHop>
RedirectChain::redirect_target (const std::vector<HeaderLine>& lines, int status) const {
    if (!request_->follow_redirects || !is_redirect_status (status)) {
        return std::nullopt;
    }
    const auto location = location_of (lines);
    if (!location) {
        return std::nullopt;
    }
    if (redirect_limit_reached (hop_.followed, request_->max_redirects)) {
        return NextHop (std::unexpect, too_many_redirects_error (request_->max_redirects));
    }
    return resolve_redirect_target (hop_.url, *location);
}

void RedirectChain::advance (CURL* curl, int status, std::string next_url) {
    apply_method (curl, status);
    hop_.url = std::move (next_url);
    ++hop_.followed;
    set_opt<CURLOPT_URL> (curl, hop_.url.c_str ());
    apply_headers (curl, same_origin (wire_url (*request_), hop_.url));
}

void RedirectChain::apply_method (CURL* curl, int status) {
    const RedirectedRequest next = redirected_request (status, hop_.method);
    if (next.method != hop_.method || (hop_.carries_body && !next.keeps_body)) {
        detail::apply_bodyless_method (curl, next.method, *body_);
        hop_.method       = next.method;
        hop_.carries_body = false;
        hop_.rewritten    = true;
        return;
    }
    if (hop_.carries_body) {
        detail::rewind_body_source (*body_);
    }
}

void RedirectChain::apply_headers (CURL* curl, bool first_origin) {
    const bool filtered = !first_origin || hop_.rewritten;
    SlistPtr next       = filtered ?
    SlistPtr (filtered_header_list (first_headers_.get (), !first_origin, hop_.rewritten)) :
    nullptr;
    set_opt<CURLOPT_HTTPHEADER> (curl, filtered ? next.get () : first_headers_.get ());
    hop_headers_ = std::move (next);
    // libcurl copies a string option, so the value need not outlive the call.
    const std::string cookies = first_origin ? detail::typed_cookie_value (*request_) : "";
    set_opt<CURLOPT_COOKIE> (curl, cookies.empty () ? nullptr : cookies.c_str ());
}

std::optional<std::string> cookie_identity (std::string_view netscape_line) {
    const auto fields = netscape_fields (netscape_line);
    if (!fields) {
        return std::nullopt;
    }
    std::string_view domain = fields->at (0);
    if (domain.starts_with (HTTP_ONLY_PREFIX)) {
        domain.remove_prefix (HTTP_ONLY_PREFIX.size ());
    }
    std::string identity = vayu::utils::ascii_lower (std::string (domain));
    for (const std::size_t field : { 1U, 2U, 5U }) {
        identity += '\t';
        identity += fields->at (field);
    }
    return identity;
}

std::optional<std::string> expired_cookie_line (std::string_view netscape_line) {
    const auto fields = netscape_fields (netscape_line);
    if (!fields) {
        return std::nullopt;
    }
    std::string line;
    for (std::size_t i = 0; i < fields->size (); ++i) {
        if (i > 0) {
            line += '\t';
        }
        line += i == EXPIRES_FIELD ? std::string_view ("1") : fields->at (i);
    }
    return line;
}

void HopCookies::before_hop (const std::string& hop_url) {
    hop_url_ = hop_url;
    withheld_.clear ();
    before_ = engine_lines (curl_);
    if (set_by_.empty ()) {
        return;
    }
    std::vector<std::string> kept;
    kept.reserve (before_.size ());
    for (auto& line : before_) {
        const auto identity = cookie_identity (line);
        const auto setter = identity ? std::ranges::find (set_by_, *identity,
                                       &std::pair<std::string, std::string>::first) :
                                       set_by_.end ();
        const auto expired = expired_cookie_line (line);
        if (setter == set_by_.end () || same_origin (setter->second, hop_url_) || !expired) {
            kept.push_back (std::move (line));
            continue;
        }
        set_opt<CURLOPT_COOKIELIST> (curl_, expired->c_str ());
        withheld_.push_back (std::move (line));
    }
    before_ = std::move (kept);
}

void HopCookies::after_hop () {
    std::vector<std::string> present;
    for (const auto& line : engine_lines (curl_)) {
        auto identity = cookie_identity (line);
        if (!identity) {
            continue;
        }
        if (!contains (before_, line)) {
            const auto known = std::ranges::find (
            set_by_, *identity, &std::pair<std::string, std::string>::first);
            if (known == set_by_.end ()) {
                set_by_.emplace_back (*identity, hop_url_);
            } else {
                known->second = hop_url_;
            }
        }
        present.push_back (std::move (*identity));
    }
    // A hop to another origin that set the same cookie replaced it; any other
    // withheld cookie goes back into the engine for the hops after this one
    // and for the jar.
    for (const auto& line : withheld_) {
        const auto identity = cookie_identity (line);
        if (identity && !contains (present, *identity)) {
            set_opt<CURLOPT_COOKIELIST> (curl_, line.c_str ());
        }
    }
    withheld_.clear ();
}

} // namespace vayu::http
