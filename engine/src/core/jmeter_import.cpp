/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/jmeter_import.cpp
 * @brief The `.jmx` walker and the JMeter-class-to-element-kind mapping table
 *        (issue #1518). See the header for the shape and the validation rule.
 */

#include "vayu/core/jmeter_import.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/elements.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/parse.hpp"

#include <pugixml.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <optional>
#include <regex>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

using json = nlohmann::ordered_json;

// ---------------------------------------------------------------------------
// pugixml property readers - a JMeter test element's own configuration is a
// flat list of `<stringProp name="...">`, `<boolProp name="...">`,
// `<intProp>` / `<longProp>` and `<collectionProp>` / `<elementProp>` children
// directly under it, found by `name`, never by position. A number may be any
// of the scalar tags, flat or nested (`scalar_text`).
// ---------------------------------------------------------------------------

pugi::xml_node find_prop (const pugi::xml_node& element, const char* tag, std::string_view name) {
    for (pugi::xml_node prop : element.children (tag)) {
        if (name == std::string_view (prop.attribute ("name").value ())) {
            return prop;
        }
    }
    return {};
}

std::string string_prop (const pugi::xml_node& element,
std::string_view name,
std::string fallback = "") {
    const pugi::xml_node prop = find_prop (element, "stringProp", name);
    return prop ? std::string (prop.text ().get ()) : std::move (fallback);
}

bool bool_prop (const pugi::xml_node& element, std::string_view name, bool fallback = false) {
    const pugi::xml_node prop = find_prop (element, "boolProp", name);
    if (!prop) {
        return fallback;
    }
    return std::string_view (prop.text ().get ()) == "true";
}

/// Every tag JMeter saves a scalar under. A GUI-saved plan writes a number as a
/// `<stringProp>` (so `${var}` can stand in for it) and a float as a nested
/// `<doubleProp>`; a hand-written one uses `<intProp>` / `<longProp>`.
constexpr auto SCALAR_TAGS = std::to_array<const char*> (
{ "stringProp", "intProp", "longProp", "doubleProp", "FloatProperty" });

/// A property's name: the `name` attribute of the flat form, or the `<name>`
/// child of the nested one (`<doubleProp><name>..</name><value>..</value>
/// </doubleProp>`).
std::string_view scalar_name (const pugi::xml_node& prop) {
    const std::string_view attribute = prop.attribute ("name").value ();
    return attribute.empty () ? std::string_view (prop.child_value ("name")) : attribute;
}

/// The text of the scalar @p name in either form, whatever tag holds it.
std::optional<std::string> scalar_text (const pugi::xml_node& element, std::string_view name) {
    for (const char* tag : SCALAR_TAGS) {
        for (const pugi::xml_node prop : element.children (tag)) {
            if (scalar_name (prop) != name) {
                continue;
            }
            const pugi::xml_node nested = prop.child ("value");
            return std::string ((nested ? nested : prop).text ().get ());
        }
    }
    return std::nullopt;
}

/// True when @p end stops at the string's terminator or only trailing
/// whitespace, so `${var}` and `5${var}` are not numbers.
bool consumed_all (const char* end) {
    return std::ranges::all_of (std::string_view (end),
    [] (char c) { return std::isspace (static_cast<unsigned char> (c)) != 0; });
}

/// The integer @p name holds; nothing when it is absent or not a number (a
/// `${var}` reference, a blank), so the caller decides what that means.
std::optional<long> integer_prop (const pugi::xml_node& element, std::string_view name) {
    const std::optional<std::string> text = scalar_text (element, name);
    if (!text) {
        return std::nullopt;
    }
    char* end         = nullptr;
    const long parsed = std::strtol (text->c_str (), &end, 10);
    if (end == text->c_str () || !consumed_all (end)) {
        return std::nullopt;
    }
    return parsed;
}

long long_prop (const pugi::xml_node& element, std::string_view name, long fallback = 0) {
    return integer_prop (element, name).value_or (fallback);
}

/// The number @p name holds, as `integer_prop`.
std::optional<double> number_prop (const pugi::xml_node& element, std::string_view name) {
    const std::optional<std::string> text = scalar_text (element, name);
    if (!text) {
        return std::nullopt;
    }
    char* end           = nullptr;
    const double parsed = std::strtod (text->c_str (), &end);
    if (end == text->c_str () || !consumed_all (end)) {
        return std::nullopt;
    }
    return parsed;
}

double double_prop (const pugi::xml_node& element, std::string_view name, double fallback = 0.0) {
    return number_prop (element, name).value_or (fallback);
}

pugi::xml_node element_prop (const pugi::xml_node& element, std::string_view name) {
    return find_prop (element, "elementProp", name);
}

pugi::xml_node collection_prop (const pugi::xml_node& element, std::string_view name) {
    return find_prop (element, "collectionProp", name);
}

/// JMeter's `${name}` becomes Vayu's `{{name}}` - a simple variable reference
/// only; a JMeter function call (`${__time()}`, `${__P(prop,default)}`) has
/// no Vayu equivalent and is left exactly as written, which resolves to
/// nothing at send time the same way an unresolved `{{token}}` does.
std::string rewrite_variables (const std::string& text) {
    static const std::regex reference (R"(\$\{([A-Za-z_][A-Za-z0-9_]*)\})");
    return std::regex_replace (text, reference, "{{$1}}");
}

/// A property's text whether JMeter saved it as a `<stringProp>` (a value that
/// may be a `${__P(...)}` call, so it is not parsed) or a number.
std::string text_prop (const pugi::xml_node& element, std::string_view name) {
    for (const char* tag : { "stringProp", "intProp", "longProp" }) {
        if (const pugi::xml_node prop = find_prop (element, tag, name)) {
            return prop.text ().get ();
        }
    }
    return "";
}

/// @p list split on @p separator the way Java's `String.split` does, which is
/// how JMeter reads the `;` lists of a multi-value processor: trailing empty
/// segments are dropped, an inner empty one is kept.
std::vector<std::string> split_list (const std::string& list, char separator) {
    std::vector<std::string> segments;
    size_t start = 0;
    while (start <= list.size ()) {
        const size_t at = list.find (separator, start);
        if (at == std::string::npos) {
            segments.push_back (list.substr (start));
            break;
        }
        segments.push_back (list.substr (start, at - start));
        start = at + 1;
    }
    while (!segments.empty () && segments.back ().empty ()) {
        segments.pop_back ();
    }
    return segments;
}

// ---------------------------------------------------------------------------
// One import context, threaded through the whole walk.
// ---------------------------------------------------------------------------

/// Tally kind for a branch left out because it nests past `MAX_READ_DEPTH`.
constexpr const char* NESTING_TOO_DEEP_KIND = "nesting_too_deep";

/// The HTTP Request Defaults settings a sampler inherits, each trimmed and
/// empty when unset (a blank field is JMeter's "not set", and a `0` timeout its
/// "none"). The text is kept as written so a sampler's own value and a
/// default's are read the same way.
struct HttpDefaults {
    std::string path;
    std::string connect_timeout;
    std::string response_timeout;
};

struct Ctx {
    const ImportOptions& options;
    ImportTally& tally;
    long request_count = 0;
    long folder_count  = 0;
    /// `<hashTree>` levels the walk is currently inside; bounded by
    /// `walk_hash_tree` (#1782).
    size_t depth = 0;
    /// The HTTP Request Defaults in force at the level being walked: every
    /// enclosing level's, the nearer one winning per field (#3217).
    HttpDefaults defaults;
};

/// Where the walk currently appends - a folder and the root collection share
/// this same shape (issue #710's `OperationFolders`, mirrored here rather
/// than reused: that type is `import_document.cpp`'s own anonymous-namespace
/// helper, and a `.jmx` folder's own rules - one elements array per folder,
/// no tag/path naming rule - differ enough that sharing it would fold two
/// unrelated "how does a folder get named" questions into one type).
///
/// A sibling is stamped with its `order` as it is added: samplers and
/// controllers count in one sequence, the document's own, so the two lists
/// flatten back into the plan's tree order (#2573). The counter belongs to the
/// collection being built, not to the sink: a `ThreadGroup` hands its parent's
/// sink on, and its members continue the parent's numbering.
struct Sink {
    json& requests;
    json& children;
    json& elements;
    json& variables;
    int& next_order;

    void add_request (json request) {
        request["order"] = next_order++;
        requests.push_back (std::move (request));
    }

    void add_folder (json folder) {
        folder["order"] = next_order++;
        children.push_back (std::move (folder));
    }
};

/// One `{kind, config}` pair, validated before it is offered to a sink -
/// never a bare `json` a caller could push unchecked.
using KindConfig = std::pair<std::string, json>;

/// What one JMeter element expands to: a multi-value JSON Extractor or a
/// Response Assertion with several patterns is several Vayu elements.
using KindConfigs = std::vector<KindConfig>;

/**
 * @p config against the live registry, as the one element of a throwaway
 * array (`Registry::validate` takes the whole list a request or collection
 * would carry). `ElementOwner::Collection` throughout: the only owner
 * restriction the registry enforces is `collection_only` refusing a
 * *request* owner, so validating as a collection is the strictly more
 * permissive check and never wrongly accepts something a request placement
 * would refuse - nothing this parser builds is placement-sensitive in the
 * other direction.
 */
std::optional<json> make_valid_element (Ctx& ctx, const std::string& kind, json config) {
    const json candidate = json::array ({ json{ { "id", "el_check" },
    { "kind", kind }, { "enabled", true }, { "config", config } } });
    if (Registry::instance ().validate (candidate, ElementOwner::Collection)) {
        ctx.tally.add (kind + "_unmappable");
        return std::nullopt;
    }
    // `std::make_optional`, not a bare `json{...}` return: nlohmann's own
    // `operator ValueType()` template competes with `optional`'s converting
    // constructor for an implicit return conversion (`-Wconversion`);
    // direct-initializing considers the constructor alone.
    return std::make_optional (
    json{ { "kind", kind }, { "enabled", true }, { "config", std::move (config) } });
}

// ---------------------------------------------------------------------------
// Leaf kinds: extractors, assertions, timers - JMeter class -> {kind, config}.
// ---------------------------------------------------------------------------

/// The @p index-th segment of @p list, `""` past its end.
const std::string& segment_at (const std::vector<std::string>& list, size_t index) {
    static const std::string none;
    return index < list.size () ? list[index] : none;
}

/// A `;`-listed match number; one that is blank or not a number is JMeter's
/// first match.
long match_number_at (const std::vector<std::string>& list, size_t index) {
    const std::string& text = segment_at (list, index);
    char* end               = nullptr;
    const long parsed       = std::strtol (text.c_str (), &end, 10);
    return end != text.c_str () ? parsed : 1;
}

/// One `extract.json` per reference-name / path pair of a JSON Extractor,
/// which JMeter configures as parallel `;`-separated lists. The default values
/// and match numbers are read by the same index; a list that ends early leaves
/// the rest with no fallback and the first match. Names and paths of unequal
/// length, or an empty name or path inside the lists, pair nothing - JMeter
/// refuses such a processor at run time too - so the caller counts the
/// processor as unrecognised rather than guessing which name goes with which
/// path.
KindConfigs parse_json_extractors (const pugi::xml_node& el) {
    const std::vector<std::string> variables =
    split_list (text_prop (el, "JSONPostProcessor.referenceNames"), ';');
    const std::vector<std::string> paths =
    split_list (text_prop (el, "JSONPostProcessor.jsonPathExprs"), ';');
    if (variables.size () != paths.size ()) {
        return {};
    }
    const std::vector<std::string> fallbacks =
    split_list (text_prop (el, "JSONPostProcessor.defaultValues"), ';');
    const std::vector<std::string> match_numbers =
    split_list (text_prop (el, "JSONPostProcessor.match_numbers"), ';');

    KindConfigs configs;
    for (size_t i = 0; i < variables.size (); ++i) {
        if (variables[i].empty () || paths[i].empty ()) {
            return {};
        }
        json config = { { "path", paths[i] }, { "variable", variables[i] },
            { "matchNo", match_number_at (match_numbers, i) } };
        if (const std::string& fallback = segment_at (fallbacks, i); !fallback.empty ()) {
            config["default"] = fallback;
        }
        configs.emplace_back ("extract.json", std::move (config));
    }
    return configs;
}

std::optional<KindConfig> parse_regex_extractor (const pugi::xml_node& el) {
    const std::string variable = string_prop (el, "RegexExtractor.refname");
    const std::string pattern  = string_prop (el, "RegexExtractor.regex");
    if (variable.empty () || pattern.empty ()) {
        return std::nullopt;
    }
    json config = { { "pattern", pattern },
        { "template", string_prop (el, "RegexExtractor.template", "$1$") },
        { "variable", variable },
        { "matchNo", long_prop (el, "RegexExtractor.match_number", 1) } };
    if (string_prop (el, "RegexExtractor.useHeaders", "false") == "true") {
        config["field"] = "headers";
    }
    if (const std::string fallback = string_prop (el, "RegexExtractor.default");
    !fallback.empty ()) {
        config["default"] = fallback;
    }
    return KindConfig{ "extract.regex", std::move (config) };
}

std::optional<KindConfig> parse_boundary_extractor (const pugi::xml_node& el) {
    const std::string variable = string_prop (el, "BoundaryExtractor.refname");
    if (variable.empty ()) {
        return std::nullopt;
    }
    json config = { { "leftBoundary", string_prop (el, "BoundaryExtractor.lboundary") },
        { "rightBoundary", string_prop (el, "BoundaryExtractor.rboundary") },
        { "variable", variable },
        { "matchNo", long_prop (el, "BoundaryExtractor.match_number", 1) } };
    return KindConfig{ "extract.boundary", std::move (config) };
}

/// JMeter's Response Assertion carries its match texts under a
/// `collectionProp` whose own name is `Asserion.test_strings` - a typo in
/// JMeter's own XML schema, present in every `.jmx` file JMeter itself has
/// ever written, so a reader that "fixes" it reads nothing back.
///
/// `Assertion.test_type` is a bitmask (1 Matches, 2 Contains, 4 Not, 8 Equals,
/// 16 Substring, 32 Or). Several patterns without Or all have to hold, so each
/// becomes its own `assert.contains` carrying the same mode and Not. Every
/// refusal path here - an unmapped test field, a
/// response-code assertion with Not set (`assert.status` has no `negate`), an
/// Or assertion with more than one pattern (no Vayu kind expresses "any of
/// these") - is tallied under `ResponseAssertion_unrecognised`, the same kind
/// the caller's generic fallback uses, except the Or case, which is distinct
/// enough (a mapping this parser understands but cannot express) to get its
/// own `ResponseAssertion_or` tally instead.
KindConfigs parse_response_assertions (Ctx& ctx, const pugi::xml_node& el) {
    pugi::xml_node strings = collection_prop (el, "Asserion.test_strings");
    if (!strings) {
        strings = collection_prop (el, "Assertion.test_strings");
    }
    std::vector<std::string> texts;
    for (const pugi::xml_node value : strings.children ("stringProp")) {
        texts.emplace_back (value.text ().get ());
    }
    if (texts.empty ()) {
        ctx.tally.add ("ResponseAssertion_unrecognised");
        return {};
    }

    const long test_type = long_prop (el, "Assertion.test_type", 2);
    const bool negate    = (test_type & 4) != 0;

    const std::string field =
    string_prop (el, "Assertion.test_field", "Assertion.response_data");
    if (field == "Assertion.response_code") {
        if (negate) {
            ctx.tally.add ("ResponseAssertion_unrecognised");
            return {};
        }
        json codes = json::array ();
        for (const std::string& text : texts) {
            char* end       = nullptr;
            const long code = std::strtol (text.c_str (), &end, 10);
            if (end != text.c_str ()) {
                codes.push_back (static_cast<int> (code));
            }
        }
        if (codes.empty ()) {
            ctx.tally.add ("ResponseAssertion_unrecognised");
            return {};
        }
        return KindConfigs{ { "assert.status", json{ { "in", std::move (codes) } } } };
    }

    // Or with more than one pattern means "any of these"; the mapper can only
    // emit one `assert.contains` row, which would mean "all of these" instead.
    // A single pattern with Or set is just that pattern.
    if ((test_type & 32) != 0 && texts.size () > 1) {
        ctx.tally.add ("ResponseAssertion_or");
        return {};
    }

    // Pattern kind by bit, in JMeter's own precedence: Equals first, then
    // Substring (a plain text contains), then Matches or Contains (both a
    // regular-expression search in JMeter, so both land on `matches`).
    std::string mode;
    if ((test_type & 8) != 0) {
        mode = "equals";
    } else if ((test_type & 16) != 0) {
        mode = "contains";
    } else {
        mode = "matches";
    }

    std::string target;
    if (field == "Assertion.response_headers") {
        target = "headers";
    } else if (field == "Assertion.sample_label") {
        // JMeter's "URL Sampled" - the request's own URL, `assert.contains`'s
        // "url" field.
        target = "url";
    } else if (field.empty () || field == "Assertion.response_data") {
        target = "body";
    } else {
        // Request Data, Request Headers, Response Message, or Document (a
        // parsed-DOM view of the body) - none has an `assert.contains` field
        // to land on. Guessing "body" would assert against text the source
        // never named as its target; refused instead, tallied the same way
        // any other recognised class this parser could not extract enough
        // from is.
        ctx.tally.add ("ResponseAssertion_unrecognised");
        return {};
    }
    // Every pattern must hold, so each is its own assertion: they pass and
    // fail (and, under Not, invert) independently, and one a pattern RE2
    // refuses drops only itself.
    KindConfigs configs;
    for (const std::string& text : texts) {
        configs.emplace_back ("assert.contains",
        json{ { "field", target }, { "text", text }, { "mode", mode }, { "negate", negate } });
    }
    return configs;
}

std::optional<KindConfig> parse_duration_assertion (const pugi::xml_node& el) {
    const std::string duration = string_prop (el, "DurationAssertion.duration");
    if (duration.empty ()) {
        return std::nullopt;
    }
    char* end           = nullptr;
    const double max_ms = std::strtod (duration.c_str (), &end);
    if (end == duration.c_str ()) {
        return std::nullopt;
    }
    return KindConfig{ "assert.duration", json{ { "maxMs", max_ms } } };
}

std::optional<KindConfig> parse_size_assertion (const pugi::xml_node& el) {
    const std::string size = string_prop (el, "SizeAssertion.size");
    if (size.empty ()) {
        return std::nullopt;
    }
    char* end        = nullptr;
    const long bytes = std::strtol (size.c_str (), &end, 10);
    if (end == size.c_str ()) {
        return std::nullopt;
    }
    // JMeter's own operator codes: 1 Equal, 2 NotEqual, 3 Greater, 4
    // GreaterEqual (or Less/LessEqual on some versions) - the exact numbering
    // has drifted across JMeter releases, so only the unambiguous Equal case
    // is mapped precisely; anything else keeps `assert.size`'s own default.
    const long op = long_prop (el, "SizeAssertion.operator", 1);
    return KindConfig{ "assert.size",
        json{ { "bytes", bytes }, { "op", op == 1 ? "eq" : "lte" } } };
}

std::optional<KindConfig> parse_jsonpath_assertion (const pugi::xml_node& el) {
    const std::string path = string_prop (el, "JSON_PATH");
    if (path.empty ()) {
        return std::nullopt;
    }
    json config = { { "path", path } };
    if (bool_prop (el, "INVERT", false)) {
        config["negate"] = true;
    }
    if (const std::string expected = string_prop (el, "EXPECTED_VALUE");
    bool_prop (el, "JSONVALIDATION", false) && !expected.empty ()) {
        config["expected"] = expected;
    } else {
        config["exists"] = true;
    }
    return KindConfig{ "assert.jsonpath", std::move (config) };
}

std::optional<KindConfig> parse_constant_timer (const pugi::xml_node& el) {
    const std::string delay = string_prop (el, "ConstantTimer.delay");
    if (delay.empty ()) {
        return std::nullopt;
    }
    char* end     = nullptr;
    const long ms = std::strtol (delay.c_str (), &end, 10);
    if (end == delay.c_str ()) {
        return std::nullopt;
    }
    return KindConfig{ "timer.think", json{ { "ms", ms } } };
}

/// The two numbers a random timer is built from: the constant offset JMeter
/// shares with the Constant Timer (`ConstantTimer.delay`) and the random
/// spread (`RandomTimer.range`). Either missing or not a number (a `${var}`)
/// refuses the timer rather than inventing a 0ms wait.
struct RandomTimerBounds {
    double base;
    double range;
};

std::optional<RandomTimerBounds> random_timer_bounds (const pugi::xml_node& el) {
    const std::optional<double> base  = number_prop (el, "ConstantTimer.delay");
    const std::optional<double> range = number_prop (el, "RandomTimer.range");
    if (!base || !range) {
        return std::nullopt;
    }
    return RandomTimerBounds{ *base, *range };
}

std::optional<KindConfig> parse_uniform_random_timer (const pugi::xml_node& el) {
    const std::optional<RandomTimerBounds> bounds = random_timer_bounds (el);
    if (!bounds) {
        return std::nullopt;
    }
    return KindConfig{ "timer.think",
        json{ { "minMs", static_cast<long> (bounds->base) },
        { "maxMs", static_cast<long> (bounds->base + bounds->range) } } };
}

std::optional<KindConfig> parse_gaussian_random_timer (const pugi::xml_node& el) {
    const std::optional<RandomTimerBounds> bounds = random_timer_bounds (el);
    if (!bounds) {
        return std::nullopt;
    }
    return KindConfig{ "timer.think",
        json{ { "gaussian",
        json{ { "meanMs", bounds->base }, { "deviationMs", bounds->range } } } } };
}

/// JMeter's rate is samples per minute by default - the exact unit
/// `timer.pacing`'s own `everyMs` needs, once inverted.
std::optional<KindConfig> parse_constant_throughput_timer (const pugi::xml_node& el) {
    const double throughput = double_prop (el, "throughput");
    if (throughput <= 0.0) {
        return std::nullopt;
    }
    const long every_ms = std::max<long> (std::lround (60000.0 / throughput), 1);
    // `calcMode` 0 is "this thread only" (JMeter's per-user pacing); every
    // other mode shares the rate across threads, which is `perUser: false`.
    const bool per_user = long_prop (el, "calcMode", 0) == 0;
    return KindConfig{ "timer.pacing",
        json{ { "everyMs", every_ms }, { "perUser", per_user } } };
}

/// JSR223 and BeanShell pre/post-processors both carry their body under a
/// `script` string prop; imported **disabled**, per the issue's own mapping
/// table, since a Groovy or BeanShell script is not JavaScript and running it
/// as one would be silent nonsense rather than a refused import.
std::optional<KindConfig> parse_script_processor (const pugi::xml_node& el, const char* kind) {
    std::string body = string_prop (el, "script");
    if (body.empty ()) {
        body = "// Imported disabled: this JMeter script is not JavaScript "
               "and was not translated.";
    }
    return KindConfig{ kind, json{ { "script", body } } };
}

/// Every element of @p configs offered to the registry; one it refuses is
/// tallied by `make_valid_element` and the others still import.
std::vector<json> validated_elements (Ctx& ctx, KindConfigs configs) {
    std::vector<json> built;
    for (KindConfig& config : configs) {
        if (auto element =
            make_valid_element (ctx, config.first, std::move (config.second))) {
            built.push_back (std::move (*element));
        }
    }
    return built;
}

/// @p kc as the zero-or-one configs a single-element parser expands to.
KindConfigs at_most_one (std::optional<KindConfig> kc) {
    KindConfigs configs;
    if (kc) {
        configs.push_back (std::move (*kc));
    }
    return configs;
}

/// Every `.jmx` config element this parser has an element-kind mapping for -
/// the recognised half of the flat dispatch in `dispatch_child` below.
/// Returns nothing both for an unrecognised @p tag and for one this
/// parser recognises but could not extract enough from (an empty pattern, an
/// unparsable number). Every refusal is tallied exactly once, here: the bare
/// tag for one no parser looked at, the parser's own kind (`_unrecognised`,
/// `_or`, `_unmappable`) for one it did, so the caller counts nothing.
std::vector<json>
build_leaf_elements (Ctx& ctx, std::string_view tag, const pugi::xml_node& el) {
    // `parse_response_assertions` tallies its own refusals (either the shared
    // `_unrecognised` kind or its own `ResponseAssertion_or`), so it is kept
    // out of the generic empty-result tally below.
    if (tag == "ResponseAssertion") {
        return validated_elements (ctx, parse_response_assertions (ctx, el));
    }
    KindConfigs configs;
    if (tag == "JSONPostProcessor") {
        configs = parse_json_extractors (el);
    } else if (tag == "RegexExtractor") {
        configs = at_most_one (parse_regex_extractor (el));
    } else if (tag == "BoundaryExtractor") {
        configs = at_most_one (parse_boundary_extractor (el));
    } else if (tag == "DurationAssertion") {
        configs = at_most_one (parse_duration_assertion (el));
    } else if (tag == "SizeAssertion") {
        configs = at_most_one (parse_size_assertion (el));
    } else if (tag == "JSONPathAssertion") {
        configs = at_most_one (parse_jsonpath_assertion (el));
    } else if (tag == "ConstantTimer") {
        configs = at_most_one (parse_constant_timer (el));
    } else if (tag == "UniformRandomTimer") {
        configs = at_most_one (parse_uniform_random_timer (el));
    } else if (tag == "GaussianRandomTimer") {
        configs = at_most_one (parse_gaussian_random_timer (el));
    } else if (tag == "ConstantThroughputTimer") {
        configs = at_most_one (parse_constant_throughput_timer (el));
    } else if ((tag == "JSR223PreProcessor" || tag == "BeanShellPreProcessor") &&
    ctx.options.import_scripts) {
        configs = at_most_one (parse_script_processor (el, "script.pre"));
    } else if ((tag == "JSR223PostProcessor" || tag == "BeanShellPostProcessor") &&
    ctx.options.import_scripts) {
        configs = at_most_one (parse_script_processor (el, "script.post"));
    } else {
        // No parser looked at this tag; the bare tag is its only tally.
        ctx.tally.add (std::string (tag));
        return {};
    }
    if (configs.empty ()) {
        ctx.tally.add (std::string (tag) + "_unrecognised");
        return {};
    }
    return validated_elements (ctx, std::move (configs));
}

// ---------------------------------------------------------------------------
// Folder-shaping controllers - JMeter class -> a folder plus its own
// `control.*` element, or `std::nullopt` when this parser has no faithful
// translation (a plain grouping folder is still created either way).
// ---------------------------------------------------------------------------

/// `"${name}" == "value"` or `${name} != value` - the two shapes JMeter's own
/// If Controller UI produces for a simple comparison - into `control.if`'s
/// `{{name}} == value` grammar. Anything else (a JavaScript expression, a
/// function call, `&&`/`||`) has no translation and is left unmapped, which
/// still imports the folder as a plain grouping.
std::optional<std::string> translate_if_condition (const std::string& condition) {
    static const std::regex simple (
    R"re(^\s*"?\$\{([A-Za-z_][A-Za-z0-9_]*)\}"?\s*(==|!=)\s*"?([^"]*?)"?\s*$)re");
    std::smatch match;
    if (!std::regex_match (condition, match, simple)) {
        return std::nullopt;
    }
    return "{{" + match[1].str () + "}} " + match[2].str () + " " + match[3].str ();
}

/// `ThroughputController.style` 1 is "Percent Executions", the only style
/// `control.throughput` expresses. Style 0 caps the *number* of executions
/// (`maxThroughput`), which has no percent to import; it is refused so the
/// caller tallies it instead of reading a stale or default percent as if it
/// were the plan's intent. An absent style is read as percent, as hand-written
/// plans leave it out.
std::optional<KindConfig> parse_throughput_controller (const pugi::xml_node& el) {
    constexpr long TOTAL_EXECUTIONS_STYLE = 0;
    if (long_prop (el, "ThroughputController.style", 1) == TOTAL_EXECUTIONS_STYLE) {
        return std::nullopt;
    }
    constexpr const char* PERCENT = "ThroughputController.percentThroughput";
    const double percent          = double_prop (el, PERCENT, 100.0);
    return KindConfig{ "control.throughput", json{ { "percent", percent } } };
}

std::optional<KindConfig> parse_controller (std::string_view tag, const pugi::xml_node& el) {
    if (tag == "LoopController") {
        const long count = long_prop (el, "LoopController.loops", -1);
        // JMeter's "forever" is `-1`; `control.loop` has no such value.
        if (count <= 0) {
            return std::nullopt;
        }
        return KindConfig{ "control.loop", json{ { "count", count } } };
    }
    if (tag == "IfController") {
        auto translated =
        translate_if_condition (string_prop (el, "IfController.condition"));
        if (!translated) {
            return std::nullopt;
        }
        return KindConfig{ "control.if", json{ { "condition", *translated } } };
    }
    if (tag == "OnceOnlyController") {
        return KindConfig{ "control.once", json::object () };
    }
    if (tag == "TransactionController") {
        return KindConfig{ "control.transaction",
            json{ { "name", el.attribute ("testname").as_string ("Transaction") } } };
    }
    if (tag == "ThroughputController") {
        return parse_throughput_controller (el);
    }
    // `SwitchController` selects by list index or a JMeter variable, neither
    // of which maps onto `control.switch`'s named-case grammar without
    // inventing case names JMeter never declared - left unmapped; the folder
    // still imports as a plain grouping, tallied by the caller like any other
    // recognised class this parser could not extract enough from.
    return std::nullopt;
}

// ---------------------------------------------------------------------------
// Arguments (`Arguments.arguments`, `HTTPsampler.Arguments`) - one
// name/value walk shared by User Defined Variables, HTTP defaults and a
// sampler's own body/query parameters.
// ---------------------------------------------------------------------------

std::vector<std::pair<std::string, std::string>> argument_pairs (
const pugi::xml_node& arguments_node) {
    std::vector<std::pair<std::string, std::string>> pairs;
    const pugi::xml_node values = collection_prop (arguments_node, "Arguments.arguments");
    for (const pugi::xml_node argument : values.children ("elementProp")) {
        pairs.emplace_back (string_prop (argument, "Argument.name"),
        rewrite_variables (string_prop (argument, "Argument.value")));
    }
    return pairs;
}

void merge_arguments_into_variables (const pugi::xml_node& arguments_node, json& variables) {
    for (const auto& [name, value] : argument_pairs (arguments_node)) {
        if (name.empty ()) {
            continue;
        }
        variables[name] = json{ { "value", value }, { "enabled", true } };
    }
}

/// @p text without the whitespace around it.
std::string trimmed (std::string_view text) {
    constexpr std::string_view SPACE = " \t\r\n";
    const size_t begin               = text.find_first_not_of (SPACE);
    if (begin == std::string_view::npos) {
        return "";
    }
    return std::string (text.substr (begin, text.find_last_not_of (SPACE) - begin + 1));
}

/// The scheme JMeter would use: an empty or blank `HTTPSampler.protocol` is
/// what its GUI saves for a field left unset, and it means `http`, the same as
/// the property being absent (#3191).
std::string protocol_of (const pugi::xml_node& el) {
    std::string protocol = trimmed (string_prop (el, "HTTPSampler.protocol"));
    return protocol.empty () ? "http" : protocol;
}

std::string base_url_of (const pugi::xml_node& el) {
    const std::string domain = string_prop (el, "HTTPSampler.domain");
    if (domain.empty ()) {
        return "";
    }
    std::string base = protocol_of (el) + "://" + domain;
    if (const std::string port = string_prop (el, "HTTPSampler.port");
    !port.empty () && port != "0") {
        base += ":" + port;
    }
    return base;
}

/// Tally kind for a request whose timeout text is not a whole number of
/// milliseconds (a `${var}`): that part is left out of `timeout`.
constexpr std::string_view TIMEOUT_UNRECOGNISED_KIND =
"HTTPSampler_timeout_unrecognised";

/// Tally kind for a request with both a connect and a response timeout: Vayu
/// has the one total, so they are added, and the request is named.
constexpr std::string_view TIMEOUT_TOTAL_KIND = "Timeout_total";

/// A request's `timeout` ceiling, as the requests API validates it
/// (`REQUEST_TIMEOUT_FIELD`, `http/request_exchange.hpp`).
constexpr long long MAX_REQUEST_TIMEOUT_MS = 86400000;

/// The path and timeouts @p el carries under the property names a sampler and
/// an HTTP Request Defaults element share.
HttpDefaults http_settings_of (const pugi::xml_node& el) {
    return { trimmed (string_prop (el, "HTTPSampler.path")),
        trimmed (text_prop (el, "HTTPSampler.connect_timeout")),
        trimmed (text_prop (el, "HTTPSampler.response_timeout")) };
}

/// @p outer with every field @p inner sets laid over it.
HttpDefaults overlaid (HttpDefaults outer, const HttpDefaults& inner) {
    const auto take = [] (std::string& field, const std::string& value) {
        if (!value.empty ()) {
            field = value;
        }
    };
    take (outer.path, inner.path);
    take (outer.connect_timeout, inner.connect_timeout);
    take (outer.response_timeout, inner.response_timeout);
    return outer;
}

bool is_http_defaults (const pugi::xml_node& el) {
    return std::string_view (el.name ()) == "ConfigTestElement" &&
    std::string_view (el.attribute ("guiclass").value ()) == "HttpDefaultsGui";
}

/// An HTTP Request Defaults element: its `protocol://domain[:port]` becomes
/// the `baseUrl` variable a sampler with no domain of its own reads, `${x}`
/// references rewritten like any other value (#3191). Its path and timeouts
/// are not variables: `defaults_in_scope` carries them to the samplers below.
void merge_http_defaults (const pugi::xml_node& el, json& variables) {
    if (const std::string base = base_url_of (el); !base.empty ()) {
        variables["baseUrl"] =
        json{ { "value", rewrite_variables (base) }, { "enabled", true } };
    }
}

// ---------------------------------------------------------------------------
// The walk itself.
// ---------------------------------------------------------------------------

/// Whether a JMeter element runs at all - the `enabled="false"` attribute the
/// GUI writes when a user toggles an element off. Absent means true, JMeter's
/// own default for an element the format never bothered to state either way.
bool jmeter_enabled (const pugi::xml_node& el) {
    return el.attribute ("enabled").as_bool (true);
}

/// A `<hashTree>`'s direct children, paired: a test element followed by its
/// own (possibly empty) `<hashTree>`, in document order - JMeter's own
/// serialization shape. @p visit receives the element and that following
/// tree, an empty node when there is none, and sees a disabled element too.
template <typename Visit>
void for_each_pair (const pugi::xml_node& hash_tree, Visit&& visit) {
    pugi::xml_node child = hash_tree.first_child ();
    while (child) {
        if (std::string_view (child.name ()) == "hashTree") {
            // A stray hashTree with nothing before it - malformed input;
            // step over it rather than misreading it as some element's own.
            child = child.next_sibling ();
            continue;
        }
        const pugi::xml_node element = child;
        pugi::xml_node own_tree;
        pugi::xml_node next = child.next_sibling ();
        if (next && std::string_view (next.name ()) == "hashTree") {
            own_tree = next;
            next     = next.next_sibling ();
        }
        visit (element, own_tree);
        child = next;
    }
}

/// `for_each_pair` over the enabled elements only.
///
/// A disabled element - and everything nested under it, since JMeter itself
/// never runs a disabled element's children either - is skipped here rather
/// than by each caller: this is the one place every walk in the file passes
/// through, so a caller cannot forget the check the way a request the user
/// turned off silently reappearing as active on import would suggest one did.
/// Each disabled element met is tallied, so a pre-pass over the same tree
/// reads `for_each_pair` and checks `jmeter_enabled` itself rather than tally
/// it twice.
template <typename Visit>
void for_each_paired_child (Ctx& ctx, const pugi::xml_node& hash_tree, Visit&& visit) {
    for_each_pair (hash_tree,
    [&] (const pugi::xml_node& element, const pugi::xml_node& own_tree) {
        if (!jmeter_enabled (element)) {
            ctx.tally.add (std::string (element.name ()) + "_disabled");
            return;
        }
        visit (element, own_tree);
    });
}

json make_folder () {
    return json{ { "name", "" }, { "description", "" },
        { "variables", json::object () }, { "auth", json{ { "mode", "none" } } },
        { "children", json::array () }, { "requests", json::array () } };
}

void walk_hash_tree (const pugi::xml_node& hash_tree, Sink sink, Ctx& ctx);

/// What the import takes from, or must report of, a setup/teardown thread
/// group. JMeter has no scripting concept for one: the only thing carried out
/// is a JSR223/BeanShell element found directly inside it, concatenated if more
/// than one exists. Its samplers (a realistic "log in during setup" plan) have
/// no `script.setup`/`.teardown` equivalent, and importing them as requests
/// would run them on every pass instead of once.
struct GroupContents {
    /// The bodies of the JSR223/BeanShell elements directly inside, joined.
    std::string script;
    /// Every sampler at any depth, a scripted one included.
    int samplers = 0;
    /// The samplers among them whose body went into `script`.
    int scripted_samplers = 0;
};

bool is_group_script_tag (std::string_view tag) {
    return tag == "JSR223PreProcessor" || tag == "JSR223PostProcessor" ||
    tag == "JSR223Sampler" || tag == "BeanShellPreProcessor" ||
    tag == "BeanShellPostProcessor" || tag == "BeanShellSampler";
}

/// JMeter names its samplers `HTTPSamplerProxy`, `JDBCSampler`, ... with the
/// one exception of the Flow Control Action, `TestAction`.
bool is_sampler_tag (std::string_view tag) {
    return tag == "TestAction" || tag.ends_with ("Sampler") || tag.ends_with ("SamplerProxy");
}

/// @p tree's elements into @p found; only the group's own children
/// (@p direct) can lend it a script, but a sampler is counted however deep a
/// controller nests it. This is the group's one walk: a second would tally an
/// element switched off in JMeter twice.
void scan_group_tree (Ctx& ctx, const pugi::xml_node& tree, bool direct, GroupContents& found) {
    if (ctx.depth >= constants::spec_document::MAX_READ_DEPTH) {
        ctx.tally.add (NESTING_TOO_DEEP_KIND);
        return;
    }
    ++ctx.depth;
    for_each_paired_child (
    ctx, tree, [&] (const pugi::xml_node& el, const pugi::xml_node& own_tree) {
        const std::string_view tag = el.name ();
        const bool sampler         = is_sampler_tag (tag);
        if (sampler) {
            ++found.samplers;
        }
        if (direct && is_group_script_tag (tag)) {
            if (const std::string body = string_prop (el, "script"); !body.empty ()) {
                found.script += (found.script.empty () ? "" : "\n\n") + body;
                found.scripted_samplers += sampler ? 1 : 0;
            }
        }
        if (own_tree && !sampler) {
            scan_group_tree (ctx, own_tree, false, found);
        }
    });
    --ctx.depth;
}

/// A `HeaderManager`'s own rows, rewritten the same way any other value is.
json header_manager_rows (const pugi::xml_node& header_manager) {
    json headers = json::array ();
    const pugi::xml_node list = collection_prop (header_manager, "HeaderManager.headers");
    for (const pugi::xml_node header : list.children ("elementProp")) {
        headers.push_back (json{ { "key", string_prop (header, "Header.name") },
        { "value", rewrite_variables (string_prop (header, "Header.value")) },
        { "description", "" }, { "enabled", true } });
    }
    return headers;
}

/// `HTTPsampler.Files` (`HTTPFileArgs`/`HTTPFileArg`) as `form-data` parts,
/// reusing `imported_file_part`'s shape (issue #1657) rather than a second
/// one. Nested inside the sampler itself rather than a sibling tag
/// `for_each_paired_child` would tally on its own, so a file arg with no
/// usable name - nothing for the field to key on, the same "nothing dropped
/// quietly" rule the sibling-tag fallback follows - is tallied here instead
/// of imported as a nameless row.
json jmeter_file_fields (Ctx& ctx, const pugi::xml_node& el) {
    json fields                = json::array ();
    const pugi::xml_node files = element_prop (el, "HTTPsampler.Files");
    if (!files) {
        return fields;
    }
    for (const pugi::xml_node file_arg :
    collection_prop (files, "HTTPFileArgs.files").children ("elementProp")) {
        const std::string param_name = string_prop (file_arg, "File.paramname");
        if (param_name.empty ()) {
            ctx.tally.add ("HTTPsampler.Files");
            continue;
        }
        const std::string mime_type = string_prop (file_arg, "File.mimetype");
        fields.push_back (
        imported_file_part (json{ { "key", param_name }, { "value", "" },
                            { "description", "" }, { "enabled", true } },
        string_prop (file_arg, "File.path"), mime_type.empty () ? nullptr : &mime_type));
    }
    return fields;
}

/// A sampler's arguments as table rows.
json argument_rows (const std::vector<std::pair<std::string, std::string>>& pairs) {
    json rows = json::array ();
    for (const auto& [key, value] : pairs) {
        rows.push_back (json{ { "key", key }, { "value", value },
        { "description", "" }, { "enabled", true } });
    }
    return rows;
}

/// Whether JMeter appends a sampler's arguments to the URL's query for
/// @p method, rather than sending them as the request body. Only the methods
/// with no body go in the query; every other one (POST, PUT, PATCH, a custom
/// verb) sends them as the body.
bool arguments_go_in_query (std::string_view method) {
    const std::string name = vayu::utils::ascii_upper (trimmed (method));
    return name == "GET" || name == "DELETE" || name == "HEAD" || name == "OPTIONS";
}

/// A sampler's own `HTTPsampler.Arguments` and `HTTPsampler.Files`, as the
/// shape JMeter sends them in:
///
/// - file parts: a `form-data` body, with any regular arguments folded in
///   beside them (a file has no query-string or raw-body form to take instead,
///   so multipart is the only wire form it has, flag or no flag);
/// - `HTTPSampler.postBodyRaw` with at least one argument: the raw-body case,
///   the first argument's value as a `text` body, whatever the method;
/// - otherwise by @p method: `params` rows for GET, DELETE, HEAD and OPTIONS,
///   a body for every other one - `form-data` when
///   `HTTPSampler.DO_MULTIPART_POST` is set, `x-www-form-urlencoded` if not
///   (#3191). Rows left in `params` for a POST would be joined into the URL's
///   query, which is not where JMeter sends them.
void apply_sampler_arguments (Ctx& ctx,
const pugi::xml_node& el,
std::string_view method,
json& params,
json& body) {
    json file_fields               = jmeter_file_fields (ctx, el);
    const pugi::xml_node arguments = element_prop (el, "HTTPsampler.Arguments");
    const auto pairs               = argument_pairs (arguments);
    json rows                      = argument_rows (pairs);

    if (!file_fields.empty ()) {
        for (json& row : rows) {
            file_fields.push_back (std::move (row));
        }
        body = json{ { "mode", "form-data" }, { "fields", std::move (file_fields) } };
        return;
    }
    if (!arguments) {
        return;
    }
    if (bool_prop (el, "HTTPSampler.postBodyRaw", false) && !pairs.empty ()) {
        body = json{ { "mode", "text" }, { "content", pairs.front ().second } };
        return;
    }
    if (arguments_go_in_query (method)) {
        params = std::move (rows);
        return;
    }
    if (rows.empty ()) {
        return;
    }
    const bool multipart = bool_prop (el, "HTTPSampler.DO_MULTIPART_POST", false);
    body = json{ { "mode", multipart ? "form-data" : "x-www-form-urlencoded" },
        { "fields", std::move (rows) } };
}

/// Whatever a sampler's own `<hashTree>` scopes to it alone: a `HeaderManager`
/// merged into @p headers, any recognised extractor/assertion/timer/processor
/// into @p elements, everything else tallied once by `build_leaf_elements`.
void collect_sampler_scope (Ctx& ctx, const pugi::xml_node& own_tree, json& headers, json& elements) {
    for_each_paired_child (
    ctx, own_tree, [&] (const pugi::xml_node& child, const pugi::xml_node&) {
        const std::string_view tag = child.name ();
        if (tag == "HeaderManager") {
            for (auto& header : header_manager_rows (child)) {
                headers.push_back (std::move (header));
            }
            return;
        }
        for (json& built : build_leaf_elements (ctx, tag, child)) {
            elements.push_back (std::move (built));
        }
    });
}

/// The timeout part @p text names, in milliseconds: nothing for JMeter's blank
/// and `0` ("none"). Text that is not a whole non-negative number (a `${var}`)
/// is nothing too and sets @p unreadable.
long long timeout_part_ms (const std::string& text, bool& unreadable) {
    if (text.empty ()) {
        return 0;
    }
    const std::optional<long long> parsed = vayu::utils::parse_number<long long> (text);
    if (!parsed || *parsed < 0) {
        unreadable = true;
        return 0;
    }
    return std::min (*parsed, MAX_REQUEST_TIMEOUT_MS);
}

/// The request's `timeout` from the connect and response timeouts in force for
/// it, their sum since Vayu has the one total. Absent for none, so the request
/// keeps the `defaultTimeout` setting (#2937); never `0`.
void stamp_timeout (Ctx& ctx, const HttpDefaults& effective, json& request) {
    bool unreadable = false;
    const long long connect = timeout_part_ms (effective.connect_timeout, unreadable);
    const long long response = timeout_part_ms (effective.response_timeout, unreadable);
    if (unreadable) {
        ctx.tally.add (TIMEOUT_UNRECOGNISED_KIND);
    }
    if (connect > 0 && response > 0) {
        // The app joins `names` with commas, as for a thread group's profile.
        std::string name = request.at ("name").get<std::string> ();
        std::ranges::replace (name, ',', ' ');
        ctx.tally.add (TIMEOUT_TOTAL_KIND);
        ctx.tally.name_dropped (TIMEOUT_TOTAL_KIND, { name });
    }
    if (const long long total = std::min (connect + response, MAX_REQUEST_TIMEOUT_MS);
    total > 0) {
        request["timeout"] = total;
    }
}

/// One `<HTTPSamplerProxy>`, plus whatever its own `<hashTree>` scopes to it
/// alone (a `HeaderManager` and any extractor/assertion/timer/processor
/// nested directly under it - the common, flat `.jmx` shape this parser
/// targets). A `HeaderManager` or processor further up the tree is not
/// resolved onto it; the HTTP Request Defaults in scope are (`ctx.defaults`):
/// their path stands in for an empty one, and their timeouts for ones the
/// sampler leaves unset.
json build_http_sampler (Ctx& ctx, const pugi::xml_node& el, const pugi::xml_node& own_tree) {
    json request;
    request["name"]        = el.attribute ("testname").as_string ("Request");
    request["description"] = "";
    request["method"]      = string_prop (el, "HTTPSampler.method", "GET");

    const std::string own_path = string_prop (el, "HTTPSampler.path");
    const std::string path = trimmed (own_path).empty () ? ctx.defaults.path : own_path;
    const std::string base = base_url_of (el);
    request["url"] = rewrite_variables ((base.empty () ? "{{baseUrl}}" : base) + path);
    stamp_timeout (ctx, overlaid (ctx.defaults, http_settings_of (el)), request);

    json params = json::array ();
    json body   = json{ { "mode", "none" } };
    apply_sampler_arguments (ctx, el, request["method"].get<std::string> (), params, body);
    request["params"] = std::move (params);
    request["body"]   = std::move (body);
    request["auth"]   = json{ { "mode", "inherit" } };
    // JMeter offers two mutually-exclusive ways to follow a redirect - its own
    // "Follow Redirects" (the default) and HttpClient's "Redirect
    // Automatically" - either one means Vayu's single `followRedirects` is
    // true; only unchecking both turns it off.
    request["followRedirects"] = bool_prop (el, "HTTPSampler.follow_redirects", true) ||
    bool_prop (el, "HTTPSampler.auto_redirects", false);

    json headers  = json::array ();
    json elements = json::array ();
    if (own_tree) {
        collect_sampler_scope (ctx, own_tree, headers, elements);
    }
    request["headers"] = std::move (headers);
    if (!elements.empty ()) {
        request["elements"] = std::move (elements);
    }
    return request;
}

/// One folder-shaping controller: a plain folder either way, with its own
/// `control.*` element when `parse_controller` could translate it.
void build_controller_folder (Ctx& ctx,
std::string_view tag,
const pugi::xml_node& el,
const pugi::xml_node& own_tree,
Sink parent) {
    const std::string default_name (tag);
    json folder = make_folder ();
    folder["name"] = el.attribute ("testname").as_string (default_name.c_str ());
    folder["elements"] = json::array ();
    if (auto kc = parse_controller (tag, el)) {
        if (auto built = make_valid_element (ctx, kc->first, std::move (kc->second))) {
            folder["elements"].push_back (std::move (*built));
        }
    } else if (tag != "GenericController") {
        // A controller with no `control.*` element to build: a
        // `SwitchController` or `WhileController` (no mapping at all), a
        // `LoopController` set to JMeter's "forever" (`loops <= 0`), an
        // `IfController` whose condition does not match
        // `translate_if_condition`'s grammar, or a `ThroughputController` in
        // "total executions" style. The folder still imports and still groups
        // its members in source order, but the logic that shaped it is gone,
        // so it is tallied the same way `build_leaf_elements` tallies a
        // recognised class it could not extract enough from - never silently,
        // per issue #1443. A `GenericController` only groups, so it is the
        // one exception: nothing was lost to report.
        ctx.tally.add (std::string (tag) + "_unrecognised");
    }
    int next_order = 0;
    if (own_tree) {
        walk_hash_tree (own_tree,
        Sink{ folder["requests"], folder["children"], folder["elements"],
        folder["variables"], next_order },
        ctx);
    }
    if (folder["elements"].empty ()) {
        folder.erase ("elements");
    }
    ++ctx.folder_count;
    parent.add_folder (std::move (folder));
}

/// Tally kind for a thread group whose threads, ramp-up, duration or loops
/// ask for more than one pass by one thread: the run profile the collection
/// does not carry, named so the user can set it on the load run.
constexpr const char* THREAD_GROUP_PROFILE_KIND = "ThreadGroup_profile";

/// @p value of @p unit, `1 thread` / `10 threads`; the value is kept as
/// written because JMeter accepts a `${__P(threads,10)}` call there.
std::string counted_unit (const std::string& value, const char* unit) {
    return value + " " + unit + (value == "1" ? "" : "s");
}

/// What a thread group asks of a run, in the terms of Vayu's load profile -
/// `nullopt` for a group that is pure defaults (one thread, one pass, no
/// duration), which has nothing to set. A single thread starts at once, so its
/// ramp-up is not part of the profile; a duration counts only with the
/// scheduler on, as in JMeter. Values stay as written, and parts are joined by
/// `;` because the app lists several of these names comma-separated.
std::optional<std::string> thread_group_profile (const pugi::xml_node& group) {
    const auto value_or = [] (std::string text, const char* fallback) {
        return text.empty () ? std::string (fallback) : std::move (text);
    };
    const std::string threads =
    value_or (text_prop (group, "ThreadGroup.num_threads"), "1");
    const std::string loops = value_or (
    text_prop (element_prop (group, "ThreadGroup.main_controller"), "LoopController.loops"), "1");
    const std::string duration = bool_prop (group, "ThreadGroup.scheduler") ?
    text_prop (group, "ThreadGroup.duration") :
    "";
    if (threads == "1" && loops == "1" && duration.empty ()) {
        return std::nullopt;
    }

    std::vector<std::string> parts{ counted_unit (threads, "thread") };
    if (const std::string ramp_up = text_prop (group, "ThreadGroup.ramp_time");
    threads != "1" && !ramp_up.empty ()) {
        parts.push_back ("ramp-up " + ramp_up + "s");
    }
    if (!duration.empty ()) {
        parts.push_back ("duration " + duration + "s");
    }
    parts.push_back (loops == "-1" ? "forever" : counted_unit (loops, "loop"));

    // The app joins `names` with commas, so a comma in the group's name would
    // read as two groups; an empty name would read as ": 10 threads".
    std::string profile = group.attribute ("testname").as_string ();
    std::ranges::replace (profile, ',', ' ');
    if (profile.empty ()) {
        profile = "Thread Group";
    }
    profile += ":";
    for (size_t i = 0; i < parts.size (); ++i) {
        profile += (i == 0 ? " " : "; ") + parts[i];
    }
    return profile;
}

/// A thread group's profile, counted once per group with its values as the
/// kind's names (see `thread_group_profile`).
void tally_thread_group_profile (Ctx& ctx, const pugi::xml_node& group) {
    if (const std::optional<std::string> profile = thread_group_profile (group)) {
        ctx.tally.add (THREAD_GROUP_PROFILE_KIND);
        ctx.tally.name_dropped (THREAD_GROUP_PROFILE_KIND, { *profile });
    }
}

/// `TestPlan` and `ThreadGroup` both flatten straight into the enclosing
/// sink: Vayu has no thread-group concept (a collection already runs every
/// request once), and a `TestPlan` node's only content of its own is the
/// user-defined-variables it may carry.
void flatten_into_sink (Ctx& ctx, const pugi::xml_node& el, const pugi::xml_node& own_tree, Sink sink) {
    if (const pugi::xml_node vars = element_prop (el, "TestPlan.user_defined_variables"); vars) {
        merge_arguments_into_variables (vars, sink.variables);
    }
    if (own_tree) {
        walk_hash_tree (own_tree, sink, ctx);
    }
}

/// A setup/teardown thread group: the one script found inside it, and every
/// sampler the import leaves out counted under the group's own tag, so the
/// count is how many requests to rebuild by hand. A group with nothing
/// countable and no script is still one loss.
void dispatch_lifecycle_group (Ctx& ctx, std::string_view tag, const pugi::xml_node& own_tree, Sink sink) {
    GroupContents found;
    if (own_tree) {
        scan_group_tree (ctx, own_tree, /*direct=*/true, found);
    }
    int dropped = found.samplers;
    if (ctx.options.import_scripts && !found.script.empty ()) {
        const char* kind = tag == "SetupThreadGroup" ? "script.setup" : "script.teardown";
        if (auto built =
            make_valid_element (ctx, kind, json{ { "script", found.script } })) {
            sink.elements.push_back (std::move (*built));
            ctx.tally.add (std::string (tag), dropped - found.scripted_samplers);
            return;
        }
    }
    ctx.tally.add (std::string (tag), std::max (dropped, 1));
}

/// Every logic controller that imports as a folder holding its members in
/// source order. The first six may also gain a `control.*` element from
/// `parse_controller`; the rest have no element-kind equivalent for their
/// looping or selection semantic, so the folder is all they get and the
/// caller tallies `<Tag>_unrecognised` for each (`build_controller_folder`) -
/// except a `GenericController` (Simple Controller), which only groups and so
/// has nothing to report.
bool is_folder_controller (std::string_view tag) {
    static constexpr auto TAGS = std::to_array<std::string_view> ({
    "LoopController",
    "IfController",
    "OnceOnlyController",
    "SwitchController",
    "TransactionController",
    "ThroughputController",
    "GenericController",
    "WhileController",
    "ForeachController",
    "RandomController",
    "InterleaveControl",
    "RandomOrderController",
    "RunTime",
    "CriticalSectionController",
    "ModuleController",
    "IncludeController",
    "RecordingController",
    });
    return std::ranges::find (TAGS, tag) != TAGS.end ();
}

void dispatch_child (Ctx& ctx, const pugi::xml_node& el, const pugi::xml_node& own_tree, Sink sink) {
    const std::string_view tag = el.name ();

    if (tag == "TestPlan" || tag == "ThreadGroup") {
        if (tag == "ThreadGroup") {
            tally_thread_group_profile (ctx, el);
        }
        flatten_into_sink (ctx, el, own_tree, sink);
        return;
    }
    if (tag == "SetupThreadGroup" || tag == "PostThreadGroup") {
        dispatch_lifecycle_group (ctx, tag, own_tree, sink);
        return;
    }
    if (tag == "HTTPSamplerProxy") {
        sink.add_request (build_http_sampler (ctx, el, own_tree));
        ++ctx.request_count;
        return;
    }
    if (is_folder_controller (tag)) {
        build_controller_folder (ctx, tag, el, own_tree, sink);
        return;
    }
    if (tag == "Arguments") {
        merge_arguments_into_variables (el, sink.variables);
        return;
    }
    if (is_http_defaults (el)) {
        merge_http_defaults (el, sink.variables);
        return;
    }
    // Everything JMeter itself never asked this parser to model - listeners
    // (every one of which serializes as `<ResultCollector>` regardless of
    // which report a user picked), `CookieManager`, `CSVDataSet`,
    // `AuthManager`, `XPathExtractor`, a stray `ConfigTestElement` that is not
    // HTTP defaults - is counted by its own tag name inside
    // `build_leaf_elements`, so a future kind for any one of them costs nothing
    // to wire up.
    for (json& built : build_leaf_elements (ctx, tag, el)) {
        sink.elements.push_back (std::move (built));
    }
}

/// The defaults in force below @p hash_tree: @p inherited with the enabled HTTP
/// Request Defaults among its direct children laid over it, a later sibling's
/// field winning as in JMeter. Read ahead of the walk because a defaults
/// element covers the samplers at its level wherever it sits among them.
HttpDefaults defaults_in_scope (HttpDefaults inherited, const pugi::xml_node& hash_tree) {
    for_each_pair (hash_tree, [&] (const pugi::xml_node& el, const pugi::xml_node&) {
        if (is_http_defaults (el) && jmeter_enabled (el)) {
            inherited = overlaid (std::move (inherited), http_settings_of (el));
        }
    });
    return inherited;
}

/// Every recursive edge (controller folder, thread group flatten) re-enters
/// here, so this one guard bounds the stack. A `.jmx` skips `read_document`
/// and its `MAX_READ_DEPTH` check, so the same constant is applied here: past
/// it the branch is counted and left out, and the rest of the file imports.
void walk_hash_tree (const pugi::xml_node& hash_tree, Sink sink, Ctx& ctx) {
    if (ctx.depth >= constants::spec_document::MAX_READ_DEPTH) {
        ctx.tally.add (NESTING_TOO_DEEP_KIND);
        return;
    }
    ++ctx.depth;
    HttpDefaults enclosing = ctx.defaults;
    ctx.defaults           = defaults_in_scope (enclosing, hash_tree);
    for_each_paired_child (ctx, hash_tree,
    [&] (const pugi::xml_node& el, const pugi::xml_node& own_tree) {
        dispatch_child (ctx, el, own_tree, sink);
    });
    ctx.defaults = std::move (enclosing);
    --ctx.depth;
}

} // namespace

bool is_jmeter_document (std::string_view text) {
    constexpr size_t PREFIX = 4096;
    const std::string_view head = text.substr (0, std::min (text.size (), PREFIX));
    return head.find ("<jmeterTestPlan") != std::string_view::npos;
}

nlohmann::ordered_json
parse_jmeter (const std::string& text, const ImportOptions& options, ImportTally& tally) {
    pugi::xml_document document;
    const pugi::xml_parse_result result =
    document.load_buffer (text.data (), text.size ());
    if (!result) {
        throw MalformedJmeter (result.description ());
    }
    const pugi::xml_node root = document.child ("jmeterTestPlan");
    if (!root) {
        throw MalformedJmeter ("no <jmeterTestPlan> root element");
    }
    const pugi::xml_node top_tree = root.child ("hashTree");
    if (!top_tree) {
        throw MalformedJmeter ("no top-level <hashTree>");
    }

    json collection = { { "name", "Imported JMeter Plan" }, { "description", "" },
        { "variables", json::object () }, { "auth", json{ { "mode", "none" } } },
        { "children", json::array () }, { "requests", json::array () } };
    json elements = json::array ();
    Ctx ctx{ options, tally };
    int next_order = 0;
    Sink root_sink{ collection["requests"], collection["children"], elements,
        collection["variables"], next_order };
    walk_hash_tree (top_tree, root_sink, ctx);
    if (!elements.empty ()) {
        collection["elements"] = std::move (elements);
    }

    json collections = json::array ();
    collections.push_back (std::move (collection));

    json meta;
    const std::string version = root.attribute ("jmeter").as_string ("");
    meta["format"] = version.empty () ? "JMeter Test Plan" : "JMeter " + version + " Test Plan";
    meta["requestCount"]        = ctx.request_count;
    meta["folderCount"]         = ctx.folder_count;
    meta["environmentCount"]    = 0;
    meta["globalCount"]         = 0;
    meta["exampleCount"]        = 0;
    meta["skipped"]             = tally.items ();
    meta["nonExecutableAuth"]   = 0;
    meta["unattachedFileParts"] = 0;

    return json{ { "collections", std::move (collections) },
        { "environments", json::array () }, { "globals", json::object () },
        { "meta", std::move (meta) } };
}

} // namespace vayu::core
