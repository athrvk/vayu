/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/script_api_scan.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "vayu/runtime/shelf_modules.hpp"

namespace vayu::core {

namespace {

// ---------------------------------------------------------------------------
// Stripping
// ---------------------------------------------------------------------------

constexpr std::string_view WHITESPACE = " \t\r\n";

bool is_identifier_char (char c) {
    // A byte of a multi-byte character is part of an identifier: a name in
    // another script is not any name this table lists, and not a separator.
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c == '_' || c == '$' || static_cast<unsigned char> (c) >= 0x80;
}

/// The index one past the identifier that starts at @p at.
std::size_t identifier_end (std::string_view code, std::size_t at) {
    while (at < code.size () && is_identifier_char (code[at])) {
        ++at;
    }
    return at;
}

/// The index where the identifier ending at @p last begins.
std::size_t identifier_begin (std::string_view code, std::size_t last) {
    while (last > 0 && is_identifier_char (code[last - 1])) {
        --last;
    }
    return last;
}

/// The characters after which a `/` begins a regular expression rather than
/// dividing: everything that cannot end an operand. `)` and `]` end one, so
/// they are absent.
constexpr std::string_view REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";

/// The words after which a `/` also begins a regular expression: each takes an
/// operand, so `return /"/.test(x)` is not a division. Any other word ends one.
constexpr auto REGEX_KEYWORDS = std::to_array<std::string_view> ({ "return",
"typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do" });

/// One pass over a script; see `strip_comments_and_literals`.
class Stripper {
    public:
    explicit Stripper (std::string_view source)
    : src_ (source), code_ (source) {
    }

    std::string run () {
        while (at_ < src_.size ()) {
            step ();
        }
        return std::move (code_);
    }

    private:
    std::string_view src_;
    std::string code_;
    std::size_t at_ = 0;
    /// The last character that was neither whitespace nor inside a literal,
    /// and where it stands; what decides whether a `/` opens a regular
    /// expression. The position is only read when the character is part of a
    /// word, to find the word.
    char last_           = '\0';
    std::size_t last_at_ = 0;
    /// One entry per open `${` of a template literal: the braces opened inside
    /// it and not yet closed, so the `}` that ends the expression is found.
    std::vector<int> braces_;

    void step () {
        const char c = src_[at_];
        switch (c) {
        case '/': slash (); return;
        case '\'':
        case '"': quoted (c); return;
        case '`':
            ++at_;
            template_body ();
            return;
        case '{':
            if (!braces_.empty ()) {
                ++braces_.back ();
            }
            break;
        case '}':
            if (!braces_.empty () && braces_.back () == 0) {
                braces_.pop_back ();
                ++at_;
                template_body ();
                return;
            }
            if (!braces_.empty ()) {
                --braces_.back ();
            }
            break;
        default: break;
        }
        if (WHITESPACE.find (c) == std::string_view::npos) {
            last_    = c;
            last_at_ = at_;
        }
        ++at_;
    }

    static void blank (std::string& view, std::size_t from, std::size_t to) {
        for (std::size_t i = from; i < std::min (to, view.size ()); ++i) {
            if (view[i] != '\n' && view[i] != '\r') {
                view[i] = ' ';
            }
        }
    }

    void slash () {
        const char next = at_ + 1 < src_.size () ? src_[at_ + 1] : '\0';
        if (next == '/') {
            const std::size_t end = std::min (src_.find ('\n', at_), src_.size ());
            comment (end);
        } else if (next == '*') {
            const std::size_t close = src_.find ("*/", at_ + 2);
            comment (close == std::string_view::npos ? src_.size () : close + 2);
        } else if (last_ == '\0' || REGEX_PRECEDERS.find (last_) != std::string_view::npos ||
        follows_regex_keyword ()) {
            regex ();
        } else {
            last_ = '/';
            ++at_;
        }
    }

    /// Whether the word that ends at `last_at_` is one of REGEX_KEYWORDS. A
    /// property of that name (`list.delete / 2`) is not the keyword.
    [[nodiscard]] bool follows_regex_keyword () const {
        if (!is_identifier_char (last_)) {
            return false;
        }
        const std::size_t begin = identifier_begin (src_, last_at_);
        const std::size_t before = src_.substr (0, begin).find_last_not_of (WHITESPACE);
        if (before != std::string_view::npos && src_[before] == '.') {
            return false;
        }
        return std::ranges::contains (
        REGEX_KEYWORDS, src_.substr (begin, last_at_ + 1 - begin));
    }

    void comment (std::size_t end) {
        blank (code_, at_, end);
        at_ = end;
    }

