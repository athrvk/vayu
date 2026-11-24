/**
 * @file script_engine_require_test.cpp
 * @brief require() and the first half of its shelf: the digests, encoders, uuid, lodash,
 *        moment, csv-parse and xml2js.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <array>
#include <chrono>
#include <cstddef>
#include <string>

#include "library_call_config.hpp"
#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

using vayu::tests::library_call_config;
using vayu::tests::shelf_answer;
using vayu::tests::ShelfAnswer;

// ============================================================================
// require() and its shelf (#2578)
// ============================================================================
//
// Known answers, as for pm.crypto: FIPS 180's "abc" for each digest, the empty
// string's MD5, and RFC 2202 / RFC 4231 test case 2 (key "Jefe") for each
// HMAC.


// The acceptance case: Postman's signing call, through require.
TEST_F (ScriptEngineTest, RequireShelfHmacSha256MatchesTheReferenceDigest) {
    auto result = engine.execute_prerequest (R"JS(
        var CryptoJS = require('crypto-js');
        var signature = CryptoJS.HmacSHA256('what do ya want for nothing?', 'Jefe');
        pm.environment.set('signature', signature.toString(CryptoJS.enc.Hex));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["signature"].value,
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
}

TEST_F (ScriptEngineTest, RequireShelfDigestsMatchKnownVectors) {
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "CryptoJS.MD5('')", "d41d8cd98f00b204e9800998ecf8427e" },
    { "CryptoJS.SHA1('abc')", "a9993e364706816aba3e25717850c26c9cd0d89d" },
    { "CryptoJS.SHA224('abc')", "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7" },
    { "CryptoJS.SHA256('abc')", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    { "CryptoJS.SHA384('abc')",
    "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072"
    "ba1e7cc2358baeca134c825a7" },
    { "CryptoJS.SHA512('abc')",
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992"
    "a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f" },
    { "CryptoJS.HmacMD5(JEFE, 'Jefe')", "750c783e6ab0b503eaa86e310a5db738" },
    { "CryptoJS.HmacSHA1(JEFE, 'Jefe')", "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79" },
    { "CryptoJS.HmacSHA224(JEFE, 'Jefe')", "a30e01098bc6dbbf45690f3a7e9e6d0f8bbea2a39e6148008fd05e44" },
    { "CryptoJS.HmacSHA256(JEFE, 'Jefe')", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" },
    { "CryptoJS.HmacSHA384(JEFE, 'Jefe')",
    "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240"
    "ca5e69e2c78b3239ecfab21649" },
    { "CryptoJS.HmacSHA512(JEFE, 'Jefe')",
    "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf"
    "75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737" },
    // A WordArray message hashes its bytes, as the same string does.
    { "CryptoJS.SHA256(CryptoJS.enc.Utf8.parse('abc'))",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    // The digest as base64, the other form a signature header takes.
    { "CryptoJS.SHA256('abc').toString(CryptoJS.enc.Base64)", "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=" },
    { "CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA1(JEFE, 'Jefe'))", "7/zfauXrL6LSdBbV8YTfnCWafHk=" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (engine, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

TEST_F (ScriptEngineTest, RequireShelfEncodersMatchKnownAnswers) {
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    // Base64's three padding cases, RFC 4648 section 10.
    { "CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('f'))", "Zg==" },
    { "CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('fo'))", "Zm8=" },
    { "CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('foo'))", "Zm9v" },
    { "CryptoJS.enc.Base64.parse('Zm8=').toString(CryptoJS.enc.Utf8)", "fo" },
    { "CryptoJS.enc.Base64.parse('Zm9v\\nYmFy').toString(CryptoJS.enc.Utf8)", "foobar" },
    { "CryptoJS.enc.Hex.parse('00ff10').toString(CryptoJS.enc.Base64)", "AP8Q" },
    // UTF-8 both ways, through a two- and a three-byte character.
    { "CryptoJS.enc.Utf8.parse('\\u00e9\\u20ac').toString()", "c3a9e282ac" },
    { "CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse('c3a9e282ac'))", "\xc3\xa9\xe2\x82\xac" },
    { "CryptoJS.enc.Latin1.stringify(CryptoJS.enc.Hex.parse('48e9'))", "H\xc3\xa9" },
    { "CryptoJS.enc.Latin1.parse('H\\u00e9').toString()", "48e9" },
    { "CryptoJS.lib.WordArray.create(new Uint8Array([1, 2, 255])).toString()", "0102ff" },
    { "CryptoJS.lib.WordArray.create([0x01020304], 3).toString()", "010203" },
    { "CryptoJS.enc.Utf8.parse('ab').concat(CryptoJS.enc.Utf8.parse('c'))"
      ".toString(CryptoJS.enc.Utf8)",
    "abc" },
    { "CryptoJS.SHA1('abc').clone().sigBytes", "20" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (engine, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A digest is a key: the AWS SigV4 signing-key chain Postman scripts write with
// crypto-js, against the published example key DigestBytesCanBeFedBackAsAKey
// checks pm.crypto against.
TEST_F (ScriptEngineTest, RequireShelfHmacTakesAWordArrayKey) {
    auto result = engine.execute_prerequest (R"JS(
        var kDate = CryptoJS.HmacSHA256('20150830', 'AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
        var kRegion = CryptoJS.HmacSHA256('us-east-1', kDate);
        var kService = CryptoJS.HmacSHA256('iam', kRegion);
        pm.environment.set('kSigning', CryptoJS.HmacSHA256('aws4_request', kService).toString());
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["kSigning"].value,
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
}

TEST_F (ScriptEngineTest, RequireShelfAnswersOneModuleForRequireAndTheGlobal) {
    EXPECT_EQ (
    shelf_answer (engine, request,
    "typeof CryptoJS + ' ' + (require('crypto-js') === CryptoJS) + ' ' + "
    "(require('crypto-js') === require('crypto-js'))"),
    "object true true");
}

TEST_F (ScriptEngineTest, RequireShelfRefusesANameOffTheShelf) {
    const std::string refusal = shelf_answer (engine, request, "require('nope')");
    EXPECT_NE (refusal.find ("Cannot find module 'nope'"), std::string::npos) << refusal;
    EXPECT_NE (refusal.find ("(crypto-js, uuid, lodash, moment, "
                             "csv-parse/lib/sync, xml2js, chai, ajv, tv4)"),
    std::string::npos)
    << "the refusal names the shelf: " << refusal;
    EXPECT_NE (refusal.find ("reads no file and fetches nothing"), std::string::npos)
    << refusal;

    // A script that catches the refusal goes on, as it would under Node.
    EXPECT_EQ (
    shelf_answer (engine, request,
    "(function () { try { require('fs'); } catch (e) { return e instanceof "
    "Error; } })()"),
    "true");

    const std::string not_a_name = shelf_answer (engine, request, "require(42)");
    EXPECT_NE (not_a_name.find ("TypeError"), std::string::npos) << not_a_name;
    EXPECT_NE (not_a_name.find ("module name string"), std::string::npos) << not_a_name;
}

// Hashing the text "[object Object]" or "42" would be a digest that looks
// right; every one of these throws, naming the call.
TEST_F (ScriptEngineTest, RequireShelfRefusesInputItCannotHashHonestly) {
    constexpr auto REFUSED = std::to_array<ShelfAnswer> ({
    { "CryptoJS.SHA256(42)", "CryptoJS.SHA256 takes a string or a WordArray, not number" },
    { "CryptoJS.MD5({})", "CryptoJS.MD5 takes a string or a WordArray, not object" },
    { "CryptoJS.HmacSHA256('m', null)", "CryptoJS.HmacSHA256 key takes a string or a WordArray, not null" },
    { "CryptoJS.HmacSHA1(undefined, 'k')",
    "CryptoJS.HmacSHA1 message takes a string or a WordArray, not undefined" },
    { "CryptoJS.enc.Hex.parse('abc')", "is not an even number of hex digits" },
    { "CryptoJS.enc.Hex.parse('zz')", "is not an even number of hex digits" },
    { "CryptoJS.enc.Base64.parse('Zm9v!')", "is not a base64 digit" },
    { "CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse('ff'))", "Malformed UTF-8 data" },
    { "CryptoJS.enc.Hex.stringify('abc')", "CryptoJS.enc.Hex.stringify takes a WordArray, not string" },
    });
    for (const auto& refused : REFUSED) {
        const std::string answer = shelf_answer (engine, request, refused.expression);
        EXPECT_NE (answer.find ("threw: "), std::string::npos)
        << refused.expression << " answered " << answer;
        EXPECT_NE (answer.find (refused.expected), std::string::npos)
        << refused.expression << ": " << answer;
    }
}

// Every script gets a context built for it, so a library evaluated at build
// would be paid for by every element. Mutation: evaluate the shelf in
// `setup_require_shelf` and the first expectation fails.
TEST_F (ScriptEngineTest, RequireShelfEvaluatesALibraryOnlyOnFirstUse) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "1 + 1"), "2");
    EXPECT_EQ (shelf_answer (engine, request, "typeof require"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    // One evaluation however many times the execution reaches for it.
    EXPECT_EQ (shelf_answer (engine, request,
               "typeof CryptoJS + require('crypto-js').MD5('').sigBytes + "
               "typeof require('crypto-js')"),
    "object16object");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    // The next script's context is a new one, which loads its own copy.
    EXPECT_EQ (shelf_answer (engine, request, "typeof require('crypto-js').SHA1"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// An assignment replaces the global as it would any other, without loading
// the library it replaces; a script's own `var CryptoJS = require(...)` is
// function-local, as in Postman.
TEST_F (ScriptEngineTest, RequireShelfGlobalCanBeReassigned) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "(CryptoJS = 5, CryptoJS + 1)"), "6");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before);

    auto result = engine.execute_prerequest (R"JS(
        var CryptoJS = require('crypto-js');
        pm.environment.set('out', CryptoJS.MD5('').toString());
    )JS",
    request, env);
    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "d41d8cd98f00b204e9800998ecf8427e");
}

// require('uuid') is npm's uuid 8.3.2, vendored (#2650).

namespace {

constexpr const char* UUID_V4_PATTERN =
"/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/";

} // namespace

// Mutation: have native.randomBytes answer zeros and the two calls agree.
TEST_F (ScriptEngineTest, RequireShelfUuidV4IsRandomAndWellFormed) {
    const std::string v4_shape = std::string (UUID_V4_PATTERN) + ".test(require('uuid').v4())";
    EXPECT_EQ (shelf_answer (engine, request, v4_shape), "true");
    EXPECT_EQ (shelf_answer (engine, request,
               "(function (u) { var a = u.v4(), b = u.v4(); return a !== b && "
               "u.validate(a) && u.version(b) === 4; })(require('uuid'))"),
    "true");
}

// Postman's uuid is called as a function; npm's members ride on it.
// Mutation: return `api` from the glue and the call throws.
TEST_F (ScriptEngineTest, RequireShelfUuidIsCallableAsPostmansIs) {
    EXPECT_EQ (shelf_answer (engine, request, std::string (UUID_V4_PATTERN) + ".test(require('uuid')())"),
    "true");
    EXPECT_EQ (shelf_answer (engine, request, "typeof require('uuid') + ' ' + (require('uuid') === require('uuid'))"),
    "function true");
    EXPECT_EQ (shelf_answer (engine, request,
               "(function () { const { v4: uuidv4 } = require('uuid'); return "
               "uuidv4().length; })()"),
    "36");
}

// The name-based and time-based versions against their published answers:
// RFC 4122's DNS namespace and uuid's own README examples.
TEST_F (ScriptEngineTest, RequireShelfUuidMatchesKnownAnswers) {
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "require('uuid').v5('www.example.com', require('uuid').v5.DNS)", "2ed6657d-e927-568b-95e1-2665a8aea6a2" },
    { "require('uuid').v3('www.example.com', require('uuid').v3.DNS)", "5df41881-3aed-3515-88a7-2f4a814cf09e" },
    { "require('uuid').v5('https://www.w3.org/', require('uuid').v5.URL)",
    "c106a26a-21bb-5538-8bf2-57095d1976c1" },
    { "require('uuid').v1({ node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab], "
      "clockseq: 0x1234, msecs: Date.UTC(2011, 10, 1), nsecs: 5678 })",
    "710b962e-041c-11e1-9234-0123456789ab" },
    { "/^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/"
      ".test(require('uuid').v1())",
    "true" },
    { "require('uuid').NIL", "00000000-0000-0000-0000-000000000000" },
    { "require('uuid').validate('not a UUID')", "false" },
    { "require('uuid').validate('6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b')", "true" },
    { "require('uuid').version('45637ec4-c85f-11ea-87d0-0242ac130003')", "1" },
    { "require('uuid').stringify(require('uuid').parse("
      "'6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b'))",
    "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (engine, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// The UMD's CommonJS branch and the glue's `crypto` are the factory's own;
// none of them reaches the script's global scope.
TEST_F (ScriptEngineTest, RequireShelfUuidLeavesNoGlobalBehind) {
    EXPECT_EQ (shelf_answer (engine, request,
               "(require('uuid').v4(), [typeof uuid, typeof crypto, typeof "
               "module, typeof exports, typeof define].join(' '))"),
    "undefined undefined undefined undefined undefined");
}

// Mutation: evaluate the shelf in `setup_require_shelf` and the first
// expectation fails.
TEST_F (ScriptEngineTest, RequireShelfUuidEvaluatesOnlyOnFirstUse) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "typeof require"), "function");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that requires nothing evaluated a library";

    EXPECT_EQ (shelf_answer (engine, request, "require('uuid').v4().length + require('uuid')().length"),
    "72");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// require('lodash') and the `_` global are npm's lodash 4.18.1, vendored (#2651).

TEST_F (ScriptEngineTest, RequireShelfLodashAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "_.get({ a: [{ b: 3 }] }, 'a[0].b')", "3" },
    { "require('lodash').get({ a: [{ b: 3 }] }, ['a', '0', 'b'])", "3" },
    { "_.get({}, 'a.b', 'fallback')", "fallback" },
    { "JSON.stringify(_.chunk(['a', 'b', 'c', 'd', 'e'], 2))", R"([["a","b"],["c","d"],["e"]])" },
    { "JSON.stringify(_.groupBy([6.1, 4.2, 6.3], Math.floor))", R"({"4":[4.2],"6":[6.1,6.3]})" },
    { "JSON.stringify(_.groupBy(['one', 'two', 'three'], 'length'))", R"({"3":["one","two"],"5":["three"]})" },
    { "_.isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })", "true" },
    { "_.isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })", "false" },
    { "(function () { var o = { a: [{ b: 1 }] }, c = _.cloneDeep(o); "
      "c.a[0].b = 2; return [o.a[0].b, c.a[0].b, c.a !== o.a].join(); })()",
    "1,2,true" },
    { "_.map([1, 2, 3], function (n) { return n * 2; }).join()", "2,4,6" },
    { "_([1, 2, 3, 4]).filter(function (n) { return n % 2 === 0; }).sum()", "6" },
    { "_.VERSION", "4.18.1" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// One module for the global and the require, whichever the script reaches first.
TEST_F (ScriptEngineTest, RequireShelfLodashIsOneModuleForRequireAndTheGlobal) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request,
               "typeof _ + ' ' + (require('lodash') === _) + ' ' + "
               "(require('lodash') === require('lodash'))"),
    "function true true");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var l = require('lodash'); return (l === _) + ' ' + "
    "typeof l.get; })()"),
    "true function");
}

// lodash takes its CommonJS branch inside the glue, so it assigns no global
// of its own, and the sandbox gives it no Node to find: no `module`, `exports`,
// `process` or `global` is in a built context, before or after it loads.
TEST_F (ScriptEngineTest, RequireShelfLodashLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof module, typeof exports, typeof process, typeof global, typeof "
    "define].join(' ')";
    EXPECT_EQ (shelf_answer (roomy, request, probe),
    "undefined undefined undefined undefined undefined");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('lodash').get({}, 'a'); _.noop(); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; })()"),
    "true");
    EXPECT_EQ (shelf_answer (roomy, request, "(require('lodash'), " + probe + ")"),
    "undefined undefined undefined undefined undefined");
}

// An assignment replaces `_` as it would any global, without loading lodash,
// and a script's own `_` is its own.
TEST_F (ScriptEngineTest, RequireShelfLodashGlobalCanBeReassigned) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (engine, request, "(_ = 1, _ + 1)"), "2");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before);
    EXPECT_EQ (shelf_answer (engine, request, "(function () { var _ = 'mine'; return _; })()"),
    "mine");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before);
}

// lodash reads the `_` global while it evaluates (its noConflict value), which
// is the shelf's own accessor mid-load. Read through either door, the library
// is evaluated once and the global ends up as the library. Mutations: evaluate
// the shelf in `setup_require_shelf` and the first count fails; let the getter
// replace itself with the mid-load `undefined` and the last answer does; drop
// the in-progress entry in `load_library` and that read recurses until the
// stack runs out, so every lodash case throws.
TEST_F (ScriptEngineTest, RequireShelfLodashEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "_.get({ a: 1 }, 'a') + require('lodash').get({ a: 1 }, 'a')"),
    "2");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request, "(require('lodash'), typeof _ + (_ === require('lodash')))"),
    "functiontrue");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}

// require('moment') is npm's moment 2.31.0 (the English-only min build),
// vendored (#2652). Postman binds no `moment` global, so there is only the
// module. Local-time cases use a calendar date and format it back, which does
// not move with the host's zone; the rest read moment.utc and fixed instants,
// never the clock.
TEST_F (ScriptEngineTest, RequireShelfMomentAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "require('moment')('2026-10-21').add(1, 'day').format('YYYY-MM-DD')", "2026-10-22" },
    { "require('moment').utc(0).toISOString()", "1970-01-01T00:00:00.000Z" },
    { "require('moment').utc('2026-10-21T12:00:00Z').format('dddd, MMMM Do "
      "YYYY, h:mm a')",
    "Wednesday, October 21st 2026, 12:00 pm" },
    { "require('moment').utc('2026-10-21').unix()", "1792540800" },
    { "require('moment').utc('2026-10-21').isBefore(require('moment').utc('"
      "2026-10-22'))",
    "true" },
    { "require('moment').utc('2026-10-22').isBefore(require('moment').utc('"
      "2026-10-21'))",
    "false" },
    { "require('moment').utc('2026-10-22').diff(require('moment').utc('2026-10-"
      "21'), 'hours')",
    "24" },
    { "require('moment').utc('2026-01-31').add(1, "
      "'month').format('YYYY-MM-DD')",
    "2026-02-28" },
    { "require('moment').utc('2026-10-21').startOf('month').format()", "2026-10-01T00:00:00Z" },
    { "require('moment').utc('2026-02-30').isValid()", "false" },
    { "require('moment').duration(90, 'minutes').asHours()", "1.5" },
    { "require('moment').version", "2.31.0" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A destructured member is the one the module holds, and every require answers
// one module.
TEST_F (ScriptEngineTest, RequireShelfMomentDestructuredAndDirectAgree) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { const { utc, duration } = require('moment'); "
    "return [utc(0).toISOString() === require('moment').utc(0).toISOString(), "
    "duration(1, 'day').asHours(), "
    "require('moment') === require('moment')].join(); })()"),
    "true,24,true");
}

// moment's UMD takes its CommonJS branch inside the glue, so it assigns no
// global: Postman has none either, so `moment` stays undeclared before and
// after a require, and nothing else is added to the global object.
TEST_F (ScriptEngineTest, RequireShelfMomentLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof moment, typeof module, typeof exports, typeof define].join(' ')";
    EXPECT_EQ (shelf_answer (roomy, request, probe), "undefined undefined undefined undefined");
    EXPECT_EQ (shelf_answer (roomy, request, "(require('moment'), " + probe + ")"),
    "undefined undefined undefined undefined");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('moment').utc(0).format(); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; })()"),
    "true");
}

// The English-only build has no locale files. moment.locale('fr') asks the
// sandbox's require for './locale/fr', which refuses, and moment keeps
// English: the call answers 'en' and throws nothing a script would see.
TEST_F (ScriptEngineTest, RequireShelfMomentFallsBackToEnglishForAnotherLocale) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request, "require('moment').locale('fr') + ' ' + require('moment').locale()"),
    "en en");
    EXPECT_EQ (shelf_answer (roomy, request, "require('moment').utc('2026-10-21').locale('fr').format('MMMM')"),
    "October");
}

// Mutations: evaluate the shelf in `setup_require_shelf` and the first count
// fails; let the glue assign a `moment` global and the leaves-no-global case
// fails.
TEST_F (ScriptEngineTest, RequireShelfMomentEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request, "require('moment').utc(0).year() + require('moment').utc(0).month()"),
    "1970");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// require('csv-parse/lib/sync') is npm's csv-parse 1.2.4 sync parser, bundled
// (#2653), the version Postman's sandbox exposes at that path and only there.
// The module is the parse function. Every answer was checked against the
// unbundled package on Node.
TEST_F (ScriptEngineTest, RequireShelfCsvParseAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2', { columns: true })))",
    R"([{"a":"1","b":"2"}])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2')))", R"([["a","b"],["1","2"]])" },
    // A quoted field keeps its delimiter, and a doubled quote is one quote.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('"a,b",c\n"say ""hi""",d')))",
    R"([["a,b","c"],["say \"hi\"","d"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a;b\n1;2', { delimiter: ';', columns: true })))",
    R"([{"a":"1","b":"2"}])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a\tb\n1\t2', { delimiter: '\t' })))",
    R"([["a","b"],["1","2"]])" },
    // An empty line is a record of one empty field unless it is skipped.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n\n1,2\n')))", R"([["a","b"],[""],["1","2"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n\n1,2\n', { skip_empty_lines: true })))",
    R"([["a","b"],["1","2"]])" },
    // 1.2.4's option names, which later majors renamed.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2', { auto_parse: true })))",
    R"([["a","b"],[1,2]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2,3', { relax_column_count: true })))",
    R"([["a","b"],["1","2","3"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\r\n1,2\r\n', { columns: true })))",
    R"([{"a":"1","b":"2"}])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')(' a , b ', { trim: true })))", R"([["a","b"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('id,v\n1,x\n2,y', { columns: true, objname: 'id' })))",
    R"({"1":{"id":"1","v":"x"},"2":{"id":"2","v":"y"}})" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('')))", "[]" },
    // 1.2.4 drops a short or long last record that has no line ending after
    // it rather than throwing; Postman's copy does the same.
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1,2,3')))", R"([["a","b"]])" },
    { R"(JSON.stringify(require('csv-parse/lib/sync')('a,b\n1')))", R"([["a","b"]])" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
}

// A malformed record throws csv-parse's own Error, with its own message, which
// a script can catch.
TEST_F (ScriptEngineTest, RequireShelfCsvParseThrowsTheLibrarysOwnError) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto REFUSED = std::to_array<ShelfAnswer> ({
    { R"(require('csv-parse/lib/sync')('a,b\n"1,2'))", "Quoted field not terminated at line 3" },
    { R"(require('csv-parse/lib/sync')('a,b\n1,2,3\n'))", "Number of columns is inconsistent on line 2" },
    { R"(require('csv-parse/lib/sync')('a,b\n"1",2\n"x"y,3\n'))",
    R"(Invalid closing quote at line 3; found "y" instead of delimiter ",")" },
    });
    for (const auto& refused : REFUSED) {
        const std::string answer = shelf_answer (roomy, request, refused.expression);
        EXPECT_NE (answer.find ("threw: "), std::string::npos)
        << refused.expression << " answered " << answer;
        EXPECT_NE (answer.find (refused.expected), std::string::npos)
        << refused.expression << ": " << answer;
    }
    EXPECT_EQ (shelf_answer (roomy, request,
               R"((function () { try { require('csv-parse/lib/sync')('"a'); } )"
               R"(catch (e) { return (e instanceof Error) + ' ' + e.message; } })())"),
    "true Quoted field not terminated at line 2");
}

// The module is the function, so there is nothing to destructure: a binding
// and a direct call are the same function and answer the same records, and
// every require answers one module.
TEST_F (ScriptEngineTest, RequireShelfCsvParseBoundAndDirectAgree) {
    ScriptEngine roomy{ library_call_config () };
    EXPECT_EQ (shelf_answer (roomy, request,
               R"((function () { const parse = require('csv-parse/lib/sync'); )"
               R"(return [typeof parse, parse === require('csv-parse/lib/sync'), )"
               R"(JSON.stringify(parse('a\n1')) === )"
               R"(JSON.stringify(require('csv-parse/lib/sync')('a\n1'))].join(); })())"),
    "function,true,true");
}

// The bundle's Node shims (Buffer, stream, util, string_decoder) are locals
// of its own wrapper and the glue's `module` is the factory's, so none of them
// reaches the script, before or after a parse, and the global object gains
// nothing.
TEST_F (ScriptEngineTest, RequireShelfCsvParseLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof module, typeof exports, typeof define, typeof Buffer, typeof "
    "process, typeof parse, typeof StringDecoder, typeof setImmediate].join(' "
    "')";
    const std::string undefined_all =
    "undefined undefined undefined undefined undefined undefined undefined "
    "undefined";
    EXPECT_EQ (shelf_answer (roomy, request, probe), undefined_all);
    EXPECT_EQ (shelf_answer (roomy, request,
               "(require('csv-parse/lib/sync')('a,b\\n1,2'), " + probe + ")"),
    undefined_all);
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('csv-parse/lib/sync')('a,b\\n1,2', "
    "{ columns: true }); return "
    "Object.getOwnPropertyNames(globalThis).sort().join() === before; "
    "})()"),
    "true");
}

// Only the whole name loads it: Postman exposes csv-parse at this one path,
// so the bare package, the 5.x `csv-parse/sync` and every other path under it
// are refused as any name off the shelf is, and none of them evaluates the
// library. Mutation: let `js_require` accept any name starting `csv-parse`
// and every case here loads it instead.
TEST_F (ScriptEngineTest, RequireShelfCsvParseRefusesEveryOtherPath) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    for (const char* name : { "csv-parse", "csv-parse/lib/other", "csv-parse/lib/index",
         "csv-parse/lib/sync.js", "csv-parse/sync", "csv-parse/lib" }) {
        const std::string refusal =
        shelf_answer (engine, request, "require('" + std::string (name) + "')");
        EXPECT_NE (refusal.find ("Cannot find module '" + std::string (name) + "'"),
        std::string::npos)
        << refusal;
        EXPECT_NE (refusal.find ("reads no file and fetches nothing"), std::string::npos)
        << refusal;
    }
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a refused name evaluated a library";
}

// Mutation: evaluate the shelf in `setup_require_shelf` and the first count
// fails.
TEST_F (ScriptEngineTest, RequireShelfCsvParseEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "require('csv-parse/lib/sync')('a\\n1').length + "
               "require('csv-parse/lib/sync')('a\\n1\\n2').length"),
    "5");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);
}

// require('xml2js') is npm's xml2js 0.6.2 with sax 1.2.4 and xmlbuilder
// 11.0.1, bundled (#2654), the versions Postman's sandbox ships; `xml2Json` is
// Postman's synchronous parse over it. Every answer was checked against the
// unbundled packages on Node.
namespace {

/// A function expression that parses its first argument with xml2js's
/// parseString and its options, and answers what the callback was handed: the
/// result as JSON, the error's first line, or "no callback".
constexpr const char* XML2JS_PARSE =
"(function (xml, options) { var out = 'no callback'; "
"require('xml2js').parseString(xml, options || {}, function (e, r) { "
"out = e ? (e instanceof Error) + ' ' + e.message.split('\\n')[0] : "
"JSON.stringify(r); }); return out; })";

std::string xml2js_parse (const std::string& arguments) {
    std::string call = XML2JS_PARSE;
    call += '(';
    call += arguments;
    call += ')';
    return call;
}

} // namespace

TEST_F (ScriptEngineTest, RequireShelfXml2jsAnswersKnownCalls) {
    ScriptEngine roomy{ library_call_config () };
    struct Xml2jsAnswer {
        std::string arguments;
        const char* expected;
    };
    const auto answers = std::to_array<Xml2jsAnswer> ({
    { R"('<a><b>1</b></a>')", R"({"a":{"b":["1"]}})" },
    { R"('<a><b>1</b></a>', { explicitArray: false })", R"({"a":{"b":"1"}})" },
    // Attributes sit under `$` and an element's text beside them under `_`.
    { R"('<a x="1" y="2"><b k="v">t</b></a>')",
    R"({"a":{"$":{"x":"1","y":"2"},"b":[{"_":"t","$":{"k":"v"}}]}})" },
    { R"('<a x="1"><b>t</b></a>', { mergeAttrs: true })", R"({"a":{"x":["1"],"b":["t"]}})" },
    { R"('<a><b>1</b><b>2</b></a>', { explicitArray: false })", R"({"a":{"b":["1","2"]}})" },
    { R"('<?xml version="1.0"?><r><![CDATA[<x>]]></r>')", R"({"r":"<x>"})" },
    { R"('<a>&amp;&lt;&#65;&#x42;</a>')", R"({"a":"&<AB"})" },
    { R"('<a><B>1</B></a>', { normalizeTags: true })", R"({"a":{"b":["1"]}})" },
    { R"('<a>1</a>', { explicitRoot: false })", R"("1")" },
    { R"('<a b=1>x</a>', { strict: false })", R"({"A":{"_":"x","$":{"B":"1"}}})" },
    { R"('<a><n>42</n><b>true</b><s>x</s></a>', { explicitArray: false, )"
      R"(valueProcessors: [require('xml2js').processors.parseNumbers, )"
      R"(require('xml2js').processors.parseBooleans] })",
    R"({"a":{"n":42,"b":true,"s":"x"}})" },
    { R"('<a xmlns:p="u"><p:b>1</p:b></a>', { explicitArray: false, )"
      R"(tagNameProcessors: [require('xml2js').processors.stripPrefix] })",
    R"({"a":{"$":{"xmlns:p":"u"},"b":"1"}})" },
    // Empty input is not an error: the callback is handed null.
    { "''", "null" },
    });
    for (const auto& answer : answers) {
        EXPECT_EQ (shelf_answer (roomy, request, xml2js_parse (answer.arguments)),
        answer.expected)
        << answer.arguments;
    }
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "new (require('xml2js').Builder)({ headless: true, renderOpts: { "
    "pretty: false } }).buildObject({ a: { $: { k: 'v' }, b: ['1', "
    "'2'] } })"),
    R"(<a k="v"><b>1</b><b>2</b></a>)");
}

// A document sax refuses reaches the callback as an Error carrying sax's own
// message, and with `async: false` (the default) the callback has run before
// parseString returns.
TEST_F (ScriptEngineTest, RequireShelfXml2jsHandsAMalformedDocumentToTheCallback) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto REFUSED = std::to_array<ShelfAnswer> ({
    { "'<a><b>1</b>'", "true Unclosed root tag" },
    { "'<a></b>'", "true Unexpected close tag" },
    { "'not xml'", "true Non-whitespace before first tag." },
    { "'<a>&bogus;</a>'", "true Invalid character entity" },
    { "'<a b=1>x</a>'", "true Unquoted attribute value" },
    });
    for (const auto& refused : REFUSED) {
        EXPECT_EQ (shelf_answer (roomy, request, xml2js_parse (refused.expression)),
        refused.expected)
        << refused.expression;
    }
    EXPECT_EQ (shelf_answer (roomy, request,
               "(function () { var order = []; require('xml2js').parseString("
               "'<a/>', function () { order.push('callback'); }); "
               "order.push('returned'); return order.join(); })()"),
    "callback,returned");
}

// `xml2Json` is Postman's helper: parseString with explicitArray false, trim
// on and attributes kept apart, answering what the callback was handed, so a
// refused document is `undefined` and empty input `null`. It is the same
// parse as the module's with those options.
TEST_F (ScriptEngineTest, RequireShelfXml2JsonIsPostmansSynchronousParse) {
    ScriptEngine roomy{ library_call_config () };
    constexpr auto ANSWERS = std::to_array<ShelfAnswer> ({
    { "JSON.stringify(xml2Json('<a>1</a>'))", R"({"a":"1"})" },
    { R"(JSON.stringify(xml2Json('<a><b> 1 </b><b>2</b><c k="v">t</c></a>')))",
    R"({"a":{"b":["1","2"],"c":{"_":"t","$":{"k":"v"}}}})" },
    { "JSON.stringify(xml2Json('<a><b>1</b><c/></a>'))", R"({"a":{"b":"1","c":""}})" },
    { "typeof xml2Json('<a><b>1</b>')", "undefined" },
    { "typeof xml2Json('not xml')", "undefined" },
    { "xml2Json('')", "null" },
    { "typeof xml2Json", "function" },
    { "xml2Json === require('xml2js')", "false" },
    });
    for (const auto& answer : ANSWERS) {
        EXPECT_EQ (shelf_answer (roomy, request, answer.expression), answer.expected)
        << answer.expression;
    }
    EXPECT_EQ (shelf_answer (roomy, request,
               "JSON.stringify(xml2Json('<r k=\"v\"> x </r>')) === " +
               xml2js_parse ("'<r k=\"v\"> x </r>', { explicitArray: false, "
                             "async: false, trim: true, mergeAttrs: false }")),
    "true");
}

// An `async: true` parse goes through the bundle's setImmediate, a zero-delay
// setTimeout, and the sandbox runs every timer before the script ends: the
// callback has not run when parseString returns, and a pm.test inside it is
// recorded. A document over xml2js's 10,000-character chunk takes one timer
// per chunk, each queued by the one before. parseStringPromise settles the
// same way.
TEST_F (ScriptEngineTest, RequireShelfXml2jsAsyncCallbackRunsBeforeTheScriptEnds) {
    ScriptEngine roomy{ library_call_config () };
    response.body     = "<order><id>7</id></order>";
    const auto result = roomy.execute_test (R"JS(
        var xml2js = require('xml2js');
        var called = false;
        xml2js.parseString(pm.response.text(), { async: true, explicitArray: false }, function (err, doc) {
            called = true;
            pm.test('the async parse called back', function () {
                pm.expect(err).to.equal(null);
                pm.expect(doc.order.id).to.equal('7');
            });
        });
        pm.environment.set('called at return', String(called));
        var big = '<a>' + new Array(3001).join('<b>1</b>') + '</a>';
        xml2js.parseString(big, { async: true, explicitArray: false }, function (err, doc) {
            pm.environment.set('chunks', String(err === null && doc.a.b.length));
        });
        xml2js.parseStringPromise('<a><b>2</b></a>').then(function (doc) {
            pm.environment.set('promised', doc.a.b[0]);
        });
        xml2js.parseStringPromise('<a>').catch(function (err) {
            pm.environment.set('rejected', err.message.split('\n')[0]);
        });
    )JS",
    request, response, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_EQ (result.tests.size (), 1u);
    EXPECT_EQ (result.tests[0].name, "the async parse called back");
    EXPECT_TRUE (result.tests[0].passed) << result.tests[0].error_message;
    EXPECT_EQ (env["called at return"].value, "false");
    EXPECT_EQ (env["chunks"].value, "3000");
    EXPECT_EQ (env["promised"].value, "2");
    EXPECT_EQ (env["rejected"].value, "Unclosed root tag");
}

// The bundle's Node shims (events, timers, stream, string_decoder) are locals
// of its own wrapper and the glue's `module` and `exports` are the factory's,
// so none of them reaches the script, before or after a parse; the global
// object gains nothing, and the module carries only xml2js's own exports
// (`xml2Json` is built beside it, not stored on it).
TEST_F (ScriptEngineTest, RequireShelfXml2jsLeavesNoGlobalBehind) {
    ScriptEngine roomy{ library_call_config () };
    const std::string probe =
    "[typeof module, typeof exports, typeof Buffer, typeof process, typeof "
    "setImmediate, typeof sax, typeof EventEmitter, typeof xml2js].join(' ')";
    const std::string undefined_all =
    "undefined undefined undefined undefined undefined undefined undefined "
    "undefined";
    EXPECT_EQ (shelf_answer (roomy, request, probe), undefined_all);
    EXPECT_EQ (shelf_answer (roomy, request, "(xml2Json('<a/>'), " + probe + ")"), undefined_all);
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(function () { var before = Object.getOwnPropertyNames(globalThis)"
    ".sort().join(); require('xml2js').parseString('<a/>', function () {}); "
    "xml2Json('<a/>'); new (require('xml2js').Builder)().buildObject({ a: 1 "
    "}); return Object.getOwnPropertyNames(globalThis).sort().join() === "
    "before; })()"),
    "true");
    EXPECT_EQ (
    shelf_answer (roomy, request,
    "(xml2Json('<a/>'), Object.getOwnPropertyNames(require('xml2js'))"
    ".join())"),
    "defaults,processors,ValidationError,Builder,Parser,parseString,"
    "parseStringPromise");
}

// Only the whole name loads it: the package's own files and its two
// dependencies are refused as any name off the shelf is, and none of them
// evaluates the library.
TEST_F (ScriptEngineTest, RequireShelfXml2jsRefusesEveryOtherPath) {
    const size_t before = ScriptEngine::shelf_library_loads ();
    for (const char* name : { "xml2js/lib/parser", "xml2js/lib/xml2js",
         "xml2js/", "XML2JS", "sax", "xmlbuilder", "xml2json" }) {
        const std::string refusal =
        shelf_answer (engine, request, "require('" + std::string (name) + "')");
        EXPECT_NE (refusal.find ("Cannot find module '" + std::string (name) + "'"),
        std::string::npos)
        << refusal;
    }
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a refused name evaluated a library";
}

// `xml2Json` and require('xml2js') share one evaluation of the library,
// whichever the script reaches first, and an assignment replaces the global
// without loading it. Mutation: evaluate the shelf in `setup_require_shelf`
// and the first count fails.
TEST_F (ScriptEngineTest, RequireShelfXml2jsEvaluatesOnlyOnFirstUse) {
    ScriptEngine roomy{ library_call_config () };
    const size_t before = ScriptEngine::shelf_library_loads ();
    EXPECT_EQ (shelf_answer (roomy, request, "typeof require + typeof pm"), "functionobject");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before)
    << "a script that touches no library evaluated one";

    EXPECT_EQ (shelf_answer (roomy, request,
               "xml2Json('<a>1</a>').a + " + xml2js_parse ("'<b>2</b>'") +
               " + typeof xml2Json + (xml2Json === xml2Json)"),
    R"(1{"b":"2"}functiontrue)");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 1);

    EXPECT_EQ (shelf_answer (roomy, request,
               "(require('xml2js'), typeof require('xml2js').parseString + "
               "xml2Json('<a>3</a>').a)"),
    "function3");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);

    EXPECT_EQ (shelf_answer (roomy, request, "(xml2Json = 5, xml2Json + 1)"), "6");
    EXPECT_EQ (ScriptEngine::shelf_library_loads (), before + 2);
}
