/**
 * @file script_engine_encoding_test.cpp
 * @brief btoa / atob and pm.crypto.
 */

#include "vayu/runtime/script_engine.hpp"

#include <gtest/gtest.h>

#include <string>

#include "script_engine_fixture.hpp"
#include "vayu/types.hpp"

using namespace vayu;
using namespace vayu::runtime;

// ============================================================================
// btoa / atob (#187)
// ============================================================================
//
// Known answers, not round-trips: a round-trip passes just as happily over two
// mirrored bugs. The vectors are RFC 4648 §10, which is also what
// encoding_test.cpp checks the C++ helpers against - the point here is that the
// JS boundary hands over the same bytes.

TEST_F (ScriptEngineTest, BtoaMatchesRfc4648Vectors) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', [btoa(''), btoa('f'), btoa('fo'), btoa('foo'),
                                   btoa('foob'), btoa('fooba'), btoa('foobar')].join('|'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "|Zg==|Zm8=|Zm9v|Zm9vYg==|Zm9vYmE=|Zm9vYmFy");
}

TEST_F (ScriptEngineTest, AtobDecodesRfc4648VectorsIncludingPadding) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', [atob(''), atob('Zg=='), atob('Zm8='), atob('Zm9v'),
                                   atob('Zm9vYg=='), atob('Zm9vYmE='), atob('Zm9vYmFy')].join('|'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value, "|f|fo|foo|foob|fooba|foobar");
}

