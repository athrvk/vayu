/**
 * @file tests/import_parse_postman_test.cpp
 * @brief Postman imports: bodies and linear-time parsing, client certificates, data-only auth,
 * scripts, headers and saved responses.
 *
 * The helpers more than one of these files reads are in `import_parse_fixture.hpp`.
 */

#include <gtest/gtest.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/import_document.hpp"
#include "wide_json.hpp"

#include "import_parse_fixture.hpp"

namespace {

using nlohmann::json;
using vayu::core::ImportOptions;
using vayu::core::ImportParse;
using vayu::core::parse_import;
using vayu::tests::import_parse::header_pairs;
using vayu::tests::import_parse::HeaderPairs;
using vayu::tests::import_parse::Names;
using vayu::tests::import_parse::names_in;
using vayu::tests::import_parse::parse_postman_items;
using vayu::tests::import_parse::POSTMAN_SCHEMA;
using vayu::tests::import_parse::request_with_script;
using vayu::tests::import_parse::skip_counts;
using vayu::tests::import_parse::skipped_count;
using vayu::tests::import_parse::skipped_named;

/**
 * A file on disk for a `certificate.cert.src` / `.key.src` to name (issue
 * #1656). The bytes only need to be *there* for most cases - `pm_certificate`
 * reuses `client_cert_rejection`, which only reads a file's first bytes to sniff
 * a format, never to validate the certificate itself, so plain text is enough
 * unless a case is specifically about format sniffing.
 */
class ScratchFile {
    public:
    explicit ScratchFile (std::string name, const std::string& contents = "not-a-real-certificate\n")
    : path_ (std::move (name)) {
        std::ofstream out (path_, std::ios::binary | std::ios::trunc);
        out.write (contents.data (), static_cast<std::streamsize> (contents.size ()));
    }
    ~ScratchFile () {
        std::error_code ec;
        std::filesystem::remove (path_, ec);
    }
    ScratchFile (const ScratchFile&)            = delete;
    ScratchFile& operator= (const ScratchFile&) = delete;
    ScratchFile (ScratchFile&&)                 = delete;
    ScratchFile& operator= (ScratchFile&&)      = delete;

    const std::string& path () const {
        return path_;
    }

    private:
    std::string path_;
};

/**
 * The Postman fields that used to be dropped with no counter (issue #1443):
 * a custom HTTP verb, an auth scheme Vayu cannot execute, a path variable, a
 * `raw`-less URL, `strictSSL`, and variable metadata. Each case is a mutation
 * check on its own counter - reverting the fix leaves the mapped field wrong
 * and the count at zero.
 */
TEST (PostmanImport, CountsAnUnsupportedMethodAndFallsBackToGet) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) +
    R"("},"item":[{"name":"R","request":{"method":"PROPFIND","url":"https://api.example.com/x"}}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    EXPECT_EQ (request.at ("method"), "GET");
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("unsupported_method"), 1);
}

/// The schema allows `item.request` to be a bare URL string (#1907): a GET to
/// that URL, its query read into a row, with nothing tallied as lost.
TEST (PostmanImport, ARequestThatIsABareUrlStringImportsAsAGetToThatUrl) {
    const ImportParse parsed = parse_import (R"({"info":{"schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},"item":[{"name":"R","request":"https://x.test/a?b=1"}]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    EXPECT_EQ (request.at ("url"), "https://x.test/a?b=1");
    EXPECT_EQ (request.at ("method"), "GET");
    ASSERT_EQ (request.at ("params").size (), 1);
    EXPECT_EQ (request.at ("params")[0].at ("key"), "b");
    EXPECT_EQ (request.at ("params")[0].at ("value"), "1");
    EXPECT_TRUE (skip_counts (parsed.result.at ("meta").at ("skipped")).empty ());
}

/// `pm_folder` recurses per nested `item`, bounded only because `read_document`
/// refuses a document past `MAX_READ_DEPTH` first (#1782): pin that the bound
/// holds for the folder shape, so the recursion cannot be reached unbounded.
TEST (PostmanImport, AFolderNestedFarPastTheDepthBoundIsRefusedNotWalked) {
    std::string open;
    std::string close;
    for (int i = 0; i < 10000; ++i) {
        open += R"({"name":"F","item":[)";
        close += "]}";
    }
    const ImportParse parsed = parse_import (R"({"info":{"schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},"item":[)" + open + close + "]}",
    {}, {});
    EXPECT_FALSE (parsed.ok ());
    EXPECT_NE (parsed.error.find ("nests deeper"), std::string::npos) << parsed.error;
}

/// A raw body is sniffed for JSON by parsing it, and the body is whatever the
/// collection's author pasted (#2497). Mutation check: parse with
/// `nlohmann::ordered_json::parse` in `postman_raw_body` and this runs for tens
/// of seconds and fails the budget.
TEST (PostmanImport, ARawBodyOfAHundredThousandMembersIsSniffedInLinearTime) {
    const std::string raw = vayu::tests::wide_object_json ();
    const json document   = {
        { "info", { { "schema", POSTMAN_SCHEMA } } },
        { "item",
        json::array ({ { { "name", "R" },
        { "request",
        { { "method", "POST" }, { "url", "https://x.com" },
        { "body", { { "mode", "raw" }, { "raw", raw } } } } } } }) },
    };
    const std::string text = document.dump ();

    const auto started       = std::chrono::steady_clock::now ();
    const ImportParse parsed = parse_import (text, {}, {});
    const auto elapsed       = std::chrono::steady_clock::now () - started;

    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
    const json& body = parsed.result.at ("collections")[0].at ("requests")[0].at ("body");
    EXPECT_EQ (body.at ("mode"), "json");
    EXPECT_EQ (body.at ("content"), raw);
}

/// A GraphQL Variables pane is read as JSON and laid back in as a value (#2497).
/// Mutation check: parse with `nlohmann::ordered_json::parse` in
/// `graphql_content` and this runs for tens of seconds and fails the budget.
TEST (PostmanImport, AGraphqlVariablesPaneOfAHundredThousandMembersIsReadInLinearTime) {
    const std::string variables = vayu::tests::wide_object_json ();
    const json document         = {
        { "info", { { "schema", POSTMAN_SCHEMA } } },
        { "item",
        json::array ({ { { "name", "R" },
        { "request",
        { { "method", "POST" }, { "url", "https://x.com" },
        { "body",
        { { "mode", "graphql" },
        { "graphql", { { "query", "{ me }" }, { "variables", variables } } } } } } } } }) },
    };
    const std::string text = document.dump ();

    const auto started       = std::chrono::steady_clock::now ();
    const ImportParse parsed = parse_import (text, {}, {});
    const auto elapsed       = std::chrono::steady_clock::now () - started;

    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
    const json& body = parsed.result.at ("collections")[0].at ("requests")[0].at ("body");
    EXPECT_EQ (body.at ("mode"), "graphql");
    EXPECT_EQ (
    json::parse (body.at ("content").get<std::string> ()).at ("variables").size (),
    vayu::tests::WIDE_OBJECT_KEYS);
}