    /// A quoted string from its opening quote to its closing one, or to the
    /// end of the line when it never closes.
    void quoted (char quote) {
        ++at_;
        const std::size_t start = at_;
        while (at_ < src_.size () && src_[at_] != quote && src_[at_] != '\n') {
            at_ += src_[at_] == '\\' ? 2U : 1U;
        }
        at_ = std::min (at_, src_.size ());
        blank (code_, start, at_);
        if (at_ < src_.size () && src_[at_] == quote) {
            ++at_;
        }
        last_ = quote;
    }

    /// A regular-expression literal, from its opening `/`. A `/` inside a
    /// character class does not close it.
    void regex () {
        ++at_;
        const std::size_t start = at_;
        bool in_class           = false;
        while (at_ < src_.size () && src_[at_] != '\n' && (in_class || src_[at_] != '/')) {
            if (src_[at_] == '[') {
                in_class = true;
            } else if (src_[at_] == ']') {
                in_class = false;
            }
            at_ += src_[at_] == '\\' ? 2U : 1U;
        }
        at_ = std::min (at_, src_.size ());
        blank (code_, start, at_);
        if (at_ < src_.size () && src_[at_] == '/') {
            ++at_;
        }
        last_ = '/';
    }

    /// Template text from just after a backtick, or just after the `}` that
    /// ended a `${ }`, up to the closing backtick or the next `${`. Returns to
    /// the main loop at a `${` so the expression is read as code.
    void template_body () {
        const std::size_t start = at_;
        while (at_ < src_.size ()) {
            const char c = src_[at_];
            if (c == '`') {
                blank (code_, start, at_);
                ++at_;
                last_ = '`';
                return;
            }
            if (c == '$' && at_ + 1 < src_.size () && src_[at_ + 1] == '{') {
                blank (code_, start, at_);
                at_ += 2;
                braces_.push_back (0);
                last_ = '{';
                return;
            }
            at_ += c == '\\' ? 2U : 1U;
        }
        blank (code_, start, src_.size ());
        at_ = src_.size ();
    }
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// An identifier (or a number, which is skipped whole so `0x1F` is not an
/// identifier `x1F`) of the code view.
struct Token {
    std::size_t begin = 0;
    std::size_t end   = 0;
    /// Preceded by a `.` or `?.` - a property, not a name in scope. A spread
    /// `...x` is not a property access.
    bool member = false;
    /// Preceded by a `.` that follows the previous token directly, so the two
    /// are one dotted path (`pm . variables`).
    bool chained = false;
    bool number  = false;
};

bool starts_number (char c) {
    return c >= '0' && c <= '9';
}

/// The first non-whitespace character from @p at, or `'\0'`.
char next_significant (std::string_view code, std::size_t at) {
    const std::size_t found = code.find_first_not_of (WHITESPACE, at);
    return found == std::string_view::npos ? '\0' : code[found];
}

bool follows_property_dot (std::string_view code, std::size_t begin) {
    const std::string_view before = code.substr (0, begin);
    const std::size_t dot         = before.find_last_not_of (WHITESPACE);
    if (dot == std::string_view::npos || before[dot] != '.') {
        return false;
    }
    return dot == 0 || before[dot - 1] != '.';
}

/// Whether only whitespace and one dot lies between the offset @p previous_end
/// and @p begin.
bool joined_by_dot (std::string_view code, std::size_t previous_end, std::size_t begin) {
    const std::string_view gap = code.substr (previous_end, begin - previous_end);
    return gap.find_first_not_of (" \t\r\n.?") == std::string_view::npos &&
    std::ranges::count (gap, '.') == 1;
}

std::vector<Token> tokenize (std::string_view code) {
    std::vector<Token> tokens;
    std::size_t at = 0;
    while (at < code.size ()) {
        if (!is_identifier_char (code[at])) {
            ++at;
            continue;
        }
        Token token;
        token.begin   = at;
        token.number  = starts_number (code[at]);
        at            = identifier_end (code, at);
        token.end     = at;
        token.member  = follows_property_dot (code, token.begin);
        token.chained = token.member && !tokens.empty () &&
        joined_by_dot (code, tokens.back ().end, token.begin);
        tokens.push_back (token);
    }
    return tokens;
}

std::string_view word_of (std::string_view code, const Token& token) {
    return code.substr (token.begin, token.end - token.begin);
}

// ---------------------------------------------------------------------------
// Names the script declares
// ---------------------------------------------------------------------------

/// For each bracket of @p code, the index of the bracket it pairs with, and
/// `npos` for every other byte and for a bracket the script never pairs. The
/// kinds are not told apart: any closer closes the innermost open bracket, so
/// a script with mismatched brackets still pairs most of what it holds. One pass
/// for every question the scan asks of a bracket, rather than a scan from each.
std::vector<std::size_t> pair_brackets (std::string_view code) {
    std::vector<std::size_t> partner (code.size (), std::string_view::npos);
    std::vector<std::size_t> open;
    for (std::size_t i = 0; i < code.size (); ++i) {
        if (std::string_view ("([{").find (code[i]) != std::string_view::npos) {
            open.push_back (i);
        } else if (std::string_view (")]}").find (code[i]) != std::string_view::npos &&
        !open.empty ()) {
            partner[i]            = open.back ();
            partner[open.back ()] = i;
            open.pop_back ();
        }
    }
    return partner;
}

/// A keyword that introduces a name, and the brackets that may follow it
/// holding more (`const { a, b } =`, `function (a, b)`, `catch (e)`).
struct BindingKeyword {
    std::string_view word;
    std::string_view openers;
};

constexpr auto BINDING_KEYWORDS = std::to_array<BindingKeyword> ({
{ "var", "{[" },
{ "let", "{[" },
{ "const", "{[" },
{ "function", "(" },
{ "class", "" },
{ "catch", "(" },
});

/**
 * The names the script declares itself. A script with its own `_` or `moment`
 * is not reading Postman's global of that name, and counting it would name
 * every script that keeps a value under one of those words. A name is declared
 * by a binding keyword, a parameter list, or sitting before `=>`.
 *
 * Scope is the whole script: a name declared anywhere stops being counted
 * anywhere, which can hide a global used beside a local of the same name, a
 * case too rare to be worth tracking scopes for.
 */
class Declarations {
    public:
    Declarations (std::string_view code, const std::vector<Token>& tokens)
    : code_ (code), tokens_ (tokens), partner_ (pair_brackets (code)) {
        for (const Token& token : tokens_) {
            if (token.member) {
                continue;
            }
            const auto keyword = std::ranges::find (
            BINDING_KEYWORDS, word_of (code_, token), &BindingKeyword::word);
            if (keyword != BINDING_KEYWORDS.end ()) {
                declare_after (token.end, keyword->openers);
            }
        }
        declare_arrow_parameters ();
        declare_spans ();
    }

