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
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

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
    /// Inside the braces of an async function's body (see `AsyncFrames`).
    bool in_async = false;
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

/// Whether only whitespace and one dot lies between two tokens.
bool joined_by_dot (std::string_view code, const Token& previous, std::size_t begin) {
    const std::string_view gap = code.substr (previous.end, begin - previous.end);
    return gap.find_first_not_of (" \t\r\n.?") == std::string_view::npos &&
    std::ranges::count (gap, '.') == 1;
}

/**
 * The brace frames of the code view, so a token can be asked whether it stands
 * inside an async function. An `async` that introduces a function sets a
 * pending flag, and the next `{` opens an async frame; any other `{` opens a
 * plain one, and `}` closes the innermost. An `await` is a syntax error only
 * outside every async frame, so a plain frame inside an async one still counts
 * as async.
 *
 * An arrow function with an expression body (`async x => await y`) has no
 * brace, so its `await` reads as top level and may be named when it need not
 * be: the notice errs toward naming too much, and the flag is dropped at the
 * `=>` so the next block is not taken for the arrow's body.
 */
class AsyncFrames {
    public:
    [[nodiscard]] bool inside () const {
        return async_open_ > 0;
    }

    void expect_body () {
        pending_ = true;
    }

    /// Reads the non-identifier character at @p at.
    void punctuation (std::string_view code, std::size_t at) {
        switch (code[at]) {
        case '{': open (); break;
        case '}': close (); break;
        case ';': pending_ = false; break;
        case '=':
            if (at + 1 < code.size () && code[at + 1] == '>' &&
            next_significant (code, at + 2) != '{') {
                pending_ = false;
            }
            break;
        default: break;
        }
    }

    private:
    std::vector<bool> frames_;
    int async_open_ = 0;
    bool pending_   = false;

    void open () {
        frames_.push_back (pending_);
        if (pending_) {
            ++async_open_;
        }
        pending_ = false;
    }

    void close () {
        if (frames_.empty ()) {
            return;
        }
        if (frames_.back ()) {
            --async_open_;
        }
        frames_.pop_back ();
    }
};

/// Whether an `async` ending at @p end introduces a function or method:
/// `async function`, `async (`, `async x =>`, `async *gen`, `async [key]`.
/// `async = ...` and `async.each` are the npm package's name.
bool starts_async_function (std::string_view code, std::size_t end) {
    const char next = next_significant (code, end);
    return next == '(' || next == '[' || next == '*' || is_identifier_char (next);
}

