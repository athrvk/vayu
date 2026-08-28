/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/request_composer.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <ctime>
#include <map>
#include <random>
#include <regex>
#include <string_view>
#include <unordered_set>

#include "vayu/http/header_names.hpp"
#include "vayu/http/header_text.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/reentrant.hpp"

namespace vayu::http {

namespace {

/**
 * The one `{{name}}` pattern, shared by every reader of a token in this file.
 *
 * Same as the clients' VARIABLE_PATTERN: no nested braces, no escape hatch.
 * Matches are consumed left to right over the string being scanned, never over
 * the text a replacement put there - a substituted value is followed by
 * re-entering the scanner on the *value* (`substitute_tokens_nested`, #1009),
 * which is what bounds the work and lets a cycle be seen; the surrounding
 * literal is never rescanned.
 */
const std::regex& token_pattern () {
    static const std::regex pattern (R"(\{\{([^{}]+)\}\})");
    return pattern;
}

// --- Dynamic variables -------------------------------------------------------
//
// The C++ twin of the renderer's `lib/dynamic-variables.ts` table. The *names*
// are a contract (the renderer's autocomplete offers them and the conformance
// fixture pins the set on both sides); the values are random by design, so only
// their shape has to agree. Each generator runs once per `{{...}}` occurrence -
// two `{{$guid}}` in one payload are two different ids, which is the reason to
// write them.

/**
 * One generator per thread, seeded once.
 *
 * Function-local rather than a `thread_local` at namespace scope, for the same
 * reason {@link token_pattern} is: seeding runs `std::random_device`, which can
 * throw, and at namespace scope that throw happens before the thread's first
 * statement with no frame able to catch it (`cert-err58-cpp`). Here the first
 * caller's stack is on hand.
 */
std::mt19937& rng () {
    thread_local std::mt19937 generator{ std::random_device{}() };
    return generator;
}

int random_int (int min_inclusive, int max_inclusive) {
    std::uniform_int_distribution<int> dist (min_inclusive, max_inclusive);
    return dist (rng ());
}

template <size_t N> const char* pick (const std::array<const char*, N>& items) {
    return items.at (static_cast<size_t> (random_int (0, static_cast<int> (N) - 1)));
}

std::string random_string (size_t length, std::string_view alphabet) {
    std::string out;
    out.reserve (length);
    for (size_t i = 0; i < length; ++i) {
        out.push_back (
        alphabet[static_cast<size_t> (random_int (0, static_cast<int> (alphabet.size ()) - 1))]);
    }
    return out;
}

constexpr std::string_view ALPHANUMERIC =
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Spelled out rather than written as `ALPHANUMERIC + "!@#$%^&*_-+="`, because
// that concatenation is dynamic initialisation of a namespace-scope object and
// its allocation cannot be caught (`cert-err58-cpp`). The assertion below is
// what keeps the two from drifting apart.
constexpr std::string_view PASSWORD_CHARS =
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*_-+=";
static_assert (PASSWORD_CHARS.substr (0, ALPHANUMERIC.size ()) == ALPHANUMERIC,
"the password alphabet is the alphanumeric one plus symbols");

constexpr std::array<const char*, 10> FIRST_NAMES = { "Ada", "Ravi", "Mina",
    "Jonas", "Priya", "Elena", "Omar", "Sofia", "Kenji", "Nora" };
constexpr std::array<const char*, 10> LAST_NAMES = { "Lovelace", "Iyer", "Kowalski",
    "Okafor", "Rossi", "Nakamura", "Haddad", "Silva", "Novak", "Petrov" };
constexpr std::array<const char*, 6> COMPANY_WORDS    = { "Northwind", "Acme",
       "Umbra", "Lumen", "Kestrel", "Basalt" };
constexpr std::array<const char*, 5> COMPANY_SUFFIXES = { "Inc", "LLC", "Group",
    "Labs", "Systems" };
constexpr std::array<const char*, 4> DOMAINS = { "example.com", "example.org",
    "example.net", "test.dev" };

// The alphabets the #1010 tier draws from, spelled out for the reason
// PASSWORD_CHARS is: a `substr` of another constant is dynamic initialisation
// at namespace scope, so the relationship is pinned by an assertion instead.
constexpr std::string_view DIGITS = "0123456789";
static_assert (ALPHANUMERIC.substr (ALPHANUMERIC.size () - DIGITS.size ()) == DIGITS,
"the digit alphabet is the tail of the alphanumeric one");
constexpr std::string_view HEX_DIGITS = "0123456789abcdef";
static_assert (HEX_DIGITS.substr (0, DIGITS.size ()) == DIGITS,
"the hex alphabet opens with the decimal digits");

// The corpora behind the generators #1010 added. Curated lists, not a faker
// port: what the two sides have to agree on is the *shape* of a value - which
// is what the tests pin on each - and never the words behind it.
constexpr auto CITIES = std::to_array<const char*> (
{ "Spinkahaven", "North Berenice", "Lake Gerardo", "East Jessyca", "Port Rico",
"New Halle", "South Rylan", "West Kaley", "Fort Amir", "Port Adrien" });
// Two words each, which is the shape the address test reads.
constexpr auto STREET_NAMES = std::to_array<const char*> ({ "Harvey Streets",
"Kuhlman Junction", "Rippin Field", "Bahringer Turnpike", "Lockman Isle", "Konopelski Mount",
"Schuppe Village", "Reilly Circle", "Torphy Fords", "Larson Union" });
constexpr auto COUNTRIES =
std::to_array<const char*> ({ "Bahamas", "Norway", "Lao People's Democratic Republic",
"Guinea-Bissau", "Chile", "Iceland", "Nepal", "Uruguay", "Slovenia", "Rwanda" });
constexpr auto COUNTRY_CODES = std::to_array<const char*> (
{ "CV", "NO", "LA", "GW", "CL", "IS", "NP", "UY", "SI", "RW" });
constexpr auto WORDS = std::to_array<const char*> ({ "withdrawal", "synergistic", "sticky",
"copying", "grocery", "bandwidth", "override", "haptic", "protocol", "matrix" });
constexpr auto LOREM_WORDS = std::to_array<const char*> ({ "lorem", "ipsum",
"dolor", "sit", "amet", "consectetur", "adipisicing", "elit", "sed", "eiusmod",
"tempor", "incidunt", "labore", "dolore", "magna", "aliqua", "vel", "repellat",
"nobis", "voluptas", "molestias", "consequuntur", "quod", "perspiciatis" });
constexpr auto COLORS = std::to_array<const char*> ({ "red", "fuchsia", "grey",
"cyan", "maroon", "olive", "teal", "azure", "lime", "plum" });
constexpr auto USER_AGENTS = std::to_array<const char*> (
{ "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, "
  "like Gecko) Chrome/120.0.0.0 Safari/537.36",
"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 "
"Firefox/121.0",
"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
"Chrome/119.0.0.0 Safari/537.36",
"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 "
"(KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, "
"like Gecko) Version/17.2 Safari/605.1.15" });
constexpr auto ABBREVIATIONS = std::to_array<const char*> (
{ "SQL", "PCI", "JSON", "HTTP", "XML", "API", "TCP", "SSL", "JBOD", "AGP" });
constexpr auto CURRENCY_CODES = std::to_array<const char*> (
{ "CDF", "USD", "EUR", "GBP", "JPY", "INR", "BRL", "ZAR", "AUD", "SEK" });
constexpr auto PRODUCT_ADJECTIVES = std::to_array<const char*> ({ "Handmade",
"Refined", "Rustic", "Ergonomic", "Intelligent", "Practical", "Sleek", "Generic" });
constexpr auto PRODUCT_MATERIALS  = std::to_array<const char*> (
{ "Concrete", "Steel", "Wooden", "Cotton", "Granite", "Rubber" });
constexpr auto PRODUCT_NOUNS = std::to_array<const char*> (
{ "Tuna", "Chair", "Table", "Keyboard", "Shirt", "Bike", "Ball", "Soap" });
constexpr auto JOB_DESCRIPTORS = std::to_array<const char*> ({ "International",
"Regional", "Global", "Central", "National", "District", "Corporate", "Dynamic" });
constexpr auto JOB_AREAS = std::to_array<const char*> ({ "Creative", "Operations",
"Marketing", "Applications", "Accounts", "Data", "Research", "Infrastructure" });
constexpr auto JOB_TYPES = std::to_array<const char*> ({ "Liaison", "Manager",
"Engineer", "Analyst", "Architect", "Consultant", "Coordinator", "Strategist" });

constexpr int SECONDS_PER_DAY = 24 * 60 * 60;

std::string lower (std::string s) {
    std::transform (s.begin (), s.end (), s.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
    return s;
}

std::string zero_padded (long long value, size_t width) {
    std::string out = std::to_string (value);
    if (out.size () < width) {
        out.insert (0, width - out.size (), '0');
    }
    return out;
}

/// @p count words drawn independently from @p items, joined by single spaces.
template <size_t N>
std::string join_words (const std::array<const char*, N>& items, int count) {
    std::string out;
    for (int i = 0; i < count; ++i) {
        if (i > 0) {
            out += ' ';
        }
        out += pick (items);
    }
    return out;
}

std::string lorem_sentence () {
    // Never empty: the count is at least one, so the capitalisation below reads
    // a character that is there.
    std::string sentence = join_words (LOREM_WORDS, random_int (4, 9));
    sentence.at (0) =
    static_cast<char> (std::toupper (static_cast<unsigned char> (sentence.at (0))));
    return sentence + ".";
}

std::string lorem_sentences (int count) {
    std::string out;
    for (int i = 0; i < count; ++i) {
        if (i > 0) {
            out += ' ';
        }
        out += lorem_sentence ();
    }
    return out;
}

/**
 * @p time written the way JavaScript's `Date.prototype.toString` writes it,
 * which is the shape Postman documents its three date generators in.
 *
 * In UTC on both sides rather than in a local zone: the renderer twin has to
 * spell the same thing, and a daemon has no user's zone to read. Same
 * empty-on-refusal contract as {@link iso_timestamp}.
 */
std::string js_date_string (std::time_t time) {
    const std::string parts = vayu::utils::format_utc_time (time, "%a %b %d %Y %H:%M:%S");
    if (parts.empty ()) {
        return {};
    }
    return parts + " GMT+0000 (Coordinated Universal Time)";
}

std::time_t shifted_now (int offset_seconds) {
    const auto now =
    std::chrono::system_clock::to_time_t (std::chrono::system_clock::now ());
    return now + offset_seconds;
}

std::string iso_timestamp () {
    using namespace std::chrono;
    const auto now = system_clock::now ();
    const auto ms = duration_cast<milliseconds> (now.time_since_epoch ()) % 1000;
    const std::time_t t = system_clock::to_time_t (now);
    // The conversion is read rather than assumed: a refused one leaves a
    // `std::tm` holding nothing usable, and formatting it anyway renders a
    // confident wrong date. Unreachable for `system_clock::now()` on a 64-bit
    // `time_t`, which is why it went unchecked - what changes is that the
    // answer is now either right or empty, never confidently wrong.
    const std::string seconds = vayu::utils::format_utc_time (t, "%Y-%m-%dT%H:%M:%S");
    if (seconds.empty ()) {
        return {};
    }
    // The milliseconds, which no `std::strftime` specifier covers. Always three
    // digits, because the renderer's `toISOString` always writes three.
    return seconds + "." + zero_padded (ms.count (), 3) + "Z";
}

struct DynamicVariable {
    const char* name;
    std::string (*generate) ();
};

// Same names, same order as the renderer table. `constexpr`, so the table is
// built by the compiler rather than before `main` - every entry is a literal
// and a captureless lambda, both of which are constant expressions.
constexpr std::array<DynamicVariable, 39> DYNAMIC_VARIABLES = { {
{ "$guid", [] { return vayu::utils::generate_id (""); } },
{ "$randomUUID", [] { return vayu::utils::generate_id (""); } },
{ "$timestamp",
[] {
    return std::to_string (std::chrono::duration_cast<std::chrono::seconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ());
} },
{ "$isoTimestamp", [] { return iso_timestamp (); } },
{ "$randomInt", [] { return std::to_string (random_int (0, 1000)); } },
{ "$randomAlphaNumeric", [] { return random_string (1, ALPHANUMERIC); } },
{ "$randomBoolean",
[] { return std::string (random_int (0, 1) == 1 ? "true" : "false"); } },
{ "$randomEmail",
[] {
    return lower (pick (FIRST_NAMES)) + "." + lower (pick (LAST_NAMES)) + "@" +
    pick (DOMAINS);
} },
{ "$randomFirstName", [] { return std::string (pick (FIRST_NAMES)); } },
{ "$randomLastName", [] { return std::string (pick (LAST_NAMES)); } },
{ "$randomFullName",
[] { return std::string (pick (FIRST_NAMES)) + " " + pick (LAST_NAMES); } },
{ "$randomCompanyName",
[] { return std::string (pick (COMPANY_WORDS)) + " " + pick (COMPANY_SUFFIXES); } },
{ "$randomUrl",
[] { return "https://" + lower (pick (COMPANY_WORDS)) + "." + pick (DOMAINS); } },
{ "$randomIP",
[] {
    return std::to_string (random_int (0, 255)) + "." +
    std::to_string (random_int (0, 255)) + "." +
    std::to_string (random_int (0, 255)) + "." + std::to_string (random_int (0, 255));
} },
{ "$randomPassword", [] { return random_string (15, PASSWORD_CHARS); } },
// The #1010 tier: the Postman generators an imported collection actually
// reaches for. Every shape below is Postman's documented example read as the
// contract - `700-008-5275`, `5742 Harvey Streets`, `#47594a`, `531.55` - and
// each is pinned by a regex on both sides.
{ "$randomPhoneNumber",
[] {
    return std::to_string (random_int (200, 999)) + "-" +
    random_string (3, DIGITS) + "-" + random_string (4, DIGITS);
} },
{ "$randomCity", [] { return std::string (pick (CITIES)); } },
{ "$randomStreetAddress",
[] {
    return std::to_string (random_int (100, 9999)) + " " + pick (STREET_NAMES);
} },
{ "$randomCountry", [] { return std::string (pick (COUNTRIES)); } },
{ "$randomCountryCode", [] { return std::string (pick (COUNTRY_CODES)); } },
{ "$randomDatePast",
[] {
    return js_date_string (shifted_now (-random_int (1, 365 * SECONDS_PER_DAY)));
} },
{ "$randomDateFuture",
[] {
    return js_date_string (shifted_now (random_int (1, 365 * SECONDS_PER_DAY)));
} },
{ "$randomDateRecent",
[] {
    return js_date_string (shifted_now (-random_int (1, 7 * SECONDS_PER_DAY)));
} },
{ "$randomWord", [] { return std::string (pick (WORDS)); } },
{ "$randomWords", [] { return join_words (WORDS, random_int (3, 5)); } },
{ "$randomLoremWord", [] { return std::string (pick (LOREM_WORDS)); } },
{ "$randomLoremWords", [] { return join_words (LOREM_WORDS, 3); } },
{ "$randomLoremSentence", [] { return lorem_sentence (); } },
{ "$randomLoremSentences", [] { return lorem_sentences (random_int (2, 6)); } },
{ "$randomLoremParagraph", [] { return lorem_sentences (random_int (3, 5)); } },
{ "$randomColor", [] { return std::string (pick (COLORS)); } },
{ "$randomHexColor", [] { return "#" + random_string (6, HEX_DIGITS); } },
{ "$randomUserAgent", [] { return std::string (pick (USER_AGENTS)); } },
// The reserved example space (RFC 2606) the file's other host-shaped
// generators already draw from, rather than Postman's live-looking `gracie.biz`
// - a generated hostname reaches DNS the moment someone writes it into a URL.
{ "$randomDomainName",
[] { return lower (pick (FIRST_NAMES)) + "." + pick (DOMAINS); } },
{ "$randomAbbreviation", [] { return std::string (pick (ABBREVIATIONS)); } },
{ "$randomPrice",
[] {
    const int cents                                         = random_int (0, 100000);
    return std::to_string (cents / 100) + "." + zero_padded (cents % 100, 2);
} },
{ "$randomCurrencyCode", [] { return std::string (pick (CURRENCY_CODES)); } },
{ "$randomProductName",
[] {
    return std::string (pick (PRODUCT_ADJECTIVES)) + " " +
    pick (PRODUCT_MATERIALS) + " " + pick (PRODUCT_NOUNS);
} },
{ "$randomJobTitle",
[] {
    return std::string (pick (JOB_DESCRIPTORS)) + " " + pick (JOB_AREAS) + " " +
    pick (JOB_TYPES);
} },
} };

std::string trim (const std::string& s) {
    const auto begin = s.find_first_not_of (" \t\r\n");
    if (begin == std::string::npos) {
        return {};
    }
    const auto end = s.find_last_not_of (" \t\r\n");
    return s.substr (begin, end - begin + 1);
}

} // namespace

bool is_dynamic_variable_name (const std::string& name) {
    return !name.empty () && name.front () == '$';
}

bool is_data_variable_name (const std::string& name) {
    // The prefix alone is not a column reference: `{{data.}}` names nothing, so
    // it falls through to the ordinary unknown-name rule rather than surviving
    // composition as a token no iteration could ever bind.
    return name.size () > DATA_NAMESPACE_PREFIX.size () &&
    name.compare (0, DATA_NAMESPACE_PREFIX.size (), DATA_NAMESPACE_PREFIX) == 0;
}

bool is_identity_variable_name (const std::string& name) {
    return name == IDENTITY_VU_NAME || name == IDENTITY_ITERATION_NAME;
}

bool is_bound_column_name (const std::string& name, const BoundColumnNames& bound_columns) {
    // The `empty()` short-circuit is what every composition with no dataset
    // behind it pays for this rule, per token: one test, no lookup.
    return !bound_columns.empty () && bound_columns.count (name) > 0;
}

std::optional<std::string> resolve_dynamic_variable (const std::string& name) {
    for (const auto& v : DYNAMIC_VARIABLES) {
        if (name == v.name) {
            return v.generate ();
        }
    }
    return std::nullopt;
}

const std::vector<std::string>& dynamic_variable_names () {
    static const std::vector<std::string> names = [] {
        std::vector<std::string> out;
        out.reserve (DYNAMIC_VARIABLES.size ());
        for (const auto& v : DYNAMIC_VARIABLES) {
            out.emplace_back (v.name);
        }
        return out;
    }();
    return names;
}

VariableValues build_variable_values (const vayu::Environment& globals,
const std::vector<vayu::Environment>& chain,
const vayu::Environment& environment) {
    VariableValues values;
    const auto collect = [&values] (const vayu::Environment& scope) {
        for (const auto& [name, var] : scope) {
            if (var.enabled) {
                values[name] = var.value;
            }
        }
    };
    collect (globals);              // 1. globals (lowest)
    for (const auto& col : chain) { // 2. chain root->leaf
        collect (col);
    }
    collect (environment); // 3. environment (highest)
    return values;
}

namespace {

/**
 * How deep a value's own `{{tokens}}` are followed before the rest are left
 * written as they stand (issue #1009).
 *
 * A bound rather than "until it stops changing", because the resolver has no
 * way to know a chain is finite: the values come from a user's environment,
 * and `a = "{{a}} "` grows on every pass. Eight is past every layering anyone
 * writes by hand - `baseUrl = "{{protocol}}://{{host}}:{{port}}"` is two - and
 * far short of a stack anyone would notice.
 */
constexpr size_t MAX_NESTED_RESOLUTIONS = 8;

/**
 * One pass over @p input, following each replacement that carries tokens of
 * its own back through @p resolve.
 *
 * @p expanding is the chain of names currently being expanded, innermost last.
 * A name already on it is a cycle, and its token is left written as it stands
 * rather than expanded again - `a = "{{b}}"`, `b = "{{a}}"` resolves to the
 * literal `{{a}}` instead of recurring until the stack ends. At the depth bound
 * the value still substitutes; only its own tokens stay literal, so a chain
 * longer than the bound keeps the work it had already done.
 */
std::string substitute_tokens_nested (const std::string& input,
const std::function<std::optional<std::string> (const std::string& name)>& resolve,
std::vector<std::string>& expanding) {
    if (input.empty ()) {
        return input;
    }
    const std::regex& pattern = token_pattern ();

    std::string out;
    out.reserve (input.size ());
    auto it = std::sregex_iterator (input.begin (), input.end (), pattern);
    const auto end = std::sregex_iterator ();
    size_t last    = 0;
    for (; it != end; ++it) {
        const auto& match = *it;
        out.append (input, last, static_cast<size_t> (match.position ()) - last);
        last = static_cast<size_t> (match.position () + match.length ());

        std::string name = trim (match[1].str ());
        // The cycle is answered before `resolve` runs, not after: the callbacks
        // record what they substituted (a header a value would forge, a column
        // no row has), and a name this pass is not going to substitute must not
        // leave a record saying it did.
        if (std::find (expanding.begin (), expanding.end (), name) != expanding.end ()) {
            out += match.str (); // a cycle - left written as it stands
            continue;
        }
        auto replacement = resolve (name);
        if (!replacement) {
            out += match.str (); // left written as it stands
            continue;
        }
        // The `find` is what keeps this a single pass for every value that
        // holds no token, which is nearly all of them: only a value that
        // itself spells `{{` pays a second scan.
        if (replacement->find ("{{") == std::string::npos ||
        expanding.size () >= MAX_NESTED_RESOLUTIONS) {
            out += *replacement;
            continue;
        }
        expanding.push_back (std::move (name));
        out += substitute_tokens_nested (*replacement, resolve, expanding);
        expanding.pop_back ();
    }
    out.append (input, last, input.size () - last);
    return out;
}

} // namespace

std::string substitute_tokens (const std::string& input,
const std::function<std::optional<std::string> (const std::string& name)>& resolve) {
    std::vector<std::string> expanding;
    return substitute_tokens_nested (input, resolve, expanding);
}

TokenSplit split_tokens (const std::string& input,
const std::function<bool (const std::string&)>& keep) {
    TokenSplit split;
    // The literal being accumulated. A rejected token is appended to it rather
    // than opening a hole, so "not ours" and "no token here" produce the same
    // text - which is what lets one namespace split a field the other scopes
    // have already had their turn at.
    std::string literal;

    if (!input.empty ()) {
        auto it = std::sregex_iterator (input.begin (), input.end (), token_pattern ());
        const auto end = std::sregex_iterator ();
        size_t last    = 0;
        for (; it != end; ++it) {
            const auto& match = *it;
            literal.append (input, last, static_cast<size_t> (match.position ()) - last);
            std::string name = trim (match[1].str ());
            if (keep (name)) {
                split.literals.push_back (std::move (literal));
                literal.clear ();
                split.names.push_back (std::move (name));
            } else {
                literal += match.str (); // left written as it stands
            }
            last = static_cast<size_t> (match.position () + match.length ());
        }
        literal.append (input, last, input.size () - last);
    }

    // Always one more literal than names, including for a string with none.
    split.literals.push_back (std::move (literal));
    return split;
}

/// The set a resolution with no dataset behind it reads, shared rather than
/// constructed per call - and function-local because nothing here is built at
/// namespace scope.
const BoundColumnNames& no_bound_columns () {
    static const BoundColumnNames empty;
    return empty;
}

/// What `{{name}}` resolves to, or nullopt for a token left written as it
/// stands. The one lookup rule every resolution in this file substitutes
/// through, named rather than inlined so the header-aware resolver below sees
/// exactly the value an ordinary field would have got.
std::optional<std::string> lookup_variable (const std::string& name,
const VariableValues& vars,
const BoundColumnNames& bound_columns) {
    // Before the scopes, not after: the namespace is disjoint from them, so
    // a variable someone named `data.id` must not answer for the column.
    if (is_data_variable_name (name)) {
        return std::nullopt; // bound per iteration, or not at all (#402)
    }
    // Ahead of the scopes for the same reason, and it is what makes the name
    // bindable at all: a variable someone named `$vu` answering here would
    // substitute one value into the composed request and leave every iteration
    // of the run sending it (issue #994).
    if (is_identity_variable_name (name)) {
        return std::nullopt; // bound per iteration by the executor
    }
    // Before the scopes for the opposite reason (issue #1007): this name is
    // *not* disjoint from them, and the row is the one that wins. Postman's
    // precedence puts a data column above the environment, so a scope that
    // answered here would send the value the row was meant to replace. After
    // the two reserved namespaces above, so a column that happens to be named
    // `$vu` or `data.x` cannot take a reserved token's meaning away from it.
    if (is_bound_column_name (name, bound_columns)) {
        return std::nullopt; // the bound row substitutes it, per iteration
    }
    if (auto defined = vars.find (name); defined != vars.end ()) {
        return defined->second;
    }
    if (is_dynamic_variable_name (name)) {
        return resolve_dynamic_variable (name); // unknown $name keeps its braces (#186)
    }
    // An unknown ordinary name keeps its braces too (#1009), on the rule the
    // line above has held since #186: a token that resolved to "" left the
    // request *different* and said nothing - `https://{{host}}/x` went out as
    // `https:///x`, a URL nobody wrote, where the literal reaches DNS or the
    // server and comes back as an error naming the host that was never set.
    // It is also what makes a token survive composition for something later to
    // resolve, which is the half #1008's residual pass is built on.
    return std::nullopt;
}

/// What `{{$vu}}` / `{{$iteration}}` resolve to for a caller that knows which
/// iteration is sending, and nullopt for every other name - including for the
/// callers that pass no identity, which is why `lookup_variable` below still
/// defers both names rather than answering them a second way.
///
/// Ahead of every other rule at both call sites, on `lookup_variable`'s own
/// reasoning: the namespace is reserved, so neither a scope nor a bound column
/// that happens to carry the name can answer for the identity.
std::optional<std::string> identity_value (const std::string& name,
const std::optional<IterationIdentity>& identity) {
    if (!identity || !is_identity_variable_name (name)) {
        return std::nullopt;
    }
    return std::to_string (name == IDENTITY_VU_NAME ? identity->vu : identity->iteration);
}

std::string resolve_template (const std::string& input,
const VariableValues& vars,
const BoundColumnNames& bound_columns,
const std::optional<IterationIdentity>& identity) {
    return substitute_tokens (
    input, [&vars, &bound_columns, &identity] (const std::string& name) {
        if (auto bound = identity_value (name, identity)) {
            return bound;
        }
        return lookup_variable (name, vars, bound_columns);
    });
}

std::string render_data_value (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_null ()) {
        return {};
    }
    return value.dump ();
}

std::string resolve_template_with_data (const std::string& input,
const VariableValues& vars,
const DataRowColumns& row,
std::optional<std::string>& missing_column,
const std::optional<IterationIdentity>& identity) {
    return substitute_tokens (
    input, [&] (const std::string& name) -> std::optional<std::string> {
        // Before the row as well as before the scopes: a file's column named
        // `$vu` is the case `lookup_variable`'s reserved-namespace order
        // exists for, and reading the row first would let one answer here.
        if (auto bound = identity_value (name, identity)) {
            return bound;
        }
        // Ahead of the scopes, exactly as `lookup_variable` puts it: the
        // namespace is disjoint from them, so a variable someone named
        // `data.id` must not answer for the column - and the column must not
        // answer for the variable.
        if (!is_data_variable_name (name)) {
            // The bare spelling of the same read (issue #1007), and it is a
            // *hit* rather than a deferral because this caller holds the row:
            // above the scopes, because that is where Postman puts a data
            // variable, and silent when the row does not carry the name -
            // which is an ordinary variable, not a mistake about a column.
            if (const auto cell = row.columns.find (name); cell != row.columns.end ()) {
                return cell->second;
            }
            return lookup_variable (name, vars, no_bound_columns ());
        }
        const std::string column = name.substr (DATA_NAMESPACE_PREFIX.size ());
        if (const auto cell = row.columns.find (column); cell != row.columns.end ()) {
            return cell->second;
        }
        // Recorded rather than resolved to "": the token says the value came
        // from the file, so a name no column answers is a mistake about the
        // column and the quiet answer hides it (the rule `apply_iteration_template`
        // enforces at bind time). Only the first is kept - the caller reports
        // one and the rest are the same mistake.
        if (!missing_column) {
            missing_column = name;
        }
        return std::nullopt; // left written; the caller discards the result
    });
}

/// The variable whose value cannot be written into a header line, and whether
/// its bytes end that line or cut it short.
struct HeaderTextRefusal {
    std::string variable;
    bool line_break = true;
};

/**
 * Resolve @p input as header text, recording the first variable whose value
 * could not be spelled in a header line.
 *
 * Composition is where the *variable* is still known - by the time the payload
 * reaches a driver, the value is indistinguishable from text the user typed -
 * which is the whole reason this layer exists beside the pre-send gate that
 * refuses the same bytes from every other origin (see `http/header_text.hpp`).
 *
 * Checked on the substituted value rather than on the finished field: a CR the
 * user typed into the header themselves is not a variable's doing, and naming
 * one for it would be a lie. The gate still refuses that request, naming the
 * header instead.
 */
std::string resolve_header_template (const std::string& input,
const VariableValues& vars,
const BoundColumnNames& bound_columns,
std::optional<HeaderTextRefusal>& refusal) {
    return substitute_tokens (input,
    [&vars, &bound_columns, &refusal] (const std::string& name) -> std::optional<std::string> {
        auto value = lookup_variable (name, vars, bound_columns);
        if (!value || refusal) {
            return value; // nothing substituted, or already refused - first wins
        }
        if (vayu::http::ends_a_header_line (*value)) {
            refusal = HeaderTextRefusal{ name, true };
        } else if (vayu::http::truncates_a_header_line (*value)) {
            refusal = HeaderTextRefusal{ name, false };
        }
        return value;
    });
}

/// The refusal a header-bound variable carrying an unspellable byte reads as -
/// the shape #732's bind-time message established, with the variable in the
/// place the column holds there.
std::string describe_header_text_refusal (const HeaderTextRefusal& refusal) {
    return "{{" + refusal.variable + "}} is written into a header, and its value has " +
    (refusal.line_break ?
    "a line break - a CR or LF ends the header line rather than sitting in it, "
    "so the rest of the value would be read as headers of its own" :
    "a NUL - it cuts the header line short, so the rest of the value would be "
    "dropped on the wire without a word") +
    "; the request is refused rather than composed into a forged header";
}

nlohmann::json resolve_json_strings (const nlohmann::json& value,
const VariableValues& vars,
const BoundColumnNames& bound_columns) {
    if (value.is_string ()) {
        return resolve_template (value.get<std::string> (), vars, bound_columns);
    }
    if (value.is_array ()) {
        nlohmann::json out = nlohmann::json::array ();
        for (const auto& item : value) {
            out.push_back (resolve_json_strings (item, vars, bound_columns));
        }
        return out;
    }
    if (value.is_object ()) {
        nlohmann::json out = nlohmann::json::object ();
        for (const auto& [key, item] : value.items ()) {
            out[key] = resolve_json_strings (item, vars, bound_columns);
        }
        return out;
    }
    return value;
}

std::vector<vayu::db::Collection>
collection_chain (vayu::db::Database& db, const std::string& leaf_id) {
    std::vector<vayu::db::Collection> chain;
    std::unordered_set<std::string> seen;
    std::string current = leaf_id;
    while (!current.empty () && seen.insert (current).second) {
        auto col = db.get_collection (current);
        if (!col) {
            break;
        }
        current = col->parent_id.value_or ("");
        chain.insert (chain.begin (), std::move (*col)); // root ends up first
    }
    return chain;
}

namespace {

// Fetch the "mode" of an auth JSON, "" when absent or not a string.
std::string auth_mode (const nlohmann::json& auth) {
    if (auth.is_object ()) {
        if (auto it = auth.find ("mode"); it != auth.end () && it->is_string ()) {
            return it->get<std::string> ();
        }
    }
    return {};
}

// True for auth blocks that carry no credential (nothing to forward).
bool is_empty_auth (const nlohmann::json& auth) {
    const std::string mode = auth_mode (auth);
    return mode.empty () || mode == "none" || mode == "noauth";
}

nlohmann::json parse_auth_blob (const std::string& blob) {
    if (blob.empty ()) {
        return nlohmann::json ();
    }
    auto parsed = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    return parsed.is_discarded () ? nlohmann::json () : parsed;
}

} // namespace

nlohmann::json resolve_inherited_auth (const std::vector<vayu::db::Collection>& chain) {
    for (auto it = chain.rbegin (); it != chain.rend (); ++it) {
        nlohmann::json auth = parse_auth_blob (it->auth);
        if (auth_mode (auth) == "noauth") {
            return nlohmann::json (); // explicit "send nothing" ends the walk
        }
        if (!is_empty_auth (auth)) {
            return auth;
        }
    }
    return nlohmann::json ();
}

namespace {

// Builds through routes.hpp's error_body so /compose carries the same nested
// shape as every other route (issue #173 landed while #226 was in flight).
std::pair<int, nlohmann::json>
compose_error (int status, const char* code, const std::string& message) {
    return { status, routes::error_body (status, message, code) };
}

// Append one script part, skipping blanks - the same rule the clients'
// scriptParts helpers and the engine's read_script apply.
void push_script_part (nlohmann::json& parts,
const char* origin,
const std::string& id,
const std::string& name,
const std::string& script) {
    if (script.find_first_not_of (" \t\r\n") == std::string::npos) {
        return;
    }
    nlohmann::json part = { { "origin", origin }, { "script", script } };
    if (!id.empty ()) {
        part["id"] = id;
    }
    if (!name.empty ()) {
        part["name"] = name;
    }
    parts.push_back (part);
}

// The ordered script-part list for a saved request: the collection chain's
// scripts root->leaf, then the request's own - the order the renderer sends,
// so parent-collection setup runs before the request's script.
nlohmann::json compose_script_parts (const std::vector<vayu::db::Collection>& chain,
const vayu::db::Request& request,
bool pre) {
    nlohmann::json parts = nlohmann::json::array ();
    for (const auto& col : chain) {
        push_script_part (parts, "collection", col.id, col.name,
        pre ? col.pre_request_script : col.post_request_script);
    }
    push_script_part (parts, "request", request.id, "",
    pre ? request.pre_request_script : request.post_request_script);
    return parts;
}

// Flatten a stored KeyValueEntry[] headers blob into the object map /execute
// expects: enabled-only, non-empty keys, later duplicates win.
nlohmann::json flatten_stored_headers (const std::string& blob) {
    nlohmann::json out = nlohmann::json::object ();
    if (blob.empty ()) {
        return out;
    }
    auto rows = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!rows.is_array ()) {
        return out;
    }
    for (const auto& row : rows) {
        if (!row.is_object ()) {
            continue;
        }
        const auto key = row.find ("key");
        if (key == row.end () || !key->is_string () || key->get<std::string> ().empty ()) {
            continue;
        }
        if (auto enabled = row.find ("enabled"); enabled != row.end () &&
        enabled->is_boolean () && !enabled->get<bool> ()) {
            continue;
        }
        const auto value = row.find ("value");
        out[key->get<std::string> ()] =
        (value != row.end () && value->is_string ()) ? value->get<std::string> () : "";
    }
    return out;
}

// The stored body blob as an /execute body, or null for "no body".
nlohmann::json stored_body (const std::string& blob) {
    if (blob.empty ()) {
        return nlohmann::json ();
    }
    auto body = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!body.is_object ()) {
        return nlohmann::json ();
    }
    const auto mode = body.find ("mode");
    if (mode == body.end () || !mode->is_string () || mode->get<std::string> () == "none") {
        return nlohmann::json ();
    }
    return body;
}