/// A request's `auth` is a client's, and deciding whether its `postman` source
/// still stands re-reads that block as ordered JSON (#2497). Mutation check:
/// parse with `nlohmann::ordered_json::parse` in `postman_source_stands` and
/// this runs for tens of seconds and fails the budget.
TEST (PostmanImport, AStaleSourceBlockOfAHundredThousandMembersIsJudgedInLinearTime) {
    json source     = json::parse (vayu::tests::wide_object_json ());
    source["type"]  = "bearer";
    const json auth = { { "type", "bearer" }, { "postman", source } };

    const auto started = std::chrono::steady_clock::now ();
    const json stripped =
    json::parse (vayu::core::without_stale_postman_source (auth.dump ()));
    const auto elapsed = std::chrono::steady_clock::now () - started;

    EXPECT_LT (elapsed, vayu::tests::LINEAR_PARSE_BUDGET);
    EXPECT_FALSE (stripped.contains ("postman"))
    << "the block no longer maps to the stored auth, so it is dropped";
    EXPECT_EQ (stripped.at ("type"), "bearer");
}

/// The other half of the sniff: raw text that is not JSON stays text.
TEST (PostmanImport, ARawBodyThatIsNotJsonImportsAsText) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"raw","raw":"{\"a\":"}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    parsed.result.at ("collections")[0].at ("requests")[0].at ("body").at (
    "mode"),
    "text");
}

/// A body's own `disabled: true` ("prevent request body from being sent")
/// must not still be sent - counted rather than silently ignored (issue
/// #1444).
TEST (PostmanImport, ADisabledBodyImportsAsNoneAndIsCounted) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"raw","raw":"{}","disabled":true}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    parsed.result.at ("collections")[0].at ("requests")[0].at ("body").at (
    "mode"),
    "none");
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("disabled_body"), 1);
}

/**
 * Postman's `file` mode imports as a `binary` body naming the file, not as no
 * body: the path as written and its base name. It is a path on the exporting
 * machine, which the engine sends only once the user picks it again or allows
 * its folder; the parse states no trust of its own. Postman writes `src: null`
 * (or no `file` at all) until a file is chosen; that imports as no file
 * chosen. Each is counted, by request, as a file reference to relink.
 */
TEST (PostmanImport, AFileBodyImportsAsABinaryBodyNamingThePath) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"Upload","request":{"method":"PUT","url":"https://x.com/a",
            "body":{"mode":"file","file":{"src":"/home/ada/photo.png"}}}},
        {"name":"Unpicked","request":{"method":"PUT","url":"https://x.com/b",
            "body":{"mode":"file","file":{"src":null}}}},
        {"name":"Bare","request":{"method":"PUT","url":"https://x.com/c",
            "body":{"mode":"file"}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const auto& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("body").dump (),
    R"({"mode":"binary","file":{"src":"/home/ada/photo.png","fileName":"photo.png"}})");
    EXPECT_EQ (requests[1].at ("body").dump (), R"({"mode":"binary","file":{"src":""}})");
    EXPECT_EQ (requests[2].at ("body").dump (), R"({"mode":"binary","file":{"src":""}})");
    const json skipped = parsed.result.at ("meta").at ("skipped");
    EXPECT_EQ (skip_counts (skipped).at ("file_body"), 3);
    for (const json& entry : skipped) {
        if (entry.at ("kind") == "file_body") {
            EXPECT_EQ (entry.at ("requests"), (json{ "Upload", "Unpicked", "Bare" }));
        }
    }
}

/// A form-data file row with no path imports as a part with no file chosen -
/// the field is the user's, only the file is missing - rather than vanishing
/// into a count.
TEST (PostmanImport, AFileRowWithNoPathImportsAsAnUnattachedPart) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"POST","url":"https://x.com",
            "body":{"mode":"formdata","formdata":[{"key":"doc","type":"file"}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    parsed.result.at ("collections")[0].at ("requests")[0].at ("body").dump (),
    R"({"mode":"form-data","fields":[{"key":"doc","value":"","enabled":true,"type":"file","src":""}]})");
    EXPECT_EQ (parsed.result.at ("meta").at ("unattachedFileParts"), 1);
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("file_body"));
}

/// `proxy` has no per-request field to land in - Vayu's proxy config is
/// workspace/run-scoped, not per-request (`engine/CLAUDE.md`) - so it stays a
/// permanent tally, decided by issue #1656 rather than deferred by it.
TEST (PostmanImport, ProxyIsCountedRatherThanDroppedSilently) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://x.com",
            "proxy":{"host":"proxy.example.com","port":8080}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::json counts =
    skip_counts (parsed.result.at ("meta").at ("skipped"));
    EXPECT_EQ (counts.at ("proxy_config"), 1);
    EXPECT_FALSE (counts.contains ("certificate"));
    EXPECT_TRUE (parsed.result.at ("clientCertificates").empty ());
}

/// A `certificate` naming no `cert.src` at all has nothing a registry row
/// could point at - "cannot resolve" per the issue's own acceptance criteria,
/// same tally as before #1656's mapping.
TEST (PostmanImport, CertificateWithNoCertSrcIsCountedRatherThanDroppedSilently) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://x.com",
            "certificate":{"name":"c","matches":["https://x.com"]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("certificate"), 1);
    EXPECT_TRUE (parsed.result.at ("clientCertificates").empty ());
}

/// The common real-world shape: a Postman export's `cert.src` names a path on
/// the *exporting* machine, unreadable here - "cannot resolve" again, not a
/// mapping failure the way an unparseable host would be.
TEST (PostmanImport, CertificateWithAnUnreadablePathIsCountedRatherThanDroppedSilently) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://x.com",
            "certificate":{"name":"c","matches":["https://x.com"],
                "cert":{"src":"/no/such/file/on/this/machine.pem"}}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("certificate"), 1);
    EXPECT_TRUE (parsed.result.at ("clientCertificates").empty ());
}

/// `{{baseUrl}}`-style variable hosts are the common Postman shape and never
/// resolve to a hostname a registry entry could be keyed on - counted, same as
/// an unreadable file, rather than reaching the reused write-time check at all.
TEST (PostmanImport, CertificateOnAnUnresolvedVariableHostIsCountedRatherThanDroppedSilently) {
    const ScratchFile cert ("import_parse_cert_unresolved_host.pem");
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"{{baseUrl}}/pets",
            "certificate":{"name":"c","cert":{"src":")" +
    cert.path () + R"("}}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("certificate"), 1);
    EXPECT_TRUE (parsed.result.at ("clientCertificates").empty ());
}