    [[nodiscard]] bool contains (std::string_view name) const {
        return names_.contains (name);
    }

    /// The bracket pairing of the code, see `pair_brackets`.
    [[nodiscard]] const std::vector<std::size_t>& brackets () const {
        return partner_;
    }

    private:
    std::string_view code_;
    const std::vector<Token>& tokens_;
    std::vector<std::size_t> partner_;
    /// The (open, close) of every bracket pair whose identifiers are all
    /// declared. Read by `declare_spans`, so pairs nested in one another (a
    /// minified script's, or `var [var [var [...`) are not each walked again.
    std::vector<std::pair<std::size_t, std::size_t>> spans_;
    /// Views into @c code_.
    std::unordered_set<std::string_view> names_;

    void declare_within (std::size_t open, std::size_t close) {
        if (open == std::string_view::npos || close == std::string_view::npos) {
            return;
        }
        spans_.emplace_back (open, close);
    }

    /// Declares every identifier between the brackets of each recorded pair,
    /// walking each token once however the pairs nest or overlap.
    void declare_spans () {
        std::ranges::sort (spans_);
        auto token            = tokens_.begin ();
        std::size_t walked_to = 0;
        for (const auto& [open, close] : spans_) {
            const std::size_t from = std::max (open + 1, walked_to);
            token = std::ranges::lower_bound (token, tokens_.end (), from, {}, &Token::begin);
            for (; token != tokens_.end () && token->end <= close; ++token) {
                if (!token->number) {
                    names_.insert (word_of (code_, *token));
                }
            }
            walked_to = std::max (walked_to, close + 1);
        }
    }

    /// What a binding keyword ending at @p from introduces: the name after it,
    /// and what a bracket after that (or directly) holds.
    void declare_after (std::size_t from, std::string_view openers) {
        std::size_t at = code_.find_first_not_of (WHITESPACE, from);
        if (at == std::string_view::npos) {
            return;
        }
        if (is_identifier_char (code_[at])) {
            const std::size_t end = identifier_end (code_, at);
            names_.insert (code_.substr (at, end - at));
            at = code_.find_first_not_of (WHITESPACE, end);
        }
        if (at != std::string_view::npos &&
        openers.find (code_[at]) != std::string_view::npos) {
            declare_within (at, partner_.at (at));
        }
    }