TEST_F (ScriptEngineTest, Base64CarriesHighBytesThroughTheJsBoundary) {
    // atob returns a binary string: one code unit per byte, 0x80-0xFF included.
    // This is where a naive "just hand QuickJS the bytes" implementation breaks,
    // because a JS string is not a byte array - 0x80 alone is not valid UTF-8.
    auto result = engine.execute_prerequest (R"JS(
        var s = atob('gP/+AQ==');           // 0x80 0xFF 0xFE 0x01
        var codes = [];
        for (var i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
        pm.environment.set('codes', codes.join(','));
        pm.environment.set('again', btoa(s));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["codes"].value, "128,255,254,1");
    EXPECT_EQ (env["again"].value, "gP/+AQ==");
}

TEST_F (ScriptEngineTest, BtoaRejectsCharactersAboveLatin1) {
    // Web `btoa` semantics: it encodes code units, so anything above U+00FF is a
    // range error rather than a silent UTF-8 encode. Failing loudly matters here
    // - a signature over quietly-substituted bytes verifies nowhere and gives
    // the author nothing to go on.
    auto result = engine.execute_prerequest (R"JS(
        try {
            btoa('naïve €');
            pm.environment.set('outcome', 'no throw');
        } catch (e) {
            pm.environment.set('outcome', String(e));
        }
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_NE (env["outcome"].value.find ("Latin-1"), std::string::npos)
    << "expected a range error naming Latin-1, got: " << env["outcome"].value;
    // U+00E9 is inside the range and must still encode.
    EXPECT_TRUE (env["outcome"].value.find ("no throw") == std::string::npos);
}

TEST_F (ScriptEngineTest, BtoaEncodesLatin1SupplementCharacters) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', btoa('héllo'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    // Latin-1 bytes 68 e9 6c 6c 6f, not the UTF-8 encoding of the same text.
    EXPECT_EQ (env["out"].value, "aOlsbG8=");
}

TEST_F (ScriptEngineTest, AtobThrowsOnMalformedBase64) {
    auto result = engine.execute_prerequest (R"JS(
        var outcomes = [];
        ['Zm9vYmF', 'Zm9$', 'Zg=v', 'Z==='].forEach(function (bad) {
            try { atob(bad); outcomes.push('accepted:' + bad); }
            catch (e) { outcomes.push('threw'); }
        });
        pm.environment.set('outcomes', outcomes.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["outcomes"].value, "threw,threw,threw,threw");
}

// ============================================================================
// pm.crypto (#187)
// ============================================================================

TEST_F (ScriptEngineTest, Sha256MatchesPublishedVectors) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('abc', pm.crypto.sha256('abc'));
        pm.environment.set('empty', pm.crypto.sha256(''));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["abc"].value,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    EXPECT_EQ (env["empty"].value,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

TEST_F (ScriptEngineTest, Sha256HashesTheUtf8BytesOfNonAsciiText) {
    // The one place a hashing API silently disagrees with every other tool: what
    // "the bytes of this string" means. UTF-8, matching what the engine puts on
    // the wire, so a digest computed here equals `printf 'h\xc3\xa9llo' | sha256sum`.
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('out', pm.crypto.sha256('héllo'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["out"].value,
    "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179");
}

TEST_F (ScriptEngineTest, HmacSha256MatchesRfc4231Vectors) {
    // RFC 4231 cases 2 and 6. Case 6 uses a 131-byte key, which exercises the
    // "hash the key down first" branch of RFC 2104 - the branch a hand-written
    // HMAC most often skips, and the one that stays invisible under short keys.
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('case2',
            pm.crypto.hmacSha256('Jefe', 'what do ya want for nothing?'));

        var longKey = new Uint8Array(131);
        for (var i = 0; i < longKey.length; i++) longKey[i] = 0xaa;
        pm.environment.set('case6', pm.crypto.hmacSha256(
            longKey, 'Test Using Larger Than Block-Size Key - Hash Key First'));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["case2"].value, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    << "RFC 4231 test case 2";
    // The RFC's key is 131 raw 0xaa bytes, which no string can carry: a JS
    // string of U+00AA characters is UTF-8 encoded to 0xc2 0xaa pairs and would
    // hash something else entirely. That is what the Uint8Array input is for.
    EXPECT_EQ (env["case6"].value, "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")
    << "RFC 4231 test case 6 (key longer than the SHA-256 block)";
}

TEST_F (ScriptEngineTest, DigestEncodingsAgreeOnTheSameDigest) {
    auto result = engine.execute_prerequest (R"JS(
        pm.environment.set('hex', pm.crypto.sha256('abc', 'hex'));
        pm.environment.set('b64', pm.crypto.sha256('abc', 'base64'));
        pm.environment.set('b64url', pm.crypto.sha256('abc', 'base64url'));
        var bytes = pm.crypto.sha256('abc', 'bytes');
        pm.environment.set('len', String(bytes.length));
        pm.environment.set('first', String(bytes[0]));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["hex"].value,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    EXPECT_EQ (env["b64"].value, "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
    // base64url differs from base64 in exactly the two substituted characters
    // and the dropped padding.
    EXPECT_EQ (env["b64url"].value, "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    EXPECT_EQ (env["len"].value, "32");
    EXPECT_EQ (env["first"].value, "186"); // 0xba
}

TEST_F (ScriptEngineTest, DigestBytesCanBeFedBackAsAKey) {
    // The reason 'bytes' exists. AWS SigV4 derives its signing key in four HMAC
    // rounds, each keyed by the *raw* digest of the previous one; with only text
    // outputs the chain cannot be expressed at all. Compare against the
    // published SigV4 example key for 20150830/us-east-1/iam.
    auto result = engine.execute_prerequest (R"JS(
        var kDate    = pm.crypto.hmacSha256('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'bytes');
        var kRegion  = pm.crypto.hmacSha256(kDate, 'us-east-1', 'bytes');
        var kService = pm.crypto.hmacSha256(kRegion, 'iam', 'bytes');
        var kSigning = pm.crypto.hmacSha256(kService, 'aws4_request', 'hex');
        pm.environment.set('kSigning', kSigning);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["kSigning"].value,
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
}

TEST_F (ScriptEngineTest, CryptoRejectsInputItCannotHashHonestly) {
    // Stringifying an object would hash the text "[object Object]" and return a
    // digest that looks perfectly valid. Every one of these must throw.
    auto result = engine.execute_prerequest (R"JS(
        var outcomes = [];
        function attempt(label, fn) {
            try { fn(); outcomes.push('accepted:' + label); }
            catch (e) { outcomes.push('threw:' + label); }
        }
        attempt('object', function () { pm.crypto.sha256({ a: 1 }); });
        attempt('number', function () { pm.crypto.sha256(42); });
        attempt('null', function () { pm.crypto.sha256(null); });
        attempt('missing', function () { pm.crypto.sha256(); });
        attempt('badEncoding', function () { pm.crypto.sha256('abc', 'utf16'); });
        attempt('keyOnly', function () { pm.crypto.hmacSha256('key'); });
        pm.environment.set('outcomes', outcomes.join(','));
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    EXPECT_EQ (env["outcomes"].value, "threw:object,threw:number,threw:null,threw:missing,threw:badEncoding,threw:keyOnly");
}

TEST_F (ScriptEngineTest, UnknownDigestEncodingNamesTheValidOnes) {
    auto result = engine.execute_prerequest (R"JS(
        try { pm.crypto.sha256('abc', 'utf16'); }
        catch (e) { pm.environment.set('message', String(e)); }
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    const auto& message = env["message"].value;
    EXPECT_NE (message.find ("utf16"), std::string::npos) << message;
    EXPECT_NE (message.find ("base64url"), std::string::npos) << message;
}

TEST_F (ScriptEngineTest, PreRequestScriptSignsTheOutgoingRequest) {
    // #109's write-back and #187's crypto meeting: the headline use case the
    // issue named. The signature is over the canonical string built from
    // pm.request *after* the other edits, which is what the scripting guide teaches.
    auto result = engine.execute_prerequest (R"JS(
        var timestamp = '1700000000';
        var canonical = [pm.request.method, pm.request.url, timestamp].join('\n');
        pm.request.headers['X-Timestamp'] = timestamp;
        pm.request.headers['X-Signature'] =
            pm.crypto.hmacSha256(pm.environment.get('api_key'), canonical);
    )JS",
    request, env);

    ASSERT_TRUE (result.success) << result.error_message;
    ASSERT_TRUE (request.headers.contains ("X-Signature"));
    // HMAC-SHA256("secret123", "GET\nhttps://api.example.com/users\n1700000000").
    EXPECT_EQ (request.headers.at ("X-Signature"),
    "25cba17ca82852d836fc8d44d8efed36cadb53f858a2c81fe88aece44c415ab3");
    EXPECT_EQ (request.headers.at ("X-Timestamp"), "1700000000");
}