/// A port or scheme still written as `{{name}}` parses since #3454 with the
/// braces outside the host; the certificate must still be counted, not
/// registered for the bare host.
TEST (PostmanImport, CertificateOnATemplatedPortOrSchemeIsCountedNotRegistered) {
    const ScratchFile cert ("import_parse_cert_templated_port.pem");
    const ScratchFile key ("import_parse_key_templated_port.pem");
    for (const std::string url :
    { "https://api.example.com:{{port}}/pets", "{{scheme}}://api.example.com/pets" }) {
        const ImportParse parsed =
        parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":")" +
        url + R"(",
            "certificate":{"name":"c","cert":{"src":")" +
        cert.path () + R"("},"key":{"src":")" + key.path () +
        R"("},"passphrase":"secret"}}}
    ]})",
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (skip_counts (parsed.result.at ("meta").at ("skipped")).at ("certificate"), 1)
        << url;
        EXPECT_TRUE (parsed.result.at ("clientCertificates").empty ()) << url;
    }
}

/// A `cert.src` with no `key.src` is an incomplete PEM pair - the same
/// "key file is empty" refusal `POST /client-certificates` gives a hand-written
/// entry (`client_cert_file_rejection`), so this is "cannot resolve" too, not a
/// mapping bug.
TEST (PostmanImport, CertificateWithNoKeySrcIsCountedRatherThanDroppedSilently) {
    const ScratchFile cert ("import_parse_cert_no_key.pem");
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://api.example.com/pets",
            "certificate":{"cert":{"src":")" +
    cert.path () + R"("}}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("certificate"), 1);
    EXPECT_TRUE (parsed.result.at ("clientCertificates").empty ());
}

/// The mapped case (issue #1656's acceptance criteria): a readable PEM pair
/// and a literal host builds a `clientCertificates` candidate keyed on that
/// host, and the `certificate` `SkippedItem` kind no longer fires for it.
TEST (PostmanImport, CertificateWithAReadablePemPairBuildsAClientCertificateCandidate) {
    const ScratchFile cert ("import_parse_cert_mapped.pem");
    const ScratchFile key ("import_parse_key_mapped.pem");
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"R","request":{"method":"GET","url":"https://api.example.com:8443/pets",
            "certificate":{"name":"c","matches":["https://api.example.com"],
                "cert":{"src":")" +
    cert.path () + R"("},
                "key":{"src":")" +
    key.path () + R"("},
                "passphrase":"secret"}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("certificate"));
    const nlohmann::ordered_json& candidates =
    parsed.result.at ("clientCertificates");
    ASSERT_EQ (candidates.size (), 1);
    EXPECT_EQ (candidates[0].at ("host"), "api.example.com");
    EXPECT_EQ (candidates[0].at ("port"), 8443);
    EXPECT_EQ (candidates[0].at ("certPath"), cert.path ());
    EXPECT_EQ (candidates[0].at ("keyPath"), key.path ());
    EXPECT_EQ (candidates[0].at ("certFormat"), "pem");
    EXPECT_EQ (candidates[0].at ("passphrase"), "secret");
}

/// Two requests naming the *same* certificate for the same (host, port)
/// dedupe into one candidate rather than two, and neither tallies.
TEST (PostmanImport, TwoRequestsWithTheSameCertificateForOneHostDedupe) {
    const ScratchFile cert ("import_parse_cert_dedupe.pem");
    const ScratchFile key ("import_parse_key_dedupe.pem");
    const std::string request = R"({"name":"R","request":{"method":"GET",
        "url":"https://api.example.com/pets",
        "certificate":{"cert":{"src":")" +
    cert.path () + R"("},"key":{"src":")" + key.path () + R"("},"passphrase":"secret"}}})";
    const ImportParse parsed = parse_import (R"({"info":{"schema":")" +
    std::string (POSTMAN_SCHEMA) + R"("},"item":[)" + request + "," + request + "]}",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("certificate"));
    EXPECT_EQ (parsed.result.at ("clientCertificates").size (), 1);
}

/// A second request naming a *different* certificate for a (host, port) the
/// first already claimed cannot both be registered - one row per target, so
/// the first seen wins and the second tallies rather than silently losing the
/// first (issue #1656's own "two rows claiming one target" rule, applied at
/// import time the same way the route's own 409 applies it at write time).
TEST (PostmanImport, ASecondDifferentCertificateForOneHostIsCounted) {
    const ScratchFile first ("import_parse_cert_collision_a.pem");
    const ScratchFile first_key ("import_parse_key_collision_a.pem");
    const ScratchFile second ("import_parse_cert_collision_b.pem");
    const ScratchFile second_key ("import_parse_key_collision_b.pem");
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"A","request":{"method":"GET","url":"https://api.example.com/a",
            "certificate":{"cert":{"src":")" +
    first.path () + R"("},"key":{"src":")" + first_key.path () + R"("}}}},
        {"name":"B","request":{"method":"GET","url":"https://api.example.com/b",
            "certificate":{"cert":{"src":")" +
    second.path () + R"("},"key":{"src":")" + second_key.path () + R"("}}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("certificate"), 1);
    const nlohmann::ordered_json& candidates =
    parsed.result.at ("clientCertificates");
    ASSERT_EQ (candidates.size (), 1);
    EXPECT_EQ (candidates[0].at ("certPath"), first.path ());
}

TEST (PostmanImport, CountsAnUnsupportedAuthTypeButNotAnExplicitNoAuth) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"A","request":{"method":"GET","url":"https://x.com/a",
            "auth":{"type":"custom","custom":[]}}},
        {"name":"B","request":{"method":"GET","url":"https://x.com/b",
            "auth":{"type":"noauth"}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("auth").at ("mode"), "none");
    EXPECT_EQ (requests[1].at ("auth").at ("mode"), "none");
    // Only the unsupported scheme counts - an explicit `noauth` already means
    // "send nothing", which is exactly what it mapped to.
    EXPECT_EQ (
    skip_counts (parsed.result.at ("meta").at ("skipped")).at ("unsupported_auth"), 1);
}

/// Every auth type Postman's schema defines that Vayu cannot sign is kept as
/// data, like AWS, Digest and NTLM always were: stored, not sent, counted.
TEST (PostmanImport, KeepsHawkOAuth1EdgeGridAndJwtAsDataNotSent) {
    const ImportParse parsed =
    parse_import (R"({"info":{"schema":")" + std::string (POSTMAN_SCHEMA) + R"("},"item":[
        {"name":"H","request":{"method":"GET","url":"https://x.com",
            "auth":{"type":"hawk","hawk":[{"key":"authId","value":"id"},
                {"key":"includePayloadHash","value":true,"type":"boolean"}]}}},
        {"name":"O","request":{"method":"GET","url":"https://x.com",
            "auth":{"type":"oauth1","oauth1":[{"key":"consumerKey","value":"ck"}]}}},
        {"name":"E","request":{"method":"GET","url":"https://x.com",
            "auth":{"type":"edgegrid","edgegrid":[{"key":"clientToken","value":"ct"}]}}},
        {"name":"J","request":{"method":"GET","url":"https://x.com",
            "auth":{"type":"jwt","jwt":[{"key":"algorithm","value":"HS256"}]}}}
    ]})",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");
    EXPECT_EQ (requests[0].at ("auth").at ("mode"), "hawk");
    EXPECT_EQ (requests[0].at ("auth").at ("config").at ("authId"), "id");
    EXPECT_EQ (requests[1].at ("auth").at ("mode"), "oauth1");
    EXPECT_EQ (requests[2].at ("auth").at ("mode"), "edgegrid");
    EXPECT_EQ (requests[3].at ("auth").at ("mode"), "jwt");
    EXPECT_EQ (parsed.result.at ("meta").at ("nonExecutableAuth"), 4);
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("unsupported_auth"));
}