    /// `x => ...` and `(a, b) => ...`.
    void declare_arrow_parameters () {
        for (std::size_t arrow                 = code_.find ("=>");
        arrow != std::string_view::npos; arrow = code_.find ("=>", arrow + 2)) {
            const std::size_t last = code_.substr (0, arrow).find_last_not_of (WHITESPACE);
            if (last == std::string_view::npos) {
                continue;
            }
            if (code_[last] == ')') {
                declare_within (partner_.at (last), last);
            } else if (is_identifier_char (code_[last])) {
                const std::size_t begin = identifier_begin (code_, last);
                names_.insert (code_.substr (begin, last + 1 - begin));
            }
        }
    }
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/// Where a row's first word may stand.
enum class Anchor : std::uint8_t {
    /// Not a property of something: a name in scope (`Buffer`, `pm`).
    Bare,
    /// A property: after a `.` (`.postmanRequest`).
    Member,
    /// Not found by the token pass; `UnsupportedScriptApis` sets it directly.
    Elsewhere,
};

/// A use of a rule's path that Vayu does run.
enum class Exemption : std::uint8_t {
    None,
    /// `require('<a module on the shelf>')`: the call's argument is a string
    /// literal naming one of `vayu::runtime::SHELF_MODULE_NAMES`.
    ShelfModule,
    /// A bare `CryptoJS`, or a path of members the shim defines
    /// (`vayu::runtime::CRYPTO_JS_MEMBERS`); anything else under it throws.
    /// Reads through an alias or a destructure are `CryptoJsReads`'s, not the row's.
    CryptoJsMember,
};

/**
 * One API Vayu does not run.
 *
 * @p path is dotted words that must follow one another as a property path;
 * `|` separates alternatives for a word (`include|contain.keys`).
 * @p follow, when set, lists the characters one of which must come next (after
 * whitespace): `require` is the module loader only as `require(`.
 * @p exempt names a use the rule still lets through.
 */
struct ApiRule {
    std::string_view name;
    Anchor anchor;
    std::string_view path;
    std::string_view follow;
    Exemption exempt = Exemption::None;
};

/// The table, in the order names are reported. The name is what the person
/// sees: the spelling to search for in their script.
constexpr auto API_RULES = std::to_array<ApiRule> ({
// Modules and the libraries Postman bundles.
{ "require()", Anchor::Bare, "require", "(", Exemption::ShelfModule },
{ "pm.require", Anchor::Bare, "pm.require", "" },
{ "script.packages", Anchor::Elsewhere, "", "" },
{ "_", Anchor::Bare, "_", "" },
{ "tv4", Anchor::Bare, "tv4", "" },
{ "xml2Json", Anchor::Bare, "xml2Json", "" },
{ "cheerio", Anchor::Bare, "cheerio", "" },
{ "moment", Anchor::Bare, "moment", "" },
{ "Backbone", Anchor::Bare, "Backbone", "" },
// The host environment a sandbox does not have.
{ "Buffer", Anchor::Bare, "Buffer", "" },
// Only the members the crypto-js shim lacks (#2578), read off the global, an
// alias of it or a destructure of it (#2628); the ones it has are exempt.
{ "CryptoJS", Anchor::Bare, "CryptoJS", "", Exemption::CryptoJsMember },
// `pm.*` members Vayu does not have.
{ "pm.variables.set", Anchor::Bare, "pm.variables.set", "" },
{ "pm.test.skip", Anchor::Bare, "pm.test.skip", "" },
{ "pm.execution.runRequest", Anchor::Bare, "pm.execution.runRequest", "" },
// chai-postman members `pm.expect` still refuses by name (#2528); every
// other member of chai and chai-postman runs (`chai-conformance.json`).
{ ".postmanRequest / .postmanResponse / .postmanRequestOrResponse",
Anchor::Member, "postmanRequest|postmanResponse|postmanRequestOrResponse", "" },
});

constexpr std::size_t rule_index (std::string_view name) {
    for (std::size_t i = 0; i < API_RULES.size (); ++i) {
        if (API_RULES.at (i).name == name) {
            return i;
        }
    }
    return API_RULES.size ();
}

constexpr std::size_t PACKAGES_RULE         = rule_index ("script.packages");
constexpr std::string_view CRYPTO_JS_GLOBAL = "CryptoJS";
constexpr std::size_t CRYPTO_JS_RULE        = rule_index (CRYPTO_JS_GLOBAL);
static_assert (PACKAGES_RULE < API_RULES.size () && CRYPTO_JS_RULE < API_RULES.size (),
"a row the scan sets directly is missing from the table");

/// The next dotted word of @p path, removed from it.
std::string_view take_word (std::string_view& path) {
    const std::size_t dot       = path.find ('.');
    const std::string_view word = path.substr (0, dot);
    path = dot == std::string_view::npos ? std::string_view () : path.substr (dot + 1);
    return word;
}

/// Whether @p word is one of the `|`-separated alternatives in @p options.
bool is_one_of (std::string_view options, std::string_view word) {
    while (true) {
        const std::size_t bar = options.find ('|');
        if (options.substr (0, bar) == word) {
            return true;
        }
        if (bar == std::string_view::npos) {
            return false;
        }
        options.remove_prefix (bar + 1);
    }
}

bool anchored_at (Anchor anchor, const Token& token) {
    switch (anchor) {
    case Anchor::Bare: return !token.member;
    case Anchor::Member: return token.member;
    case Anchor::Elsewhere: break;
    }
    return false;
}

/// The index one past the last token of @p rule's path when it starts at token
/// @p first, or nothing when it does not.
std::optional<std::size_t> path_end (std::string_view code,
const std::vector<Token>& tokens,
std::size_t first,
const ApiRule& rule) {
    if (!anchored_at (rule.anchor, tokens.at (first))) {
        return std::nullopt;
    }
    std::string_view path = rule.path;
    std::size_t at        = first;
    while (!path.empty ()) {
        if (at >= tokens.size () || (at > first && !tokens.at (at).chained) ||
        !is_one_of (take_word (path), word_of (code, tokens.at (at)))) {
            return std::nullopt;
        }
        ++at;
    }
    if (rule.follow.empty ()) {
        return at;
    }
    const char next = next_significant (code, tokens.at (at - 1).end);
    if (next == '\0' || rule.follow.find (next) == std::string_view::npos) {
        return std::nullopt;
    }
    return at;
}

/// The text of the string literal that opens at @p quote, read from @p script:
/// the stripped @p code keeps the quotes and blanks what lies between, so the
/// closing quote is the next one in it. Empty when the literal never closes.
std::string_view
literal_text (std::string_view script, std::string_view code, std::size_t quote) {
    const std::size_t close = code.find (code[quote], quote + 1);
    if (close == std::string_view::npos) {
        return {};
    }
    return script.substr (quote + 1, close - quote - 1);
}

/// The offset one past the `)` of the call whose `(` follows @p callee_end, when
/// it passes one string literal that names a module on the shelf. A computed
/// name (`require(name)`), a template with a `${ }` and a second argument are
/// all refused: the scan cannot say what they load, and a notice errs toward
/// naming.
std::optional<std::size_t>
shelf_require_end (std::string_view script, std::string_view code, std::size_t callee_end) {
    const std::size_t open = code.find_first_not_of (WHITESPACE, callee_end);
    if (open == std::string_view::npos || code[open] != '(') {
        return std::nullopt;
    }
    const std::size_t quote = code.find_first_not_of (WHITESPACE, open + 1);
    if (quote == std::string_view::npos ||
    std::string_view ("'\"`").find (code[quote]) == std::string_view::npos) {
        return std::nullopt;
    }
    const std::string_view name = literal_text (script, code, quote);
    if (name.empty () || !vayu::runtime::is_shelf_module (name)) {
        return std::nullopt;
    }
    const std::size_t close =
    code.find_first_not_of (WHITESPACE, quote + name.size () + 2);
    if (close == std::string_view::npos || code[close] != ')') {
        return std::nullopt;
    }
    return close + 1;
}

/// The script being read: its text, the stripped view of it, and what both hold.
struct ScanInput {
    std::string_view script;
    std::string_view code;
    const std::vector<Token>& tokens;
    const Declarations& declared;
};

/// A read of members off a value that holds the crypto-js namespace at @p path
/// (empty for the whole of it): the expression read so far ends at the code
/// offset @p end, and token @p next is the first one after it.
struct PathCursor {
    std::size_t next = 0;
    std::size_t end  = 0;
    std::string path;
};

/// Whether @p path holds members of its own, or the whole namespace when empty.
bool holds_namespace (std::string_view path) {
    return path.empty () || vayu::runtime::is_crypto_js_namespace (path);
}

/// Whether token @p next is a property read off the expression that ends at
/// the offset @p end.
bool continues_path (const ScanInput& in, std::size_t next, std::size_t end) {
    return next < in.tokens.size () && in.tokens.at (next).member &&
    joined_by_dot (in.code, end, in.tokens.at (next).begin);
}

/// Walks the members read from @p at, leaving it at the last one that is listed.
/// Whatever follows the first leaf of the list (`CryptoJS.enc.Hex.stringify`)
/// belongs to the value, so the walk stops there. False for a member the shim
/// lacks or a computed one (`CryptoJS[name]`, `CryptoJS.enc[name]`), which cannot
/// be read: a notice errs toward naming.
bool follow_members (const ScanInput& in, PathCursor& at) {
    while (holds_namespace (at.path)) {
        if (!continues_path (in, at.next, at.end)) {
            return next_significant (in.code, at.end) != '[';
        }
        at.path += (at.path.empty () ? "" : ".");
        at.path += word_of (in.code, in.tokens.at (at.next));
        if (!vayu::runtime::is_crypto_js_member (at.path)) {
            return false;
        }
        at.end = in.tokens.at (at.next).end;
        ++at.next;
    }
    return true;
}

/// Whether the `CryptoJS` at token @p root is used the way the shim supports:
/// bare, or followed by a path of listed members.
bool crypto_js_use_is_supported (const ScanInput& in, std::size_t root) {
    PathCursor at{ root + 1, in.tokens.at (root).end, {} };
    return follow_members (in, at);
}

/// Whether the use of @p rule whose path ends before token @p end is one Vayu runs.
bool is_exempt_use (const ApiRule& rule, const ScanInput& in, std::size_t end) {
    switch (rule.exempt) {
    case Exemption::None: break;
    case Exemption::ShelfModule:
        return shelf_require_end (in.script, in.code, in.tokens.at (end - 1).end)
        .has_value ();
    case Exemption::CryptoJsMember:
        return crypto_js_use_is_supported (in, end - 1);
    }
    return false;
}

/// A rule of one bare word names a global; it does not when the script has its
/// own variable of that name. `CryptoJS` is the exception: a script declares it
/// as `const CryptoJS = require('crypto-js')`, which is the same object, so the
/// declaration says nothing about which members it has.
bool is_declared_global (const ApiRule& rule, const Declarations& declared) {
    return rule.exempt != Exemption::CryptoJsMember && rule.anchor == Anchor::Bare &&
    rule.path.find ('.') == std::string_view::npos && declared.contains (rule.path);
}

/// Whether @p rule's path starts at token @p first and is a use Vayu does not run.
bool is_unsupported_use (const ScanInput& in, std::size_t first, const ApiRule& rule) {
    if (in.tokens.at (first).number) {
        return false;
    }
    const auto end = path_end (in.code, in.tokens, first, rule);
    if (!end || is_declared_global (rule, in.declared)) {
        return false;
    }
    return !is_exempt_use (rule, in, *end);
}

// The one module on the shelf is crypto-js, so `require('<a shelf module>')` is
// the namespace itself; tell them apart here when a second one joins.
static_assert (vayu::runtime::SHELF_MODULE_NAMES.size () == 1);

bool is_variable_keyword (std::string_view word) {
    return word == "const" || word == "let" || word == "var";
}

/**
 * The crypto-js members a script reads without writing `CryptoJS.<member>`
 * (#2628), which the table row cannot see: `const C = CryptoJS; C.AES`,
 * `require('crypto-js').AES`, and `const { AES } = CryptoJS`.
 *
 * Names are followed in one pass, in the order the script declares them. A name
 * is bound by a declaration whose value is the namespace, or a namespace under
 * it (`const enc = CryptoJS.enc`, `const { enc } = ...`), and every later
 * mention of it is read like `CryptoJS` itself. Out of scope, as the
 * whole-script scope of `Declarations` is: a reassignment (`C = CryptoJS`), a
 * second declarator of a statement (`var a = 1, C = CryptoJS`), a name passed
 * through a parameter or a property, and a name shadowed in another scope.
 * A notice for a local of the same name beats a script that throws.
 */
class CryptoJsReads {
    public:
    explicit CryptoJsReads (const ScanInput& in)
    : in_ (in), brackets_ (in.declared.brackets ()) {
    }

