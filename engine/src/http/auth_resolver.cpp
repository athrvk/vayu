#include "vayu/http/auth_resolver.hpp"

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/logger.hpp"

#include <string>
#include <type_traits>

namespace vayu::http {

namespace {

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

Auth parse_auth (const nlohmann::json& auth) {
    if (!auth.is_object ()) {
        return NoAuth{};
    }

    const std::string mode = field (auth, "mode");
    if (mode.empty () || mode == "none") {
        return NoAuth{};
    }
    if (mode == "inherit") {
        // Expected to be resolved app-side before reaching the engine.
        vayu::utils::log_debug (
        "parse_auth: received unresolved 'inherit' auth; treating as none");
        return NoAuth{};
    }
    if (mode == "bearer") {
        return BearerAuth{ field (auth, "token") };
    }
    if (mode == "basic") {
        return BasicAuth{ field (auth, "username"), field (auth, "password") };
    }
    if (mode == "apikey") {
        return ApiKeyAuth{ field (auth, "key"), field (auth, "value"),
            field (auth, "in") == "query" };
    }
    if (mode == "oauth2") {
        return OAuth2Auth{ auth.value ("config", nlohmann::json::object ()) };
    }
    return UnsupportedAuth{ mode };
}

AuthApplyResult
apply_auth (vayu::Request& req, const Auth& auth, vayu::db::Database* db) {
    (void) db; // reserved for oauth2 token lookup (next iteration)

    return std::visit (
    [&] (const auto& a) -> AuthApplyResult {
        using T = std::decay_t<decltype (a)>;

        if constexpr (std::is_same_v<T, NoAuth>) {
            return {};
        } else if constexpr (std::is_same_v<T, BearerAuth>) {
            // Headers is case-insensitive, so this covers "authorization" too.
            if (req.headers.count ("Authorization") == 0) {
                req.headers["Authorization"] = "Bearer " + a.token;
            }
            return {};
        } else if constexpr (std::is_same_v<T, BasicAuth>) {
            if (req.headers.count ("Authorization") == 0) {
                req.headers["Authorization"] =
                "Basic " + vayu::utils::base64_encode (a.username + ":" + a.password);
            }
            return {};
        } else if constexpr (std::is_same_v<T, ApiKeyAuth>) {
            if (a.key.empty ()) {
                return {};
            }
            if (a.in_query) {
                append_query_param (req.url, a.key, a.value);
            } else if (req.headers.count (a.key) == 0) {
                req.headers[a.key] = a.value;
            }
            return {};
        } else if constexpr (std::is_same_v<T, OAuth2Auth>) {
            // Token acquisition + injection lands with the oauth2 path; until
            // then this is a no-op (preserves today's behavior).
            vayu::utils::log_debug (
            "apply_auth: oauth2 not yet applied; sending request without auth");
            return {};
        } else {
            static_assert (std::is_same_v<T, UnsupportedAuth>,
            "unhandled Auth variant");
            vayu::utils::log_debug ("apply_auth: mode '" + a.mode +
            "' is not executable; sending request without auth");
            return {};
        }
    },
    auth);
}

AuthApplyResult apply_auth (vayu::Request& req, const nlohmann::json& auth,
vayu::db::Database* db) {
    return apply_auth (req, parse_auth (auth), db);
}

} // namespace vayu::http