// Build the unresolved execute-ready payload for a saved request - the by-id
// half of composition. Everything here is raw; resolution happens afterwards,
// through the same code the inline path uses.
nlohmann::json payload_from_stored (const vayu::db::Request& request,
const std::vector<vayu::db::Collection>& chain) {
    nlohmann::json payload;
    payload["method"] = to_string (request.method);
    payload["url"]    = request.url;

    nlohmann::json headers = flatten_stored_headers (request.headers);
    if (!headers.empty ()) {
        payload["headers"] = headers;
    }
    nlohmann::json body = stored_body (request.body);
    if (!body.is_null ()) {
        payload["body"] = body;
    }

    // A saved request with no auth blob defaults to inherit (the CRUD layer's
    // own default for the column).
    nlohmann::json auth = parse_auth_blob (request.auth);
    payload["auth"] = auth.is_object () ? auth : nlohmann::json{ { "mode", "inherit" } };

    nlohmann::json pre = compose_script_parts (chain, request, /*pre=*/true);
    if (!pre.empty ()) {
        payload["preRequestScripts"] = pre;
    }
    nlohmann::json post = compose_script_parts (chain, request, /*pre=*/false);
    if (!post.empty ()) {
        payload["postRequestScripts"] = post;
    }

    // Always emitted, never elided - the same rule both clients follow: the
    // engine's execute default is to follow redirects at "auto", so omitting a
    // stored `false` or a stored protocol would silently hand the decision
    // back to the default.
    payload["followRedirects"] = request.follow_redirects;
    payload["maxRedirects"]    = request.max_redirects;
    payload["httpVersion"]     = request.http_version;
    // Same rule, and the one field where eliding the default would be a
    // security bug rather than a surprise: `verify_ssl` defaults to *true*
    // engine-side, so an omitted `false` would verify the certificate the user
    // explicitly asked the engine not to check (issue #706).
    payload["verifySSL"] = request.verify_ssl;
    payload["requestId"] = request.id;

    // Identity for the script sandbox (`pm.info.requestName`), not an HTTP
    // field. Only the by-id path has a row to read it from; the inline path's
    // client sends its own, because editor state may be unsaved. Omitted when
    // empty so a script reads `undefined` rather than "".
    if (!request.name.empty ()) {
        payload["requestName"] = request.name;
    }
    return payload;
}

} // namespace