    /// Whether any read in the script reaches a member the shim lacks.
    [[nodiscard]] bool reaches_unsupported_member () {
        for (std::size_t i = 0; i < in_.tokens.size (); ++i) {
            if (in_.tokens.at (i).begin >= skip_until_ && !token_is_supported (i)) {
                return true;
            }
        }
        return false;
    }

    private:
    const ScanInput& in_;
    const std::vector<std::size_t>& brackets_;
    /// Name to the namespace path it holds, empty for all of it. Keys are views
    /// into the code.
    std::unordered_map<std::string_view, std::string> aliases_;
    /// The names a declaration binds are not reads of an alias.
    std::size_t skip_until_ = 0;

    /// Whether the use at token @p at is one the shim supports.
    bool token_is_supported (std::size_t at) {
        const Token& token = in_.tokens.at (at);
        if (token.member || token.number) {
            return true;
        }
        if (is_variable_keyword (word_of (in_.code, token))) {
            return read_declaration (token.end);
        }
        auto cursor = root_at (at);
        return !cursor || follow_members (in_, *cursor);
    }

    /// The index of the first token that begins at or after the offset @p from.
    [[nodiscard]] std::size_t token_from (std::size_t from) const {
        return static_cast<std::size_t> (
        std::ranges::lower_bound (in_.tokens, from, {}, &Token::begin) -
        in_.tokens.begin ());
    }