/// A Postman auth block of @p type with one attribute, which is all a
/// data-only family needs to import as `{mode, config}`.
json postman_auth (const std::string& type) {
    return json{ { "type", type },
        { type, json::array ({ { { "key", "k" }, { "value", "v" } } }) } };
}

json postman_request_item (const std::string& name, const json& auth = nullptr) {
    json request = { { "method", "GET" }, { "url", "https://x.com/" + name } };
    if (!auth.is_null ()) {
        request["auth"] = auth;
    }
    return json{ { "name", name }, { "request", std::move (request) } };
}

json postman_folder_item (const std::string& name, const json& items, const json& auth = nullptr) {
    json folder = { { "name", name }, { "item", items } };
    if (!auth.is_null ()) {
        folder["auth"] = auth;
    }
    return folder;
}

/// A Postman v2.1 collection named "Signed API" holding @p items, under
/// @p auth when given.
ImportParse parse_postman_tree (const json& items, const json& auth = nullptr) {
    json document = { { "info", { { "name", "Signed API" }, { "schema", POSTMAN_SCHEMA } } },
        { "item", items } };
    if (!auth.is_null ()) {
        document["auth"] = auth;
    }
    return parse_import (document.dump (), {}, {});
}

/// The preview line is a list of requests to finish by hand, so the count and
/// the names are the requests whose *resolved* auth is data-only (#2537): a
/// folder that declares one is not a request, and a request that inherits it
/// is. Mutation checks: restore the folder push in `pm_folder` and "Signed" is
/// listed as a request; make an `inherit` request stop at its own mode and the
/// inheriting names go missing.
TEST (PostmanImport, CountsTheRequestsThatLoseADataOnlyAuthNotTheFolderDeclaringIt) {
    const ImportParse parsed = parse_postman_tree (json::array (
    { postman_folder_item ("Signed",
      json::array ({ postman_request_item ("Inherits A"),
      postman_folder_item ("Deeper",
      json::array ({ postman_request_item ("Inherits deep", json{ { "type", "inherit" } }) })),
      postman_request_item ("Inherits B"), postman_request_item ("Own bearer", postman_auth ("bearer")),
      postman_request_item ("Opted out", json{ { "type", "noauth" } }),
      postman_request_item ("Own digest", postman_auth ("digest")) }),
      postman_auth ("oauth1")),
    postman_request_item ("Outside") }));
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& meta = parsed.result.at ("meta");
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 4);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"),
    (Names{ "Inherits A", "Inherits deep", "Inherits B", "Own digest" }));
    EXPECT_EQ (names_in (meta, "nonExecutableAuthFolders"), Names{ "Signed" });
    EXPECT_FALSE (meta.contains ("nonExecutableAuthCollection"));
}

/// `noauth` on a folder is the end of the walk: nothing under it is sent
/// signed, however deep, while a request outside it still inherits the
/// collection's. The collection is named apart from the folders.
TEST (PostmanImport, ANoAuthFolderEndsTheWalkForDataOnlyAuth) {
    const ImportParse parsed = parse_postman_tree (
    json::array ({ postman_folder_item ("Public",
                   json::array ({ postman_folder_item ("Nested",
                   json::array ({ postman_request_item ("Still open") })) }),
                   json{ { "type", "noauth" } }),
    postman_folder_item ("Plain", json::array ({ postman_request_item ("Plain child") })),
    postman_request_item ("Top") }),
    postman_auth ("hawk"));
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& meta = parsed.result.at ("meta");
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 2);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"),
    (Names{ "Plain child", "Top" }));
    EXPECT_EQ (meta.at ("nonExecutableAuthCollection"), "Signed API");
    EXPECT_FALSE (meta.contains ("nonExecutableAuthFolders"));
}

/// A folder with no auth, or one set to inherit, is `none` in the draft and
/// `resolve_inherited_auth` walks past it; a folder with an auth of its own
/// ends the walk at that auth. Mutation check: stop at the first `none` and
/// "Through two plain folders" drops out.
TEST (PostmanImport, ARequestInheritsDataOnlyAuthThroughFoldersThatSayNothing) {
    const ImportParse parsed = parse_postman_tree (
    json::array (
    { postman_folder_item ("Plain",
      json::array ({ postman_folder_item ("Explicit inherit",
      json::array ({ postman_request_item ("Through two plain folders"),
      postman_request_item ("Opted out", json{ { "type", "noauth" } }) }),
      json{ { "type", "inherit" } }) })),
    postman_folder_item ("Shield",
    json::array ({ postman_request_item ("Shielded") }), postman_auth ("bearer")) }),
    postman_auth ("jwt"));
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& meta = parsed.result.at ("meta");
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 1);
    EXPECT_EQ (names_in (meta, "nonExecutableAuthRequests"),
    Names{ "Through two plain folders" });
    EXPECT_EQ (meta.at ("nonExecutableAuthCollection"), "Signed API");
}

