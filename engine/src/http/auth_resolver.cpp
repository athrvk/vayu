#include "vayu/http/auth_resolver.hpp"

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cctype>
#include <string>

namespace vayu::http {

namespace {

// Case-insensitive check for an existing header key.
bool has_header_ci (const vayu::Headers& headers, const std::string& name) {
    return std::any_of (
    headers.begin (), headers.end (), [&name] (const auto& kv) {
        if (kv.first.size () != name.size ()) {
            return false;
        }
        return std::equal (
        kv.first.begin (), kv.first.end (), name.begin (),
        [] (char a, char b) {
            return std::tolower (static_cast<unsigned char> (a)) ==
            std::tolower (static_cast<unsigned char> (b));
        });
    });
}

// Fetch a string field, tolerating a missing key or non-string value.
std::string field (const nlohmann::json& obj, const char* key) {
    if (auto it = obj.find (key); it != obj.end () && it->is_string ()) {
        return it->get<std::string> ();
    }
    return {};
}

// Append `key=value` to a URL's query component, preserving any fragment.
void append_query_param (std::string& url, const std::string& key,
const std::string& value) {
    std::string fragment;
    if (const auto hash = url.find ('#'); hash != std::string::npos) {
        fragment = url.substr (hash);
        url.erase (hash);
    }
    url.push_back (url.find ('?') == std::string::npos ? '?' : '&');
    url += vayu::utils::url_encode (key);
    url.push_back ('=');
    url += vayu::utils::url_encode (value);
    url += fragment;
}

} // namespace

AuthApplyResult
apply_auth (vayu::Request& req, const nlohmann::json& auth, vayu::db::Database* db) {
    (void) db; // reserved for oauth2 token lookup (see auth_resolver PR2)

    if (!auth.is_object ()) {
        return {};
    }

    const std::string mode = field (auth, "mode");
    if (mode.empty () || mode == "none" || mode == "inherit") {
        // `inherit` is expected to be resolved app-side before it reaches here.
        if (mode == "inherit") {
            vayu::utils::log_debug (
            "apply_auth: received unresolved 'inherit' auth; skipping");
        }
        return {};
    }

    if (mode == "bearer") {
        if (has_header_ci (req.headers, "Authorization")) {
            return {};
        }
        req.headers["Authorization"] = "Bearer " + field (auth, "token");
        return {};
    }

    if (mode == "basic") {
        if (has_header_ci (req.headers, "Authorization")) {
            return {};
        }
        const std::string creds =
        field (auth, "username") + ":" + field (auth, "password");
        req.headers["Authorization"] =
        "Basic " + vayu::utils::base64_encode (creds);
        return {};
    }

    if (mode == "apikey") {
        const std::string key   = field (auth, "key");
        const std::string value = field (auth, "value");
        if (key.empty ()) {
            return {};
        }
        const std::string in = field (auth, "in");
        if (in == "query") {
            append_query_param (req.url, key, value);
        } else { // default: header
            if (has_header_ci (req.headers, key)) {
                return {};
            }
            req.headers[key] = value;
        }
        return {};
    }

    // oauth2 token resolution and digest/aws/ntlm are not yet executable; they
    // are stored but not applied. Leaving them as no-ops preserves today's
    // behavior until the oauth2 path lands.
    vayu::utils::log_debug ("apply_auth: mode '" + mode +
    "' is not yet applied; sending request without auth");
    return {};
}

} // namespace vayu::http