    /// Where a read of the namespace starts at token @p at: the global, a name
    /// bound to it, or a `require` of the shelf.
    [[nodiscard]] std::optional<PathCursor> root_at (std::size_t at) const {
        const Token& token          = in_.tokens.at (at);
        const std::string_view word = word_of (in_.code, token);
        if (word == CRYPTO_JS_GLOBAL) {
            return PathCursor{ at + 1, token.end, {} };
        }
        if (const auto alias = aliases_.find (word); alias != aliases_.end ()) {
            return PathCursor{ at + 1, token.end, alias->second };
        }
        if (word != "require") {
            return std::nullopt;
        }
        const auto end = shelf_require_end (in_.script, in_.code, token.end);
        if (!end) {
            return std::nullopt;
        }
        return PathCursor{ token_from (*end), *end, {} };
    }

    /// The namespace a binding pattern ending at @p pattern_end is assigned
    /// (`= CryptoJS.enc`), read as far as it is a listed path.
    [[nodiscard]] std::optional<PathCursor> source_after (std::size_t pattern_end) const {
        const std::size_t equals = code_after (pattern_end);
        if (equals == std::string_view::npos || in_.code[equals] != '=') {
            return std::nullopt;
        }
        const std::size_t start = code_after (equals + 1);
        if (start == std::string_view::npos) {
            return std::nullopt;
        }
        const std::size_t first = token_from (start);
        if (first >= in_.tokens.size () ||
        in_.tokens.at (first).begin != start || in_.tokens.at (first).member) {
            return std::nullopt;
        }
        auto cursor = root_at (first);
        if (!cursor || !follow_members (in_, *cursor)) {
            return std::nullopt;
        }
        return cursor;
    }