/// The shape of the Twitter v2 collection (#2537): four folders declare
/// `oauth1`, 11 requests declare it themselves and 12 more inherit it, 23 in
/// all. The count it used to report was 15 - those 11 plus the four folders -
/// which named folders as requests and missed the 12.
TEST (PostmanImport, ACollectionShapedLikeTwitterReportsEveryRequestThatLosesOAuth1) {
    const auto own_requests = [] (const std::string& prefix, int count) {
        json items = json::array ();
        for (int i = 0; i < count; ++i) {
            items.push_back (postman_request_item (
            prefix + " own " + std::to_string (i), postman_auth ("oauth1")));
        }
        return items;
    };
    const auto inheriting = [] (const std::string& prefix, int count, json items) {
        for (int i = 0; i < count; ++i) {
            items.push_back (
            postman_request_item (prefix + " inherits " + std::to_string (i)));
        }
        return items;
    };
    json tweets = json::array ();
    for (int i = 0; i < 33; ++i) {
        tweets.push_back (postman_request_item ("Tweet " + std::to_string (i)));
    }
    const ImportParse parsed = parse_postman_tree (
    json::array ({ postman_folder_item ("Tweets", tweets),
    postman_folder_item ("Blocks",
    inheriting ("Blocks", 1, own_requests ("Blocks", 2)), postman_auth ("oauth1")),
    postman_folder_item ("Manage Tweets", own_requests ("Manage", 7), postman_auth ("oauth1")),
    postman_folder_item ("Mutes",
    inheriting ("Mutes", 2, own_requests ("Mutes", 1)), postman_auth ("oauth1")),
    postman_folder_item ("Lists",
    inheriting ("Lists", 9, own_requests ("Lists", 1)), postman_auth ("oauth1")) }),
    postman_auth ("bearer"));
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& meta = parsed.result.at ("meta");
    EXPECT_EQ (meta.at ("requestCount"), 56);
    EXPECT_EQ (meta.at ("nonExecutableAuth"), 23);
    const Names lost = names_in (meta, "nonExecutableAuthRequests");
    EXPECT_EQ (lost.size (), 23U);
    for (const char* folder : { "Tweets", "Blocks", "Manage Tweets", "Mutes", "Lists" }) {
        EXPECT_EQ (std::ranges::count (lost, folder), 0) << folder << " is not a request";
    }
    const auto inherits = [&lost] (const std::string& name) {
        return std::ranges::contains (lost, name);
    };
    EXPECT_TRUE (inherits ("Blocks inherits 0"));
    EXPECT_TRUE (inherits ("Mutes inherits 1"));
    EXPECT_TRUE (inherits ("Lists inherits 8"));
    EXPECT_EQ (names_in (meta, "nonExecutableAuthFolders"),
    (Names{ "Blocks", "Manage Tweets", "Mutes", "Lists" }));
    EXPECT_FALSE (meta.contains ("nonExecutableAuthCollection"));
}

/**
 * A script that uses a Postman API Vayu does not run is named, so the preview
 * can say which request to finish by hand (#2576): the request's name and the
 * names it uses, in table order. One request per family of the table here; the
 * scan's own cases are `script_api_scan_test.cpp`. Mutation check: remove a row
 * of the table in `script_api_scan.cpp` and the request using it drops out of
 * the list.
 */
TEST (PostmanImport, ScriptThatUsesAnApiVayuDoesNotRunIsNamed) {
    const std::string items =
    request_with_script ("Legacy tests",
    R"j(["tests[\"ok\"] = responseCode.code === 200;","pm.visualizer.set('<p></p>', {});"])j") +
    "," + request_with_script ("Library", R"j(["const $ = cheerio.load('x');"])j") + "," +
    request_with_script ("Module", R"j(["const c = require('cheerio');"])j") + "," +
    request_with_script (
    "Host", R"j(["setTimeout(next, 10);","await next;","Buffer.from('x');"])j") +
    "," + request_with_script ("Chai", R"j(["pm.expect(pm.response).to.be.postmanResponse;"])j") +
    "," +
    request_with_script ("Plain",
    R"j(["const j = pm.response.json();","pm.test('ok', () => pm.expect(j.id).to.be.within(1, 5));","postman.setEnvironmentVariable('id', j.id);"])j") +
    "," +
    request_with_script ("Shelf",
    R"j(["const c = require('crypto-js');","const h = CryptoJS.MD5('x');"])j") +
    "," +
    request_with_script ("Uuid",
    R"j(["const uuid = require('uuid');","const a = uuid();","const b = uuid.v4();"])j") +
    "," +
    request_with_script ("Lodash",
    R"j(["const id = _.get(pm.response.json(), 'items[0].id');","const l = require('lodash');","l.chunk([1, 2], 1);"])j") +
    "," +
    request_with_script ("Moment",
    R"j(["const moment = require('moment');","const d = moment.utc(0).format();"])j") +
    "," +
    request_with_script ("Csv",
    R"j(["const parse = require('csv-parse/lib/sync');","const rows = parse(pm.response.text(), { columns: true });"])j") +
    "," +
    request_with_script ("Xml",
    R"j(["const doc = xml2Json(pm.response.text());","require('xml2js').parseString(pm.response.text(), (e, r) => {});"])j") +
    "," +
    request_with_script ("Chai module",
    R"j(["const { expect } = require('chai');","expect(pm.response.json().id).to.equal(7);"])j") +
    "," +
    request_with_script ("Validators",
    R"j(["const v = new (require('ajv'))().compile({ type: 'object' });","v(pm.response.json());","tv4.validate(pm.response.json(), {});","require('tv4').error;"])j") +
    "," +
    request_with_script ("Cipher",
    R"j(["const c = require('crypto-js');","const e = CryptoJS.AES.encrypt('x', 'k');"])j") +
    "," +
    request_with_script ("Mentions only",
    R"j(["// CryptoJS.MD5(x); tests[0]","const s = 'require(x) postman.x';"])j");
    const ImportParse parsed = parse_postman_items (items);
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    // Postman's pre-pm.* globals and pm.visualizer run (#2577), and so do
    // the crypto-js members the shim defines (#2578), as the global and as
    // `require('crypto-js')`, so "Legacy tests" and "Shelf" are not named, and
    // `require('uuid')` runs (#2650), so "Uuid" is not either, nor is "Lodash"
    // (`_` and `require('lodash')`, #2651), "Moment" (`require('moment')`,
    // #2652), "Csv" (`require('csv-parse/lib/sync')`, #2653), "Xml"
    // (`xml2Json` and `require('xml2js')`, #2654), "Chai module"
    // (`require('chai')`, #2655) or "Validators" (`require('ajv')`, `tv4` and
    // `require('tv4')`, #2656); "Cipher" reaches past the shim and is.
    // "Module" requires a name off the shelf and is.
    EXPECT_EQ (parsed.result.at ("meta").at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (R"j([
        {"request":"Library","names":["cheerio"]},
        {"request":"Module","names":["require()"]},
        {"request":"Host","names":["Buffer"]},
        {"request":"Chai","names":[".postmanRequest / .postmanResponse / .postmanRequestOrResponse"]},
        {"request":"Cipher","names":["CryptoJS"]}
    ])j"));
    // A notice, not a drop: the scripts still import verbatim.
    EXPECT_EQ (parsed.result.at ("collections")[0]
               .at ("requests")[1]
               .at ("elements")[0]
               .at ("config")
               .at ("script"),
    "const $ = cheerio.load('x');");
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("unsupported_script_api"));
}

