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

#include "vayu/core/elements.hpp"

#include <pugixml.hpp>

#include <algorithm>
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
// directly under it, found by `name`, never by position.
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

/// `<intProp>` and `<longProp>` are both plain integer text; a caller never
/// has to know which one a given property happens to use.
long long_prop (const pugi::xml_node& element, std::string_view name, long fallback = 0) {
    pugi::xml_node prop = find_prop (element, "longProp", name);
    if (!prop) {
        prop = find_prop (element, "intProp", name);
    }
    if (!prop) {
        return fallback;
    }
    char* end         = nullptr;
    const char* text  = prop.text ().get ();
    const long parsed = std::strtol (text, &end, 10);
    return end != text ? parsed : fallback;
}

double double_prop (const pugi::xml_node& element, std::string_view name, double fallback = 0.0) {
    const pugi::xml_node prop = find_prop (element, "stringProp", name);
    if (!prop) {
        return fallback;
    }
    char* end           = nullptr;
    const char* text    = prop.text ().get ();
    const double parsed = std::strtod (text, &end);
    return end != text ? parsed : fallback;
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

/// The first `;`-separated segment - JMeter's own list convention for a
/// processor configured to extract several values at once
/// (`JSONPostProcessor.referenceNames`, `.jsonPathExprs`). Only the first
/// extraction of a multi-value processor is imported; the rest count toward
/// the same tally entry the processor's own kind would use had none matched,
/// via the caller finding an empty subsequent segment uninteresting - this
/// parser does not attempt to split one element into several.
std::string first_segment (const std::string& list, char separator) {
    const size_t at = list.find (separator);
    return at == std::string::npos ? list : list.substr (0, at);
}

// ---------------------------------------------------------------------------
// One import context, threaded through the whole walk.
// ---------------------------------------------------------------------------

struct Ctx {
    const ImportOptions& options;
    ImportTally& tally;
    long request_count = 0;
    long folder_count  = 0;
};

/// Where the walk currently appends - a folder and the root collection share
/// this same shape (issue #710's `OperationFolders`, mirrored here rather
/// than reused: that type is `import_document.cpp`'s own anonymous-namespace
/// helper, and a `.jmx` folder's own rules - one elements array per folder,
/// no tag/path naming rule - differ enough that sharing it would fold two
/// unrelated "how does a folder get named" questions into one type).
struct Sink {
    json& requests;
    json& children;
    json& elements;
    json& variables;
};

/// One `{kind, config}` pair, validated before it is offered to a sink -
/// never a bare `json` a caller could push unchecked.
using KindConfig = std::pair<std::string, json>;

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

std::optional<KindConfig> parse_json_extractor (const pugi::xml_node& el) {
    const std::string variable =
    first_segment (string_prop (el, "JSONPostProcessor.referenceNames"), ';');
    const std::string path =
    first_segment (string_prop (el, "JSONPostProcessor.jsonPathExprs"), ';');
    if (variable.empty () || path.empty ()) {
        return std::nullopt;
    }
    json config = { { "path", path }, { "variable", variable },
        { "matchNo", long_prop (el, "JSONPostProcessor.match_numbers", 1) } };
    const std::string fallback =
    first_segment (string_prop (el, "JSONPostProcessor.defaultValues"), ';');
    if (!fallback.empty ()) {
        config["default"] = fallback;
    }
    return KindConfig{ "extract.json", std::move (config) };
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
std::optional<KindConfig> parse_response_assertion (const pugi::xml_node& el) {
    pugi::xml_node strings = collection_prop (el, "Asserion.test_strings");
    if (!strings) {
        strings = collection_prop (el, "Assertion.test_strings");
    }
    std::vector<std::string> texts;
    for (const pugi::xml_node value : strings.children ("stringProp")) {
        texts.emplace_back (value.text ().get ());
    }
    if (texts.empty ()) {
        return std::nullopt;
    }

    const std::string field =
    string_prop (el, "Assertion.test_field", "Assertion.response_data");
    if (field == "Assertion.response_code") {
        json codes = json::array ();
        for (const std::string& text : texts) {
            char* end       = nullptr;
            const long code = std::strtol (text.c_str (), &end, 10);
            if (end != text.c_str ()) {
                codes.push_back (static_cast<int> (code));
            }
        }
        if (codes.empty ()) {
            return std::nullopt;
        }
        return KindConfig{ "assert.status", json{ { "in", std::move (codes) } } };
    }

    // `Assertion.test_type` is a bitmask (1 Matches, 2 Contains, 4 Not, 8
    // Equals, 16 Substring); only the Equals bit changes the mapped mode -
    // every other bit still reads as a text match, which `assert.contains`'s
    // own default ("contains") already is.
    const std::string mode =
    (long_prop (el, "Assertion.test_type", 2) & 8) != 0 ? "equals" : "contains";
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
        // never named as its target; refused instead, tallied by the caller
        // the same way any other recognised class this parser could not
        // extract enough from is.
        return std::nullopt;
    }
    return KindConfig{ "assert.contains",
        json{ { "field", target }, { "text", texts.front () }, { "mode", mode } } };
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

std::optional<KindConfig> parse_uniform_random_timer (const pugi::xml_node& el) {
    const double base  = double_prop (el, "ConstantDelay");
    const double range = double_prop (el, "RandomTime.range");
    return KindConfig{ "timer.think",
        json{ { "minMs", static_cast<long> (base) },
        { "maxMs", static_cast<long> (base + range) } } };
}

std::optional<KindConfig> parse_gaussian_random_timer (const pugi::xml_node& el) {
    const double base  = double_prop (el, "ConstantDelay");
    const double range = double_prop (el, "RandomTime.range");
    return KindConfig{ "timer.think",
        json{ { "gaussian", json{ { "meanMs", base }, { "deviationMs", range } } } } };
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

/// Every `.jmx` config element this parser has an element-kind mapping for -
/// the recognised half of the flat dispatch in `dispatch_child` below.
/// Returns `std::nullopt` both for an unrecognised @p tag and for one this
/// parser recognises but could not extract enough from (an empty pattern, an
/// unparsable number); either way the caller counts it.
std::optional<json>
build_leaf_element (Ctx& ctx, std::string_view tag, const pugi::xml_node& el) {
    std::optional<KindConfig> kc;
    if (tag == "JSONPostProcessor") {
        kc = parse_json_extractor (el);
    } else if (tag == "RegexExtractor") {
        kc = parse_regex_extractor (el);
    } else if (tag == "BoundaryExtractor") {
        kc = parse_boundary_extractor (el);
    } else if (tag == "ResponseAssertion") {
        kc = parse_response_assertion (el);
    } else if (tag == "DurationAssertion") {
        kc = parse_duration_assertion (el);
    } else if (tag == "SizeAssertion") {
        kc = parse_size_assertion (el);
    } else if (tag == "JSONPathAssertion") {
        kc = parse_jsonpath_assertion (el);
    } else if (tag == "ConstantTimer") {
        kc = parse_constant_timer (el);
    } else if (tag == "UniformRandomTimer") {
        kc = parse_uniform_random_timer (el);
    } else if (tag == "GaussianRandomTimer") {
        kc = parse_gaussian_random_timer (el);
    } else if (tag == "ConstantThroughputTimer") {
        kc = parse_constant_throughput_timer (el);
    } else if ((tag == "JSR223PreProcessor" || tag == "BeanShellPreProcessor") &&
    ctx.options.import_scripts) {
        kc = parse_script_processor (el, "script.pre");
    } else if ((tag == "JSR223PostProcessor" || tag == "BeanShellPostProcessor") &&
    ctx.options.import_scripts) {
        kc = parse_script_processor (el, "script.post");
    } else {
        return std::nullopt;
    }
    if (!kc) {
        ctx.tally.add (std::string (tag) + "_unrecognised");
        return std::nullopt;
    }
    return make_valid_element (ctx, kc->first, std::move (kc->second));
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
        return KindConfig{ "control.throughput",
            json{ { "percent",
            double_prop (el, "ThroughputController.percentThroughput", 100.0) } } };
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

std::string base_url_of (const pugi::xml_node& el) {
    const std::string domain = string_prop (el, "HTTPSampler.domain");
    if (domain.empty ()) {
        return "";
    }
    std::string base = string_prop (el, "HTTPSampler.protocol", "http") + "://" + domain;
    if (const std::string port = string_prop (el, "HTTPSampler.port");
    !port.empty () && port != "0") {
        base += ":" + port;
    }
    return base;
}

void merge_http_defaults (const pugi::xml_node& el, json& variables) {
    if (const std::string base = base_url_of (el); !base.empty ()) {
        variables["baseUrl"] = json{ { "value", base }, { "enabled", true } };
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
/// tree, an empty node when there is none.
///
/// A disabled element - and everything nested under it, since JMeter itself
/// never runs a disabled element's children either - is skipped here rather
/// than by each caller: this is the one place every walk in the file passes
/// through, so a caller cannot forget the check the way a request the user
/// turned off silently reappearing as active on import would suggest one did.
template <typename Visit>
void for_each_paired_child (Ctx& ctx, const pugi::xml_node& hash_tree, Visit&& visit) {
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
        if (!jmeter_enabled (element)) {
            ctx.tally.add (std::string (element.name ()) + "_disabled");
            child = next;
            continue;
        }
        visit (element, own_tree);
        child = next;
    }
}

json make_folder () {
    return json{ { "name", "" }, { "description", "" },
        { "variables", json::object () }, { "auth", json{ { "mode", "none" } } },
        { "children", json::array () }, { "requests", json::array () } };
}

void walk_hash_tree (const pugi::xml_node& hash_tree, Sink sink, Ctx& ctx);

/// A JMeter setup/teardown thread group carries no scripting concept of its
/// own - the only thing this parser can faithfully carry out of one is a
/// JSR223/BeanShell processor found directly inside it, concatenated if more
/// than one exists. A thread group whose body is ordinary samplers (a
/// realistic "log in during setup" plan) has no `script.setup`/`.teardown`
/// equivalent and is counted instead, per the issue's own mapping (the table
/// names only the script case).
std::string collect_group_script (Ctx& ctx, const pugi::xml_node& group_tree) {
    std::string script;
    for_each_paired_child (
    ctx, group_tree, [&] (const pugi::xml_node& el, const pugi::xml_node&) {
        const std::string_view tag = el.name ();
        if (tag != "JSR223PreProcessor" && tag != "JSR223PostProcessor" &&
        tag != "JSR223Sampler" && tag != "BeanShellPreProcessor" &&
        tag != "BeanShellPostProcessor" && tag != "BeanShellSampler") {
            return;
        }
        if (const std::string body = string_prop (el, "script"); !body.empty ()) {
            if (!script.empty ()) {
                script += "\n\n";
            }
            script += body;
        }
    });
    return script;
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

/// A sampler's own `HTTPsampler.Arguments`: the raw-body case when
/// `postBodyRaw` is set and there is exactly the one argument that shape
/// implies, query/form rows otherwise.
void apply_sampler_arguments (Ctx& ctx, const pugi::xml_node& el, json& params, json& body) {
    // `HTTPsampler.Files` (`HTTPFileArgs`/`HTTPFileArg`) - a multipart file
    // upload - is nested inside the sampler itself rather than a sibling tag
    // `for_each_paired_child` would tally on its own, so a file upload this
    // parser has no formdata-part model to build yet (issue #1657) is
    // counted here instead of being dropped with nothing said, the same
    // "nothing dropped quietly" rule the sibling-tag fallback already follows.
    if (const pugi::xml_node files = element_prop (el, "HTTPsampler.Files");
    files && collection_prop (files, "HTTPFileArgs.files").first_child ()) {
        ctx.tally.add ("HTTPsampler.Files");
    }
    const pugi::xml_node arguments = element_prop (el, "HTTPsampler.Arguments");
    if (!arguments) {
        return;
    }
    const auto pairs = argument_pairs (arguments);
    if (bool_prop (el, "HTTPSampler.postBodyRaw", false) && !pairs.empty ()) {
        body = json{ { "mode", "text" }, { "content", pairs.front ().second } };
        return;
    }
    for (const auto& [key, value] : pairs) {
        params.push_back (json{ { "key", key }, { "value", value },
        { "description", "" }, { "enabled", true } });
    }
}

/// Whatever a sampler's own `<hashTree>` scopes to it alone: a `HeaderManager`
/// merged into @p headers, any recognised extractor/assertion/timer/processor
/// into @p elements, everything else tallied by tag.
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
        if (auto built = build_leaf_element (ctx, tag, child)) {
            elements.push_back (std::move (*built));
            return;
        }
        if (tag != "hashTree") {
            ctx.tally.add (std::string (tag));
        }
    });
}

/// One `<HTTPSamplerProxy>`, plus whatever its own `<hashTree>` scopes to it
/// alone (a `HeaderManager` and any extractor/assertion/timer/processor
/// nested directly under it - the common, flat `.jmx` shape this parser
/// targets; JMeter's own scoping rules let a config element further up the
/// tree also apply here, which this parser does not attempt to resolve).
json build_http_sampler (Ctx& ctx, const pugi::xml_node& el, const pugi::xml_node& own_tree) {
    json request;
    request["name"]        = el.attribute ("testname").as_string ("Request");
    request["description"] = "";
    request["method"]      = string_prop (el, "HTTPSampler.method", "GET");

    const std::string path = string_prop (el, "HTTPSampler.path");
    const std::string base = base_url_of (el);
    request["url"] = rewrite_variables ((base.empty () ? "{{baseUrl}}" : base) + path);

    json params = json::array ();
    json body   = json{ { "mode", "none" } };
    apply_sampler_arguments (ctx, el, params, body);
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
    } else {
        // A controller tag this parser recognises but could not build a
        // `control.*` element for - a `SwitchController`, a `LoopController`
        // set to JMeter's "forever" (`loops <= 0`), or an `IfController` whose
        // condition does not match `translate_if_condition`'s grammar. The
        // folder still imports and still groups its members, but the logic
        // that shaped it is gone, so it is tallied the same way
        // `build_leaf_element` tallies a recognised class it could not
        // extract enough from - never silently, per issue #1443.
        ctx.tally.add (std::string (tag) + "_unrecognised");
    }
    if (own_tree) {
        walk_hash_tree (own_tree,
        Sink{ folder["requests"], folder["children"], folder["elements"], folder["variables"] },
        ctx);
    }
    if (folder["elements"].empty ()) {
        folder.erase ("elements");
    }
    ++ctx.folder_count;
    parent.children.push_back (std::move (folder));
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

/// A setup/teardown thread group: the one script found inside it, or counted
/// as unrecognised when it carries none (see `collect_group_script`).
void dispatch_lifecycle_group (Ctx& ctx, std::string_view tag, const pugi::xml_node& own_tree, Sink sink) {
    if (ctx.options.import_scripts && own_tree) {
        if (const std::string script = collect_group_script (ctx, own_tree);
        !script.empty ()) {
            const char* kind = tag == "SetupThreadGroup" ? "script.setup" : "script.teardown";
            if (auto built = make_valid_element (ctx, kind, json{ { "script", script } })) {
                sink.elements.push_back (std::move (*built));
                return;
            }
        }
    }
    ctx.tally.add (std::string (tag));
}

void dispatch_child (Ctx& ctx, const pugi::xml_node& el, const pugi::xml_node& own_tree, Sink sink) {
    const std::string_view tag = el.name ();

    if (tag == "TestPlan" || tag == "ThreadGroup") {
        flatten_into_sink (ctx, el, own_tree, sink);
        return;
    }
    if (tag == "SetupThreadGroup" || tag == "PostThreadGroup") {
        dispatch_lifecycle_group (ctx, tag, own_tree, sink);
        return;
    }
    if (tag == "HTTPSamplerProxy") {
        sink.requests.push_back (build_http_sampler (ctx, el, own_tree));
        ++ctx.request_count;
        return;
    }
    if (tag == "LoopController" || tag == "IfController" ||
    tag == "OnceOnlyController" || tag == "SwitchController" ||
    tag == "TransactionController" || tag == "ThroughputController") {
        build_controller_folder (ctx, tag, el, own_tree, sink);
        return;
    }
    if (tag == "Arguments") {
        merge_arguments_into_variables (el, sink.variables);
        return;
    }
    if (tag == "ConfigTestElement" &&
    std::string_view (el.attribute ("guiclass").value ()) == "HttpDefaultsGui") {
        merge_http_defaults (el, sink.variables);
        return;
    }
    if (auto built = build_leaf_element (ctx, tag, el)) {
        sink.elements.push_back (std::move (*built));
        return;
    }
    if (tag == "hashTree") {
        return; // Paired already; never reached, kept for readability.
    }
    // Everything JMeter itself never asked this parser to model - listeners
    // (every one of which serializes as `<ResultCollector>` regardless of
    // which report a user picked), `CookieManager`, `CSVDataSet`,
    // `AuthManager`, `WhileController`, `XPathExtractor`, a stray
    // `ConfigTestElement` that is not HTTP defaults - counted by its own tag
    // name so a future kind for any one of them costs nothing to wire up.
    ctx.tally.add (std::string (tag));
}

void walk_hash_tree (const pugi::xml_node& hash_tree, Sink sink, Ctx& ctx) {
    for_each_paired_child (ctx, hash_tree,
    [&] (const pugi::xml_node& el, const pugi::xml_node& own_tree) {
        dispatch_child (ctx, el, own_tree, sink);
    });
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
    Sink root_sink{ collection["requests"], collection["children"], elements,
        collection["variables"] };
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