    [[nodiscard]] std::size_t code_after (std::size_t from) const {
        return in_.code.find_first_not_of (WHITESPACE, from);
    }

    /// Binds @p name to @p path when it holds members to read; a leaf is a
    /// value the shim already owns.
    void bind (std::string_view name, const std::string& path) {
        if (holds_namespace (path)) {
            aliases_.insert_or_assign (name, path);
        }
    }

    /// `const C = CryptoJS` or `const { AES } = CryptoJS`, after the keyword
    /// ending at @p keyword_end. False for a destructure that reads a member the
    /// shim lacks.
    bool read_declaration (std::size_t keyword_end) {
        const std::size_t pattern = code_after (keyword_end);
        if (pattern == std::string_view::npos) {
            return true;
        }
        if (in_.code[pattern] == '{') {
            return read_destructure (pattern);
        }
        if (is_identifier_char (in_.code[pattern])) {
            bind_name (pattern);
        }
        return true;
    }

    void bind_name (std::size_t name_begin) {
        const std::size_t name_end = identifier_end (in_.code, name_begin);
        skip_until_                = name_end;
        const auto source          = source_after (name_end);
        if (!source || next_significant (in_.code, source->end) == '(') {
            return;
        }
        bind (in_.code.substr (name_begin, name_end - name_begin), source->path);
    }

    bool read_destructure (std::size_t open) {
        const std::size_t close = brackets_.at (open);
        if (close == std::string_view::npos || close < open) {
            return true;
        }
        const auto source = source_after (close + 1);
        if (!source || !holds_namespace (source->path)) {
            return true;
        }
        skip_until_ = close + 1;
        return entries_are_supported (open, close, source->path);
    }