/// The pm members Vayu lacks or half-runs are named per request (#3462):
/// `pm.request.url.variables` and `pm.response.jsonp` are undefined at run time,
/// and `pm.response.json(reviver)` parses without the reviver. "Plain" reads the
/// body with an empty `json()`, which runs and is not named. Mutation check:
/// remove one of the three rows in `script_api_scan.cpp` and its request drops
/// out; dropping the `NoArguments` exemption names "Plain" too.
TEST (PostmanImport, PmUrlVariablesJsonpAndAJsonReviverAreNamed) {
    const std::string items = request_with_script ("Path variables",
                              R"j(["const id = pm.request.url.variables.get('id');"])j") +
    "," + request_with_script ("Jsonp", R"j(["const b = pm.response.jsonp('cb');"])j") +
    "," + request_with_script ("Reviver", R"j(["const j = pm.response.json((k, v) => v);"])j") +
    "," +
    request_with_script ("Plain",
    R"j(["const j = pm.response.json();","pm.request.url.query.get('a');"])j") +
    "," +
    request_with_script ("All three",
    R"j(["pm.response.json(r);","pm.response.jsonp(1);","pm.request.url.variables;"])j");
    const ImportParse parsed = parse_postman_items (items);
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("meta").at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (R"j([
        {"request":"Path variables","names":["pm.request.url.variables"]},
        {"request":"Jsonp","names":["pm.response.jsonp"]},
        {"request":"Reviver","names":["pm.response.json(reviver)"]},
        {"request":"All three","names":["pm.response.jsonp","pm.response.json(reviver)","pm.request.url.variables"]}
    ])j"));
}

/// A string-valued `event.script` is the script's text (Postman's SDK reads one
/// as `{exec: [text]}`), where it used to import as nothing and so was never
/// seen: it is stored, and read for the same names. Mutation check: reading it
/// as before leaves no element and no name.
TEST (PostmanImport, ReadsAStringValuedEventScriptAsItsText) {
    const ImportParse parsed = parse_postman_items (
    R"j({"name":"Old","event":[{"listen":"prerequest","script":"var h = cheerio.load(responseBody);"}],
         "request":{"method":"GET","url":"https://x.com"}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& element =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("elements")[0];
    EXPECT_EQ (element.at ("kind"), "script.pre");
    EXPECT_EQ (element.at ("config").at ("script"), "var h = cheerio.load(responseBody);");
    EXPECT_EQ (parsed.result.at ("meta").at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (R"j([{"request":"Old","names":["cheerio"]}])j"));
}

/// A non-empty `script.packages` is a use of Postman's package library, which
/// Vayu cannot load, even when the script text itself is plain `pm.*`; an empty
/// one is not.
TEST (PostmanImport, ScriptPackagesAreNamed) {
    const ImportParse parsed = parse_postman_items (
    R"j({"name":"Uses a package","event":[{"listen":"test","script":{
            "exec":["pm.test('x', () => {});"],
            "packages":{"abc":{"id":"abc","type":"collection","name":"shared"}}}}],
         "request":{"method":"GET","url":"https://x.com"}},
        {"name":"No packages","event":[{"listen":"test","script":{
            "exec":["pm.test('x', () => {});"],"packages":{}}}],
         "request":{"method":"GET","url":"https://x.com"}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("meta").at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (
    R"j([{"request":"Uses a package","names":["script.packages"]}])j"));
}

/// A folder's or the collection's script is read as a request's is, and named
/// by its own name; the collection comes after what it holds, as with
/// `nonExecutableAuthRequests`. A request's pre and test scripts are one entry.
TEST (PostmanImport, NamesAFolderAndACollectionWhoseScriptsUseThem) {
    const ImportParse parsed = parse_import (
    R"j({"info":{"name":"Signed API","schema":")j" + std::string (POSTMAN_SCHEMA) + R"j("},
        "event":[{"listen":"prerequest","script":{"exec":["Buffer.from(f);"]}}],
        "item":[
        {"name":"Reports","event":[{"listen":"test","script":{"exec":["var n = cheerio.load(h);"]}}],
         "item":[{"name":"R","event":[
             {"listen":"prerequest","script":{"exec":["var t = new Backbone.Model(x);"]}},
             {"listen":"test","script":{"exec":["const c = require('x');"]}}],
             "request":{"method":"GET","url":"https://x.com/r"}}]},
        {"name":"A","request":{"method":"GET","url":"https://x.com/a"}}
    ]})j",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("meta").at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (R"j([
        {"request":"R","names":["require()","Backbone"]},
        {"request":"Reports","names":["cheerio"]},
        {"request":"Signed API","names":["Buffer"]}
    ])j"));
}

/// A disabled event runs nothing, so it names nothing; with the scripts option
/// off nothing is imported and nothing is read. Absent, not empty, when no
/// script qualifies. Mutation check: scanning before the option gate, or
/// emitting an empty list, reds one of these.
TEST (PostmanImport, ScriptApisAreNamedOnlyForScriptsThatWouldRun) {
    const std::string legacy = request_with_script ("Legacy", R"j(["cheerio.load('a');"])j");
    ImportOptions off;
    off.import_scripts      = false;
    const ImportParse gated = parse_postman_items (legacy, off);
    ASSERT_TRUE (gated.ok ()) << gated.error;
    EXPECT_FALSE (gated.result.at ("meta").contains ("unsupportedScriptApis"));
    EXPECT_FALSE (gated.result.at ("collections")[0].at ("requests")[0].contains ("elements"));

    const ImportParse disabled = parse_postman_items (
    R"j({"name":"Off","event":[{"listen":"test","disabled":true,
            "script":{"exec":["cheerio.load('a');"]}}],
         "request":{"method":"GET","url":"https://x.com"}})j");
    ASSERT_TRUE (disabled.ok ()) << disabled.error;
    EXPECT_FALSE (
    disabled.result.at ("meta").contains ("unsupportedScriptApis"));
    EXPECT_EQ (
    disabled.result.at ("collections")[0].at ("requests")[0].at ("elements")[0].at ("enabled"),
    false);

    const ImportParse plain = parse_postman_items (
    request_with_script ("Plain", R"j(["pm.test('ok', () => {});"])j"));
    ASSERT_TRUE (plain.ok ()) << plain.error;
    EXPECT_FALSE (plain.result.at ("meta").contains ("unsupportedScriptApis"));

    // The other importers leave the member absent.
    const ImportParse spec =
    parse_import (R"({"openapi":"3.0.0","info":{"title":"T"},"paths":{}})", {}, {});
    ASSERT_TRUE (spec.ok ()) << spec.error;
    EXPECT_FALSE (spec.result.at ("meta").contains ("unsupportedScriptApis"));
}

