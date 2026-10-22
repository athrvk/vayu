#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/script_api_scan.hpp
 * @brief Which Postman script APIs an imported script uses that Vayu does not
 *        run (issues #2576, #2527).
 *
 * A Postman script that leans on a bundled library or a module imports with a
 * clean preview and throws at first use - and a signing pre-request that throws
 * still lets the request go out unsigned. This is the notice's source: a fixed,
 * table-driven list of names, found by reading the script as tokens rather than
 * as text.
 *
 * It is a notice, so it errs toward naming too much: a `cheerio` the script
 * reads from somewhere unusual may be named. What it must not do is miss one of
 * the listed names, and the two
 * places a plain text search would miss or invent one - a name that only
 * appears in a comment or a string, and a name the script declares itself - are
 * why the text is stripped first and a declared name is not counted.
 *
 * A row of the table is retired in the commit that makes Vayu run the API
 * (#2527 phases b and c, #2528 for the chai spellings), not before: a name
 * Vayu now runs would otherwise be reported as one it does not.
 */

#include <cstddef>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::core {

/**
 * @brief @p source with comments, string and template-literal text and
 *        regular-expression bodies blanked: each byte becomes a space (newlines
 *        kept) so a position in the result is the same position in @p source.
 *        The quotes stay, and so does code inside a template's `${ }`.
 *
 * Not a JavaScript parser. A `/` is a regular expression only after a
 * character that cannot end an operand or a keyword that takes one (`return`,
 * `typeof`, `case`, ...), and an unterminated string or regular expression
 * ends at its line, so a stray quote costs one line of scanning and never the
 * rest of the script.
 */
[[nodiscard]] std::string strip_comments_and_literals (std::string_view source);

/// The names one request, folder or collection uses across all its scripts.
class UnsupportedScriptApis {
    public:
    /// Adds every listed name @p script uses. Safe on any text: an unparsable
    /// script contributes whatever its tokens show.
    void scan (std::string_view script);

    /// A non-empty `script.packages`: a package library Vayu has no way to load.
    void note_packages ();

    [[nodiscard]] bool empty () const {
        return used_.empty ();
    }

    /// The names used, without repeats, in the order of the table.
    [[nodiscard]] std::vector<std::string> names () const;

    private:
    std::set<std::size_t> used_;
};

} // namespace vayu::core
