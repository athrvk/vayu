// Copyright (c) 2026 Atharva Kusumbia
// Licensed under AGPL-3.0; see LICENSE in the engine directory.

#include "vayu/http/script_parts.hpp"

namespace vayu::http {

namespace {

bool is_blank (const std::string& s) {
    return s.find_first_not_of (" \t\r\n") == std::string::npos;
}

} // namespace

std::string read_script (const nlohmann::json& json, const char* list_key, const char* legacy_key) {
    if (auto it = json.find (list_key); it != json.end () && it->is_array ()) {
        std::string joined;
        for (const auto& part : *it) {
            if (!part.is_object ())
                continue;
            // A non-string "script" would throw out of .get<std::string>()
            // deep in RunContext's constructor, outside any try - dropping it
            // matches the rule for a missing key or a non-object part.
            if (!part.contains ("script") || !part["script"].is_string ())
                continue;
            const auto& script = part["script"].get<std::string> ();
            if (is_blank (script))
                continue;
            if (!joined.empty ())
                joined += "\n\n";
            joined += script;
        }
        return joined;
    }
    return json.value (legacy_key, std::string{});
}

} // namespace vayu::http