namespace {

/**
 * The variables this composition resolves through, and the collection chain they
 * come from.
 *
 * Scope: the saved request's own collection wins; an explicit `collectionId` is
 * the inline path's scope (and a fallback for a stored request without one).
 * Unknown ids degrade to an empty scope, the same tolerance the clients had -
 * composition must still work with no collection at all.
 */
VariableValues resolve_compose_variables (vayu::db::Database& db,
const nlohmann::json& body,
const std::optional<vayu::db::Request>& stored,
std::vector<vayu::db::Collection>& chain,
std::string& environment_id) {
    // Scope: the saved request's own collection wins; an explicit collectionId
    // is the inline path's scope (and a fallback for a stored request without
    // one). Unknown ids degrade to an empty scope, the same tolerance the
    // clients had - composition must still work with no collection at all.
    std::string scope_collection_id;
    if (stored && !stored->collection_id.empty ()) {
        scope_collection_id = stored->collection_id;
    } else if (body.contains ("collectionId") && body["collectionId"].is_string ()) {
        scope_collection_id = body["collectionId"].get<std::string> ();
    }
    chain = collection_chain (db, scope_collection_id);

    vayu::Environment globals, environment;
    if (auto db_globals = db.get_globals ()) {
        globals = vayu::json::parse_variables (db_globals->variables);
    }
    if (body.contains ("environmentId") && body["environmentId"].is_string ()) {
        environment_id = body["environmentId"].get<std::string> ();
        if (auto db_env = db.get_environment (environment_id)) {
            environment = vayu::json::parse_variables (db_env->variables);
        }
    }
    std::vector<vayu::Environment> chain_variables;
    chain_variables.reserve (chain.size ());
    for (const auto& col : chain) {
        chain_variables.push_back (vayu::json::parse_variables (col.variables));
    }
    const VariableValues vars =
    build_variable_values (globals, chain_variables, environment);
    return vars;
}

/// A resolved header block, or the first refusal that stopped it - the two
/// reasons composition rejects a payload over a header rather than over its
/// shape, gathered so the caller answers them in one place.
struct ResolvedHeaders {
    nlohmann::json headers = nlohmann::json::object ();
    /// A variable whose value cannot be written into a header line (#738).
    std::optional<HeaderTextRefusal> unspellable;
    /// Two names that resolved to one (#1051).
    std::optional<vayu::http::HeaderNameCollision> collision;
};

/**
 * Resolve every header name and value in @p headers.
 *
 * Rebuilt rather than edited in place, because a resolved name is a different
 * key - and a name a variable produced can land on a name another header
 * already holds, which is the collision `http/header_names.hpp` refuses.
 *
 * Names are tracked the way `Headers` compares them rather than the way this
 * JSON object keys them, because that is what the payload becomes: two names
 * differing only in case are two keys here and one header in the map
 * `POST /execute` parses this into, so a collision only that map can see would
 * otherwise be composed happily and drop a header one layer further on, with
 * the variable that caused it already forgotten.
 */
ResolvedHeaders resolve_header_block (const nlohmann::json& headers,
const VariableValues& vars,
const BoundColumnNames& bound_columns) {
    ResolvedHeaders out;
    // Each resolved name, against the name as written that produced it. The
    // second half is what separates a collision resolution *made* from two
    // names the author typed themselves: those are two lines they can see side
    // by side, and composition has always let the later one win. This refusal
    // is for the one that is invisible until the request comes back wrong.
    std::map<std::string, std::string, vayu::CaseInsensitiveLess> produced;
    for (const auto& [key, value] : headers.items ()) {
        const std::string name =
        resolve_header_template (key, vars, bound_columns, out.unspellable);
        const auto [taken, was_free] = produced.emplace (name, key);
        const bool resolution_made_it = name != key || taken->second != taken->first;
        if (!was_free && resolution_made_it && !out.collision) {
            out.collision =
            vayu::http::HeaderNameCollision{ key, taken->second, taken->first };
        }
        out.headers[name] = value.is_string () ?
        nlohmann::json (resolve_header_template (
        value.get<std::string> (), vars, bound_columns, out.unspellable)) :
        value;
    }
    return out;
}

/**
 * The method, the URL and the headers.
 *
 * A header is the one field composition refuses a payload over, because it is
 * the one the author cannot see the result of: its text has a terminator and no
 * escape for it, so a substituted CR or LF ends the line rather than sitting in
 * it (`http/header_text.hpp`), and its name is a map key, so a substituted name
 * can quietly take another header's place (`http/header_names.hpp`). Both files
 * carry the rule and the layers that share it.
 *
 * @return the refusal, or nothing.
 */
std::optional<std::pair<int, nlohmann::json>> resolve_compose_head (const VariableValues& vars,
const BoundColumnNames& bound_columns,
nlohmann::json& payload) {
    if (auto method = payload.find ("method");
    method != payload.end () && method->is_string ()) {
        std::string verb = method->get<std::string> ();
        std::transform (verb.begin (), verb.end (), verb.begin (),
        [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
        *method = verb;
    }

    if (auto url = payload.find ("url"); url != payload.end () && url->is_string ()) {
        *url = resolve_template (url->get<std::string> (), vars, bound_columns);
    }

    if (auto headers = payload.find ("headers");
    headers != payload.end () && headers->is_object ()) {
        auto resolved = resolve_header_block (*headers, vars, bound_columns);
        if (resolved.unspellable) {
            return compose_error (400, "unsendable_header",
            describe_header_text_refusal (*resolved.unspellable));
        }
        if (resolved.collision) {
            return compose_error (400, "colliding_header_names",
            vayu::http::describe_header_name_collision (*resolved.collision));
        }
        *headers = std::move (resolved.headers);
    }
    return std::nullopt;
}

/** The body: its content, and every string its form fields carry. */
/**
 * Every string a form field carries, including a file part's path: a fixture
 * directory is exactly the kind of thing an environment variable holds, and an
 * unresolved `{{...}}` reaching the transfer would be opened as a literal
 * filename.
 */
void resolve_form_field (const VariableValues& vars,
const BoundColumnNames& bound_columns,
nlohmann::json& field) {
    if (!field.is_object ()) {
        return;
    }
    for (const char* name : { "key", "value", "src", "fileName", "contentType" }) {
        if (auto entry = field.find (name); entry != field.end () && entry->is_string ()) {
            *entry = resolve_template (entry->get<std::string> (), vars, bound_columns);
        }
    }
}

/** The body: its content, and every string its form fields carry. */
void resolve_compose_body (const VariableValues& vars,
const BoundColumnNames& bound_columns,
nlohmann::json& payload) {
    auto it = payload.find ("body");
    if (it == payload.end ()) {
        return;
    }
    if (!it->is_object ()) {
        payload.erase ("body");
        return;
    }
    const auto mode = it->find ("mode");
    if (mode == it->end () || !mode->is_string () || mode->get<std::string> () == "none") {
        payload.erase ("body");
        return;
    }
    if (auto content = it->find ("content"); content != it->end () && content->is_string ()) {
        *content = resolve_template (content->get<std::string> (), vars, bound_columns);
    }
    if (auto fields = it->find ("fields"); fields != it->end () && fields->is_array ()) {
        for (auto& field : *fields) {
            resolve_form_field (vars, bound_columns, field);
        }
    }
}

/**
 * Auth: `inherit` resolved through the chain first, then `{{vars}}` inside
 * whatever concrete block won - strictly before any OAuth 2.0 cache key can be
 * computed from it (D10). An empty result means "send nothing", which is an
 * absent field, not a null.
 */
void resolve_compose_auth (const std::vector<vayu::db::Collection>& chain,
const VariableValues& vars,
const BoundColumnNames& bound_columns,
nlohmann::json& payload) {
    // Auth: resolve `inherit` through the chain first, then `{{vars}}` inside
    // whatever concrete block won - strictly before any OAuth 2.0 cache key can
    // be computed from it (D10). An empty result means "send nothing", which is
    // an absent field, not a null.
    if (auto it = payload.find ("auth"); it != payload.end ()) {
        nlohmann::json auth = *it;
        if (auth_mode (auth) == "inherit") {
            auth = resolve_inherited_auth (chain);
        }
        if (is_empty_auth (auth) || auth_mode (auth) == "inherit") {
            payload.erase ("auth");
        } else {
            *it = resolve_json_strings (auth, vars, bound_columns);
        }
    }
}

/**
 * The `dataColumns` field: the bare names this composition must leave to a
 * per-row bind (issue #1007).
 *
 * Names only, never values - composition happens once and a row is bound per
 * iteration, so a value here would be one row's value written into every one of
 * them. A caller that omits the field composes exactly as it always did, which
 * is what makes this additive for every client that has no dataset.
 *
 * @return the refusal, or nothing (with @p out filled).
 */
std::optional<std::pair<int, nlohmann::json>>
read_bound_columns (const nlohmann::json& body, BoundColumnNames& out) {
    const auto field = body.find ("dataColumns");
    if (field == body.end () || field->is_null ()) {
        return std::nullopt;
    }
    if (!field->is_array ()) {
        return compose_error (400, "invalid_compose_request",
        "'dataColumns' must be an array of the data file's column names");
    }
    for (const auto& entry : *field) {
        if (!entry.is_string () || entry.get<std::string> ().empty ()) {
            return compose_error (400, "invalid_compose_request",
            "'dataColumns' must hold non-empty column names - a row cannot "
            "bind "
            "a token with no name in it");
        }
        out.insert (entry.get<std::string> ());
    }
    return std::nullopt;
}

} // namespace

std::pair<int, nlohmann::json>
compose_request_core (vayu::db::Database& db, const nlohmann::json& body) {
    if (!body.is_object ()) {
        return compose_error (
        400, "invalid_compose_request", "Request body must be a JSON object");
    }

    const bool has_request_id =
    body.contains ("requestId") && !body["requestId"].is_null ();
    const bool has_inline = body.contains ("request") && !body["request"].is_null ();
    if (has_request_id && !body["requestId"].is_string ()) {
        return compose_error (400, "invalid_compose_request", "'requestId' must be a string");
    }
    if (has_inline && !body["request"].is_object ()) {
        return compose_error (400, "invalid_compose_request", "'request' must be a JSON object");
    }
    if (!has_request_id && !has_inline) {
        return compose_error (400, "invalid_compose_request",
        "Provide 'requestId' (compose a saved request) and/or 'request' (an "
        "inline request to compose)");
    }

    BoundColumnNames bound_columns;
    if (auto refusal = read_bound_columns (body, bound_columns)) {
        return *refusal;
    }

    std::optional<vayu::db::Request> stored;
    if (has_request_id) {
        stored = db.get_request (body["requestId"].get<std::string> ());
        if (!stored) {
            return compose_error (404, "request_not_found",
            "No saved request with id '" + body["requestId"].get<std::string> () + "'");
        }
    }

    std::vector<vayu::db::Collection> chain;
    std::string environment_id;
    const VariableValues vars =
    resolve_compose_variables (db, body, stored, chain, environment_id);

    // Base payload from the stored request (raw), then the inline request laid
    // over it field by field - so a `start_load_run { requestId, url }` style
    // override replaces the stored URL but keeps everything else. Inline-only
    // composition starts from an empty object. Both paths then resolve through
    // the same code below, so overrides and stored fields follow one rule.
    nlohmann::json payload =
    stored ? payload_from_stored (*stored, chain) : nlohmann::json::object ();
    if (has_inline) {
        for (const auto& [key, value] : body["request"].items ()) {
            payload[key] = value;
        }
    }

    if (auto refusal = resolve_compose_head (vars, bound_columns, payload)) {
        return *refusal;
    }
    resolve_compose_body (vars, bound_columns, payload);
    resolve_compose_auth (chain, vars, bound_columns, payload);

    // Scripts are never interpolated (D16): a `{{...}}` inside script text is
    // user JavaScript, and rewriting it cannot tell a string literal from
    // code. They pass through exactly as supplied/stored.

    if (!environment_id.empty ()) {
        payload["environmentId"] = environment_id;
    }

    return { 200, payload };
}

} // namespace vayu::http