std::vector<Token> tokenize (std::string_view code) {
    std::vector<Token> tokens;
    AsyncFrames frames;
    std::size_t at = 0;
    while (at < code.size ()) {
        if (!is_identifier_char (code[at])) {
            frames.punctuation (code, at);
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
        joined_by_dot (code, tokens.back (), token.begin);
        token.in_async = frames.inside ();
        if (!token.member && code.substr (token.begin, token.end - token.begin) == "async" &&
        starts_async_function (code, token.end)) {
            frames.expect_body ();
        }
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
 * The names the script declares itself. A script with its own `data` or `_` is
 * not reading Postman's global of that name, and counting it would name nearly
 * every script that keeps a response in `data`. A name is declared by a
 * binding keyword, a parameter list, or sitting before `=>`.
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
    /// Not a property of something: a name in scope (`responseBody`, `pm`).
    Bare,
    /// A property: after a `.` (`.postmanRequest`).
    Member,
    /// A name in scope that is not inside an async function: `await` there is
    /// a syntax error, and inside one it is the language.
    OutsideAsync,
    /// Not found by the token pass; `UnsupportedScriptApis` sets it directly.
    Elsewhere,
};

/**
 * One API Vayu does not run.
 *
 * @p path is dotted words that must follow one another as a property path;
 * `|` separates alternatives for a word (`include|contain.keys`).
 * @p follow, when set, lists the characters one of which must come next (after
 * whitespace): `tests` is the legacy global only as `tests[`, and a bare
 * `data` is a variable more often than the iteration data.
 */
struct ApiRule {
    std::string_view name;
    Anchor anchor;
    std::string_view path;
    std::string_view follow;
};

/// The table, in the order names are reported. The name is what the person
/// sees: the spelling to search for in their script.
constexpr auto API_RULES = std::to_array<ApiRule> ({
// Legacy globals from before `pm.*`.
{ "tests[]", Anchor::Bare, "tests", "[" },
{ "responseBody", Anchor::Bare, "responseBody", "" },
{ "responseCode", Anchor::Bare, "responseCode", "" },
{ "responseHeaders", Anchor::Bare, "responseHeaders", "" },
{ "responseCookies", Anchor::Bare, "responseCookies", "" },
{ "responseTime", Anchor::Bare, "responseTime", "" },
{ "postman.*", Anchor::Bare, "postman", "." },
{ "globals.*", Anchor::Bare, "globals", "." },
{ "environment.*", Anchor::Bare, "environment", "." },
{ "data", Anchor::Bare, "data", "[." },
// Modules and the libraries Postman bundles.
{ "require()", Anchor::Bare, "require", "(" },
{ "pm.require", Anchor::Bare, "pm.require", "" },
{ "script.packages", Anchor::Elsewhere, "", "" },
{ "CryptoJS", Anchor::Bare, "CryptoJS", "" },
{ "_", Anchor::Bare, "_", "" },
{ "tv4", Anchor::Bare, "tv4", "" },
{ "xml2Json", Anchor::Bare, "xml2Json", "" },
{ "cheerio", Anchor::Bare, "cheerio", "" },
{ "moment", Anchor::Bare, "moment", "" },
{ "Backbone", Anchor::Bare, "Backbone", "" },
// The host environment a sandbox does not have.
{ "setTimeout", Anchor::Bare, "setTimeout", "" },
{ "setInterval", Anchor::Bare, "setInterval", "" },
{ "Buffer", Anchor::Bare, "Buffer", "" },
{ "top-level await", Anchor::OutsideAsync, "await", "" },
// `pm.*` members Vayu does not have.
{ "pm.visualizer", Anchor::Bare, "pm.visualizer", "" },
{ "pm.variables.set", Anchor::Bare, "pm.variables.set", "" },
{ "pm.test.skip", Anchor::Bare, "pm.test.skip", "" },
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

constexpr std::size_t PACKAGES_RULE = rule_index ("script.packages");
static_assert (PACKAGES_RULE < API_RULES.size (),
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
    case Anchor::OutsideAsync: return !token.member && !token.in_async;
    case Anchor::Elsewhere: break;
    }
    return false;
}

/// Whether @p rule's path starts at token @p first.
bool path_matches (std::string_view code,
const std::vector<Token>& tokens,
std::size_t first,
const ApiRule& rule) {
    if (!anchored_at (rule.anchor, tokens.at (first))) {
        return false;
    }
    std::string_view path = rule.path;
    std::size_t at        = first;
    while (!path.empty ()) {
        if (at >= tokens.size () || (at > first && !tokens.at (at).chained) ||
        !is_one_of (take_word (path), word_of (code, tokens.at (at)))) {
            return false;
        }
        ++at;
    }
    if (rule.follow.empty ()) {
        return true;
    }
    const char next = next_significant (code, tokens.at (at - 1).end);
    return next != '\0' && rule.follow.find (next) != std::string_view::npos;
}

/// A rule of one bare word names a global; it does not when the script has its
/// own variable of that name.
bool is_declared_global (const ApiRule& rule, const Declarations& declared) {
    return rule.anchor == Anchor::Bare &&
    rule.path.find ('.') == std::string_view::npos && declared.contains (rule.path);
}

} // namespace

std::string strip_comments_and_literals (std::string_view source) {
    return Stripper (source).run ();
}

void UnsupportedScriptApis::scan (std::string_view script) {
    const std::string code          = strip_comments_and_literals (script);
    const std::vector<Token> tokens = tokenize (code);
    const Declarations declared (code, tokens);

    for (std::size_t first = 0; first < tokens.size (); ++first) {
        for (std::size_t row = 0; row < API_RULES.size (); ++row) {
            const ApiRule& rule = API_RULES.at (row);
            if (!used_.contains (row) && !tokens.at (first).number &&
            path_matches (code, tokens, first, rule) &&
            !is_declared_global (rule, declared)) {
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
