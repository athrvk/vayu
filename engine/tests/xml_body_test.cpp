/**
 * @file xml_body_test.cpp
 * @brief An XML body, from stored JSON to the bytes on the wire.
 *
 * The mode has no envelope and no completer - that is the point of it. SOAP and
 * legacy-enterprise APIs are HTTP plus a document the author writes whole, so
 * what the engine owes them is exactly two things: send those bytes unchanged,
 * and say `application/xml` when the request declares no Content-Type of its
 * own. Both are easy to lose silently. Verbatim is asserted on the string, not
 * on "it parses", because a re-serialization that normalized the declaration or
 * collapsed the whitespace would still parse and would still be wrong; the
 * derived header is asserted at the socket, because the rule that skips it when
 * the caller set one lives two functions away (`body_content_type_header`).
 *
 * Both drivers are exercised - the design-run `Client::send` and the load-run
 * `EventLoop` - for the reason the sibling modes are: they share
 * `apply_method_and_body` and a mode that forgot one would be correct on Send
 * and wrong under load, which is the hardest version of this bug to see.
 */

#include <gtest/gtest.h>

#include <string>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {
namespace {

using vayu::tests::EchoServer;

/// A SOAP envelope as a user pastes one in: a declaration, namespaces, an
/// attribute, indentation that is theirs and not ours to normalize.
const char* const kSoapEnvelope =
R"(<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetBalance currency="EUR">
      <Account>ACC-8813</Account>
    </GetBalance>
  </soap:Body>
</soap:Envelope>)";

Request xml_request (const std::string& url, const std::string& content) {
    Request request;
    request.method       = HttpMethod::POST;
    request.url          = url;
    request.body.mode    = BodyMode::Xml;
    request.body.content = content;
    return request;
}

class XmlBodyTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        server_ = std::make_unique<EchoServer> ();
        client_ = std::make_unique<Client> ();
    }

    void TearDown () override {
        client_.reset ();
        server_.reset ();
        global_cleanup ();
    }

    std::unique_ptr<EchoServer> server_;
    std::unique_ptr<Client> client_;
};

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

// The document is opaque to storage. A round trip that re-indented it or moved
// the declaration would change bytes the user never edited - and for XML that
// is not cosmetic: whitespace inside an element is part of its text content.
TEST (XmlBodyStorageTest, ContentRoundTripsVerbatim) {
    const auto stored = json::serialize (xml_request ("https://x.test", kSoapEnvelope));
    ASSERT_TRUE (stored.contains ("body"));
    EXPECT_EQ (stored["body"]["mode"], "xml");

    auto parsed = json::deserialize_request (stored);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    EXPECT_EQ (parsed.value ().body.mode, BodyMode::Xml);
    EXPECT_EQ (parsed.value ().body.content, kSoapEnvelope);
}

// A body still holding an unresolved `{{token}}` is not a document, and storage
// must not care: composition resolves it later, and a mode that refused to
// store one would make an unsaved request unsavable mid-edit.
TEST (XmlBodyStorageTest, AnUnresolvedTokenIsStoredAsWritten) {
    const std::string templated = R"(<order><id>{{orderId}}</id></order>)";
    auto parsed                 = json::deserialize_request (
    json::serialize (xml_request ("https://x.test", templated)));
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    EXPECT_EQ (parsed.value ().body.content, templated);
}

// An xml body carries `content`, never `fields`, so an empty one has to answer
// `has_wire_body` the way an empty json body does - the predicate every sender
// asks before it writes a Content-Type or a byte.
TEST (XmlBodyStorageTest, EmptyContentIsNotAWireBody) {
    Body body;
    body.mode = BodyMode::Xml;
    EXPECT_FALSE (has_wire_body (body));

    body.content = kSoapEnvelope;
    EXPECT_TRUE (has_wire_body (body));
}

// ---------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------