/// A script Postman would run but Vayu cannot import is counted and its owner
/// named, rather than vanishing (#2541): a `script.src` (Postman reads it as a
/// URL and ignores `exec` beside it) and a `listen` Vayu has no phase for. A
/// folder and the collection are named like a request, the collection last. A
/// blank unknown-listen script is nothing to lose, and `script.packages` stays
/// with `unsupportedScriptApis` alone. Mutation check: dropping the count in
/// `set_event_elements`, or the naming in `pm_folder`, reds the count or the
/// list; counting a packages-only event reds the last assertion.
TEST (PostmanImport, CountsAScriptItCannotImportAndNamesItsOwner) {
    const ImportParse parsed = parse_import (
    R"j({"info":{"name":"Signed API","schema":")j" + std::string (POSTMAN_SCHEMA) + R"j("},
        "event":[{"listen":"afterResponse","script":{"exec":["pm.test('x', () => {});"]}}],
        "item":[
        {"name":"Reports",
         "event":[{"listen":"test","script":{"type":"text/javascript","src":"https://example.com/folder.js"}}],
         "item":[
           {"name":"From URL","event":[{"listen":"test","script":{"src":"https://example.com/check.js"}}],
            "request":{"method":"GET","url":"https://x.com/r"}},
           {"name":"Both","event":[{"listen":"prerequest","script":{
              "src":"https://example.com/both.js","exec":["pm.environment.set('a', 1);"]}}],
            "request":{"method":"GET","url":"https://x.com/b"}},
           {"name":"Odd listen","event":[{"listen":"beforeRequest","script":{"exec":["pm.test('x', () => {});"]}}],
            "request":{"method":"GET","url":"https://x.com/o"}}]},
        {"name":"Blank odd listen","event":[{"listen":"beforeRequest","script":{"exec":["  "]}}],
         "request":{"method":"GET","url":"https://x.com/blank"}},
        {"name":"Packages only","event":[{"listen":"test","script":{
            "exec":["pm.test('x', () => {});"],"packages":{"abc":{"id":"abc"}}}}],
         "request":{"method":"GET","url":"https://x.com/p"}},
        {"name":"Fine","event":[{"listen":"test","script":{"exec":["pm.test('x', () => {});"]}}],
         "request":{"method":"GET","url":"https://x.com/f"}}
    ]})j",
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const json& meta = parsed.result.at ("meta");
    // From URL, Both, Odd listen, the folder and the collection: one event each.
    EXPECT_EQ (skip_counts (meta.at ("skipped")).at ("script_unsupported"), 5);
    EXPECT_EQ (skipped_named (parsed, "script_unsupported"),
    (Names{ "From URL", "Both", "Odd listen", "Reports", "Signed API" }));

    // Nothing of an event with no phase or a `src` is imported, `exec` beside
    // a `src` included: Postman would not run it.
    const json& root     = parsed.result.at ("collections")[0];
    const json& reports  = root.at ("children")[0];
    const json& requests = reports.at ("requests");
    EXPECT_FALSE (root.contains ("elements"));
    EXPECT_FALSE (reports.contains ("elements"));
    for (const json& request : requests) {
        EXPECT_FALSE (request.contains ("elements")) << request.at ("name");
    }
    EXPECT_EQ (root.at ("requests")[2].at ("elements")[0].at ("kind"), "script.post");

    // The packages are named once, by the scan that already reported them.
    EXPECT_EQ (meta.at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (
    R"j([{"request":"Packages only","names":["script.packages"]}])j"));
}

/// A disabled event runs nothing so it counts nothing, and with the scripts
/// option off no script is read at all. Mutation check: counting before the
/// `disabled` test, or outside the `import_scripts` gate, reds one of the two.
TEST (PostmanImport, ScriptUnsupportedIsNotCountedWhenTheEventWouldNotRun) {
    const std::string items =
    R"j({"name":"Off","event":[{"listen":"test","disabled":true,"script":{"src":"https://example.com/a.js"}},
                                   {"listen":"beforeRequest","disabled":true,"script":{"exec":["x();"]}}],
         "request":{"method":"GET","url":"https://x.com"}},
        {"name":"On","event":[{"listen":"test","script":{"src":"https://example.com/a.js"}}],
         "request":{"method":"GET","url":"https://x.com"}})j";

    const ImportParse counted = parse_postman_items (items);
    ASSERT_TRUE (counted.ok ()) << counted.error;
    EXPECT_EQ (
    skip_counts (counted.result.at ("meta").at ("skipped")).at ("script_unsupported"), 1);
    EXPECT_EQ (skipped_named (counted, "script_unsupported"), Names{ "On" });

    ImportOptions off;
    off.import_scripts      = false;
    const ImportParse gated = parse_postman_items (items, off);
    ASSERT_TRUE (gated.ok ()) << gated.error;
    EXPECT_FALSE (
    skip_counts (gated.result.at ("meta").at ("skipped")).contains ("script_unsupported"));
}

/// An event whose `exec` is blank still declares its packages, and the early
/// `continue` on a blank script used to skip naming them. Mutation check:
/// moving the packages note back below the blank-script `continue` reds this.
TEST (PostmanImport, NamesPackagesOnAnEventWithNoScriptText) {
    const ImportParse parsed = parse_postman_items (
    R"j({"name":"Blank with packages","event":[{"listen":"test","script":{
            "exec":[""],"packages":{"abc":{"id":"abc","type":"collection"}}}}],
         "request":{"method":"GET","url":"https://x.com"}},
        {"name":"Disabled with packages","event":[{"listen":"test","disabled":true,"script":{
            "exec":[""],"packages":{"abc":{"id":"abc"}}}}],
         "request":{"method":"GET","url":"https://x.com"}})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_EQ (parsed.result.at ("meta").at ("unsupportedScriptApis"),
    nlohmann::ordered_json::parse (
    R"j([{"request":"Blank with packages","names":["script.packages"]}])j"));
    EXPECT_FALSE (
    skip_counts (parsed.result.at ("meta").at ("skipped")).contains ("script_unsupported"));
}

json header_request (const std::string& name, const std::string& header) {
    return { { "name", name },
        { "request",
        { { "method", "GET" }, { "url", "https://x.com" }, { "header", header } } } };
}

/// The v2.1 schema allows `request.header` to be the text of the headers pane;
/// it used to import as no headers at all. Read as postman-collection's
/// `Header.parse` reads it: a line is `name: value` with the value trimmed,
/// lines with no colon, leading whitespace or a space before the colon name
/// nothing, folded lines join, and CRLF and LF both end a line. The Hawk line
/// keeps its own colons. Mutation check: reading only an array reds this.
TEST (PostmanImport, ReadsAStringRequestHeaderTheWayPostmanParsesIt) {
    const std::string hawk =
    R"(Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", )"
    R"(ext="some-app-ext-data", mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=")";
    const json document      = { { "info", { { "schema", POSTMAN_SCHEMA } } },
        { "item",
        json::array ({ header_request ("Crlf",
                       "Authorization: " + hawk +
                       "\r\nContent-Type: application/json\r\n"
                       "X-Folded: one\r\n  two\r\n\tthree\r\n"
                       "no colon here\r\n"
                       "\r\n"
                       " Indented: skipped\r\n"
                       "Spaced : skipped\r\n"
                       "Empty:\r\n"
                       "X-Time:   12:30:45  \r\n"),
        header_request ("Lf", "A: 1\nB:{{ token }}\n") }) } };
    const ImportParse parsed = parse_import (document.dump (), {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& requests = parsed.result.at ("collections")[0].at ("requests");

    EXPECT_EQ (header_pairs (requests[0].at ("headers")),
    (HeaderPairs{ { "Authorization", hawk }, { "Content-Type", "application/json" },
    { "X-Folded", "one two three" }, { "Empty", "" }, { "X-Time", "12:30:45" } }));
    EXPECT_EQ (header_pairs (requests[1].at ("headers")),
    (HeaderPairs{ { "A", "1" }, { "B", "{{token}}" } }));
}

/// A saved response's `header` takes the same string form (the same helper
/// reads it), so its Content-Type is still found. Mutation check: reading only
/// an array leaves the example with no headers and no content type.
TEST (PostmanImport, ReadsAStringHeaderOnASavedResponse) {
    const ImportParse parsed = parse_postman_items (
    R"j({"name":"R","request":{"method":"GET","url":"https://x.com"},
         "response":[{"name":"ok","code":200,
            "header":"Content-Type: application/json\nX-Trace: a:b\n","body":"{}"}]})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& example =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("examples")[0];
    EXPECT_EQ (header_pairs (example.at ("headers")),
    (HeaderPairs{ { "Content-Type", "application/json" }, { "X-Trace", "a:b" } }));
    EXPECT_EQ (example.at ("contentType"), "application/json");
}