    /// The offset of the `,` that ends the entry starting at @p begin, or @p close.
    [[nodiscard]] std::size_t entry_end (std::size_t begin, std::size_t close) const {
        std::size_t at = begin;
        while (at < close && in_.code[at] != ',') {
            const std::size_t partner = brackets_.at (at);
            at = partner != std::string_view::npos && partner > at ?
            std::min (partner + 1, close) :
            at + 1;
        }
        return at;
    }

    bool entries_are_supported (std::size_t open, std::size_t close, const std::string& prefix) {
        for (std::size_t begin = open + 1; begin < close;) {
            const std::size_t end = entry_end (begin, close);
            if (!entry_is_supported (begin, end, prefix)) {
                return false;
            }
            begin = end + 1;
        }
        return true;
    }

    /// One entry of a pattern whose source holds @p prefix: `AES`, `AES: a`,
    /// `AES = d`, `enc: { Hex }`, `...rest`, `[key]: v`.
    bool entry_is_supported (std::size_t from, std::size_t end, const std::string& prefix) {
        const std::size_t begin = code_after (from);
        if (begin >= end) {
            return true;
        }
        if (in_.code[begin] == '[') {
            return false;
        }
        if (in_.code.substr (begin, 3) == "...") {
            bind_rest (begin + 3, prefix);
            return true;
        }
        const auto [key, key_end] = key_at (begin);
        std::string path          = prefix;
        path += (path.empty () ? "" : ".");
        path += key;
        if (key.empty () || !vayu::runtime::is_crypto_js_member (path)) {
            return false;
        }
        const std::size_t after = code_after (key_end);
        if (after >= end || in_.code[after] != ':') {
            bind (in_.code.substr (begin, key_end - begin), path);
            return true;
        }
        return value_is_supported (code_after (after + 1), end, path);
    }

    /// What the pattern after `key:` binds: a name for the member, or a nested
    /// pattern for the members under it.
    bool value_is_supported (std::size_t value, std::size_t end, const std::string& path) {
        if (value >= end) {
            return true;
        }
        if (is_identifier_char (in_.code[value])) {
            const std::size_t name_end = identifier_end (in_.code, value);
            bind (in_.code.substr (value, name_end - value), path);
            return true;
        }
        const std::size_t close = brackets_.at (value);
        if (in_.code[value] != '{' || close == std::string_view::npos ||
        close >= end || !holds_namespace (path)) {
            return true;
        }
        return entries_are_supported (value, close, path);
    }

    /// `...rest` holds what the pattern left of the namespace at @p prefix.
    void bind_rest (std::size_t from, const std::string& prefix) {
        const std::size_t name = code_after (from);
        if (name != std::string_view::npos && is_identifier_char (in_.code[name])) {
            bind (in_.code.substr (name, identifier_end (in_.code, name) - name), prefix);
        }
    }

    /// The property a pattern entry starting at @p begin names, and where it
    /// ends: a word, or a quoted string read from the original text (the
    /// stripped code has blanked it). Empty for anything else.
    [[nodiscard]] std::pair<std::string, std::size_t> key_at (std::size_t begin) const {
        if (is_identifier_char (in_.code[begin])) {
            const std::size_t end = identifier_end (in_.code, begin);
            return { std::string (in_.code.substr (begin, end - begin)), end };
        }
        if (in_.code[begin] != '\'' && in_.code[begin] != '"') {
            return { {}, begin };
        }
        const std::string_view text = literal_text (in_.script, in_.code, begin);
        return { std::string (text), begin + text.size () + 2 };
    }
};

} // namespace

std::string strip_comments_and_literals (std::string_view source) {
    return Stripper (source).run ();
}

void UnsupportedScriptApis::scan (std::string_view script) {
    const std::string code          = strip_comments_and_literals (script);
    const std::vector<Token> tokens = tokenize (code);
    const Declarations declared (code, tokens);
    const ScanInput in{ script, code, tokens, declared };

    if (CryptoJsReads (in).reaches_unsupported_member ()) {
        used_.insert (CRYPTO_JS_RULE);
    }
    for (std::size_t first = 0; first < tokens.size (); ++first) {
        for (std::size_t row = 0; row < API_RULES.size (); ++row) {
            if (!used_.contains (row) &&
            is_unsupported_use (in, first, API_RULES.at (row))) {
                used_.insert (row);
            }
        }
    }
}

void UnsupportedScriptApis::note_packages () {
    used_.insert (PACKAGES_RULE);
}

std::vector<std::string> UnsupportedScriptApis::names () const {
    std::vector<std::string> out;
    out.reserve (used_.size ());
    for (const std::size_t row : used_) {
        out.emplace_back (API_RULES.at (row).name);
    }
    return out;
}

} // namespace vayu::core