// The whole contract, end to end. Mutation check: give `wire_body_bytes` an Xml
// arm that does anything at all - trim, re-indent, wrap - and the body
// assertion reddens; drop the Xml arm of `implied_content_type` and the header
// assertion reddens on its own.
TEST_F (XmlBodyTest, ADocumentReachesTheWireVerbatimAsApplicationXml) {
    ASSERT_TRUE (client_->send (xml_request (server_->url (), kSoapEnvelope)).is_ok ());

    EXPECT_EQ (server_->body (), kSoapEnvelope);
    EXPECT_EQ (server_->content_type (), "application/xml");
}

// A caller's Content-Type wins, the same rule every other content mode follows.
// `application/soap+xml` is the reason it matters here rather than a contrived
// value: SOAP 1.2 requires it, and an engine that overwrote it would make the
// mode useless for half its audience.
TEST_F (XmlBodyTest, AnExplicitContentTypeIsKept) {
    auto request = xml_request (server_->url (), kSoapEnvelope);
    request.headers["Content-Type"] = "application/soap+xml; charset=utf-8";

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->content_type (), "application/soap+xml; charset=utf-8");
    EXPECT_EQ (server_->body (), kSoapEnvelope);
}

TEST_F (XmlBodyTest, EngineDerivesApplicationXml) {
    Body body;
    body.mode    = BodyMode::Xml;
    body.content = kSoapEnvelope;
    EXPECT_EQ (implied_content_type (body), "application/xml");
    // Derived, not owned: `content_type_is_engine_owned` is multipart's rule,
    // and a caller's header must still reach the wire (above).
    EXPECT_FALSE (content_type_is_engine_owned (body));
    // No envelope, no completer: the bytes sent are the bytes stored.
    EXPECT_EQ (wire_body_bytes (body), kSoapEnvelope);
}

// The load path, through the event loop - the driver every `POST /runs` uses.
TEST_F (XmlBodyTest, LoadDriverSendsTheSameBytes) {
    EventLoop loop;
    loop.start ();

    auto handle = loop.submit_async (xml_request (server_->url (), kSoapEnvelope));
    auto result = handle.future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_->body (), kSoapEnvelope);
    EXPECT_EQ (server_->content_type (), "application/xml");
}

// ---------------------------------------------------------------------------
// The neighbours.
// ---------------------------------------------------------------------------

// Adding a mode to the enum is the kind of edit that reaches the modes beside
// it - a misplaced `case` in either switch would give `text` a Content-Type it
// never had, or hand a form body the wrong encoder.
TEST (XmlBodyNeighbourTest, OtherModesAreUntouched) {
    Body text;
    text.mode    = BodyMode::Text;
    text.content = "plain";
    EXPECT_EQ (implied_content_type (text), "");
    EXPECT_EQ (wire_body_bytes (text), "plain");

    Body json_body;
    json_body.mode    = BodyMode::Json;
    json_body.content = R"({"a":1})";
    EXPECT_EQ (implied_content_type (json_body), "");
    EXPECT_EQ (wire_body_bytes (json_body), R"({"a":1})");

    Body form;
    form.mode = BodyMode::Form;
    form.fields.emplace_back ("a", "1");
    EXPECT_EQ (implied_content_type (form), "application/x-www-form-urlencoded");
    EXPECT_EQ (wire_body_bytes (form), "a=1");
}

// The spelling table is the one place a mode name is added, and it is the half
// a client actually types. An unknown spelling leaves the default in place
// rather than throwing, which is why this asserts the accepted one lands
// somewhere specific.
TEST (XmlBodyNeighbourTest, TheModeSpellingIsRead) {
    nlohmann::json payload;
    payload["method"]          = "POST";
    payload["url"]             = "https://x.test";
    payload["body"]["mode"]    = "xml";
    payload["body"]["content"] = "<a/>";

    auto parsed = json::deserialize_request (payload);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    EXPECT_EQ (parsed.value ().body.mode, BodyMode::Xml);
    EXPECT_EQ (parsed.value ().body.content, "<a/>");
}

} // namespace
} // namespace vayu::http