/// A saved response whose code is not a final status is one the import leaves
/// out and counts rather than failing the document (#3117, #3424): `POST
/// /import/apply` refuses a code outside 200-599 and ignores a fractional one,
/// storing it as the default 200, so the example would fail the apply or
/// document a different status. The 1xx pair is the interim responses; `0` and
/// `600` are outside the range from either end, `200.5` and `600.0` are no
/// servable status, and `404.0` and `2e2` are whole numbers that Postman's own
/// export can write for a status, so they import as the integers 404 and 200.
/// Mutation check: narrowing the predicate back to 1xx keeps the `0`, `600`,
/// `200.5` and `600.0` rows; testing `is_number_integer` instead of the value
/// drops the `404.0` and `2e2` rows.
TEST (PostmanImport, LeavesOutASavedResponseWhoseCodeIsNotAFinalStatus) {
    const ImportParse parsed = parse_postman_items (
    R"j({"name":"R","request":{"method":"GET","url":"https://x.com"},
         "response":[{"name":"continue","code":100,"body":""},
                     {"name":"upgrade","code":101,"body":""},
                     {"name":"zero","code":0,"body":""},
                     {"name":"past","code":600,"body":""},
                     {"name":"fraction","code":200.5,"body":""},
                     {"name":"floatPast","code":600.0,"body":""},
                     {"name":"ok","code":200,"body":"{}"},
                     {"name":"whole","code":404.0,"body":""},
                     {"name":"exponent","code":2e2,"body":""},
                     {"name":"edge","code":599,"body":""}]})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& examples =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("examples");
    ASSERT_EQ (examples.size (), 4u);
    const std::vector<int> expected = { 200, 404, 200, 599 };
    for (size_t index = 0; index < expected.size (); ++index) {
        // The apply reads a status only as a JSON integer.
        EXPECT_TRUE (examples[index].at ("status").is_number_integer ()) << index;
        EXPECT_EQ (examples[index].at ("status").get<int> (), expected[index]) << index;
    }
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "malformed_item"), 6);
}

/// A `code` that is not a number is not judged: the example imports as the 200
/// Postman shows for one with no code. Mutation check: dropping the is-a-number
/// guard of the predicate counts the first row as malformed.
TEST (PostmanImport, KeepsASavedResponseWhoseCodeIsNotANumberAsA200) {
    const ImportParse parsed = parse_postman_items (
    R"j({"name":"R","request":{"method":"GET","url":"https://x.com"},
         "response":[{"name":"text","code":"OK","body":""},
                     {"name":"none","body":""}]})j");
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& examples =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("examples");
    ASSERT_EQ (examples.size (), 2u);
    EXPECT_EQ (examples[0].at ("status"), 200);
    EXPECT_EQ (examples[1].at ("status"), 200);
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "malformed_item"), 0);
}

/// A saved response whose body is past `request_example::MAX_BODY_BYTES` is one
/// `POST /import/apply` refuses, which would fail the whole import (#3431), so
/// the import leaves it out and counts it while the request and the responses
/// within the limit still import. The body at exactly the limit is kept.
/// Mutation check: removing the size predicate imports the oversize row and the
/// count reads 0.
TEST (PostmanImport, LeavesOutASavedResponseWhoseBodyIsOverTheLimit) {
    constexpr size_t LIMIT = vayu::core::constants::request_example::MAX_BODY_BYTES;
    const json item          = { { "name", "R" },
        { "request", { { "method", "GET" }, { "url", "https://x.com" } } },
        { "response",
        { { { "name", "over" }, { "code", 200 }, { "body", std::string (LIMIT + 1, 'x') } },
        { { "name", "at" }, { "code", 200 }, { "body", std::string (LIMIT, 'x') } },
        { { "name", "small" }, { "code", 200 }, { "body", "{}" } } } } };
    const ImportParse parsed = parse_postman_items (item.dump ());
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& request = parsed.result.at ("collections")[0].at ("requests")[0];
    const json& examples = request.at ("examples");
    ASSERT_EQ (examples.size (), 2u);
    EXPECT_EQ (examples[0].at ("name"), "at");
    EXPECT_EQ (examples[0].at ("body").get<std::string> ().size (), LIMIT);
    EXPECT_EQ (examples[1].at ("name"), "small");
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "malformed_item"), 1);
}

/// A request keeps its first `request_example::MAX_PER_REQUEST` saved responses
/// and each one past that is counted, because `POST /import/apply` refuses a
/// request carrying more (#3431) and would fail the whole import.
/// Mutation check: removing the cap imports all MAX_PER_REQUEST + 1 and the
/// count reads 0.
TEST (PostmanImport, KeepsOnlyTheFirstSavedResponsesUpToThePerRequestCap) {
    constexpr size_t CAP = vayu::core::constants::request_example::MAX_PER_REQUEST;
    json responses = json::array ();
    for (size_t index = 0; index <= CAP; ++index) {
        responses.push_back ({ { "name", "r" + std::to_string (index) },
        { "code", 200 }, { "body", "" } });
    }
    const json item          = { { "name", "R" },
        { "request", { { "method", "GET" }, { "url", "https://x.com" } } },
        { "response", std::move (responses) } };
    const ImportParse parsed = parse_postman_items (item.dump ());
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const json& examples =
    parsed.result.at ("collections")[0].at ("requests")[0].at ("examples");
    ASSERT_EQ (examples.size (), CAP);
    EXPECT_EQ (examples.front ().at ("name"), "r0");
    EXPECT_EQ (examples.back ().at ("name"), "r" + std::to_string (CAP - 1));
    EXPECT_EQ (skipped_count (parsed.result.at ("meta"), "malformed_item"), 1);
}

} // namespace
