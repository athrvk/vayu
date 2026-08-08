/**
 * @file form_body_test.cpp
 * @brief The two form body modes, from the parsed shape to the bytes on the wire.
 *
 * The bug these pin (issue #381): a `form-data` or `x-www-form-urlencoded`
 * body was built in the UI, stored, composed - and then sent as an **empty**
 * body, because the engine read only `content` and recognised neither mode
 * string. Nothing failed; the server just received nothing.
 *
 * So the assertions here are deliberately about the wire and not about the
 * parsed struct: an echo server records the exact body and Content-Type it
 * received, and both HTTP drivers (the single-request client behind
 * `POST /execute`, and the event loop every load run generates through) are
 * driven against it. A regression that re-broke the serialization while
 * leaving the parse intact would still redden these.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <map>
#include <mutex>
#include <string>
#include <thread>

#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {
namespace {

/// Records what the last request actually carried: its Content-Type, its raw
/// body, and - for a multipart request - the parts httplib parsed out of it.
///
/// Multipart is asserted through those parsed parts rather than by matching
/// the envelope byte for byte, because httplib parses a multipart body itself
/// and leaves `req.body` empty. That is the better assertion anyway: httplib
/// splits the body on the boundary it read from the *header*, so a body whose
/// boundary disagreed with its Content-Type yields no parts at all, and a
/// part it can read is a part a real server can read.
class EchoServer {
    public:
    EchoServer () {
        auto record = [this] (const httplib::Request& req, httplib::Response& res) {
            {
                std::lock_guard<std::mutex> lock (mutex_);
                body_         = req.body;
                content_type_ = req.get_header_value ("Content-Type");
                parts_.clear ();
                for (const auto& [name, field] : req.form.fields) {
                    parts_[name] = field.content;
                }
            }
            res.set_content ("{}", "application/json");
        };
        svr_.Post ("/echo", record);
        svr_.Put ("/echo", record);

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~EchoServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }

    std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/echo";
    }

    std::string body () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return body_;
    }

    std::string content_type () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return content_type_;
    }

    /// The multipart parts, by field name. Empty for every other body.
    std::map<std::string, std::string> parts () const {
        std::lock_guard<std::mutex> lock (mutex_);
        return parts_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    mutable std::mutex mutex_;
    std::string body_;
    std::string content_type_;
    std::map<std::string, std::string> parts_;
};

Request form_request (const std::string& url, BodyMode mode, std::vector<FormField> fields) {
    Request request;
    request.method      = HttpMethod::POST;
    request.url         = url;
    request.body.mode   = mode;
    request.body.fields = std::move (fields);
    return request;
}

class FormBodyWireTest : public ::testing::Test {
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
// The wire, through the single-request client (POST /execute, "Send").
// ---------------------------------------------------------------------------

TEST_F (FormBodyWireTest, UrlEncodedBodyReachesTheWire) {
    auto request = form_request (server_->url (), BodyMode::Form,
    { { "name", "ada lovelace", true }, { "role", "engineer", true } });

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200);

    EXPECT_EQ (server_->body (), "name=ada%20lovelace&role=engineer");
    EXPECT_EQ (server_->content_type (), "application/x-www-form-urlencoded");
}

// Reserved characters must survive as data rather than as separators - the
// failure this guards is a value containing '&' or '=' splitting into extra
// fields server-side.
TEST_F (FormBodyWireTest, UrlEncodedEscapesReservedCharacters) {
    auto request = form_request (server_->url (), BodyMode::Form,
    { { "q", "a&b=c d/e", true }, { "sym+bol", "100%", true } });

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->body (), "q=a%26b%3Dc%20d%2Fe&sym%2Bbol=100%25");
}

TEST_F (FormBodyWireTest, UrlEncodedOmitsDisabledFields) {
    auto request = form_request (server_->url (), BodyMode::Form,
    { { "kept", "1", true }, { "dropped", "2", false }, { "also_kept", "3", true } });

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->body (), "kept=1&also_kept=3");
}

// An explicit Content-Type is the user's: the engine adds one only when the
// request declares none.
TEST_F (FormBodyWireTest, UrlEncodedKeepsAnExplicitContentType) {
    auto request = form_request (server_->url (), BodyMode::Form, { { "a", "1", true } });
    request.headers["Content-Type"] =
    "application/x-www-form-urlencoded; charset=utf-8";

    ASSERT_TRUE (client_->send (request).is_ok ());
    EXPECT_EQ (server_->content_type (), "application/x-www-form-urlencoded; charset=utf-8");
    EXPECT_EQ (server_->body (), "a=1");
}

TEST_F (FormBodyWireTest, MultipartBodyReachesTheWire) {
    auto request = form_request (server_->url (), BodyMode::FormData,
    { { "name", "ada", true }, { "note", "hello world", true } });

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    const std::string content_type = server_->content_type ();
    EXPECT_TRUE (content_type.starts_with ("multipart/form-data; boundary=")) << content_type;

    const auto parts = server_->parts ();
    ASSERT_EQ (parts.size (), 2u);
    EXPECT_EQ (parts.at ("name"), "ada");
    EXPECT_EQ (parts.at ("note"), "hello world");
}

TEST_F (FormBodyWireTest, MultipartOmitsDisabledFields) {
    auto request = form_request (server_->url (), BodyMode::FormData,
    { { "kept", "1", true }, { "dropped", "2", false } });

    ASSERT_TRUE (client_->send (request).is_ok ());
    const auto parts = server_->parts ();
    ASSERT_EQ (parts.size (), 1u);
    EXPECT_EQ (parts.count ("kept"), 1u);
    EXPECT_EQ (parts.count ("dropped"), 0u);
}

// A caller-supplied multipart Content-Type cannot name the boundary libcurl
// has not generated yet, so honouring it would send an unparseable body. It is
// dropped, and the report of what was sent drops it too.
TEST_F (FormBodyWireTest, MultipartContentTypeIsEngineOwned) {
    auto request =
    form_request (server_->url (), BodyMode::FormData, { { "a", "1", true } });
    request.headers["Content-Type"] = "multipart/form-data";

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;

    EXPECT_TRUE (
    server_->content_type ().starts_with ("multipart/form-data; boundary="))
    << server_->content_type ();
    EXPECT_FALSE (result.value ().request_headers.contains ("Content-Type"));
}

// All-disabled fields are no body at all - not an empty multipart envelope,
// and not a Content-Type the engine derived for a body that is not there.
//
// The methods differ deliberately: libcurl labels a bodiless POST
// `application/x-www-form-urlencoded` on its own (its default for
// CURLOPT_POST, and true of every empty-bodied POST this engine has ever
// sent), so a POST cannot tell the engine's header from curl's. A PUT can -
// curl adds nothing there.
TEST_F (FormBodyWireTest, NoEnabledFieldsSendsNoBody) {
    auto urlencoded =
    form_request (server_->url (), BodyMode::Form, { { "off", "1", false } });
    urlencoded.method = HttpMethod::PUT;
    ASSERT_TRUE (client_->send (urlencoded).is_ok ());
    EXPECT_EQ (server_->body (), "");
    EXPECT_EQ (server_->content_type (), "");

    auto multipart =
    form_request (server_->url (), BodyMode::FormData, { { "off", "1", false } });
    multipart.method = HttpMethod::PUT;
    ASSERT_TRUE (client_->send (multipart).is_ok ());
    EXPECT_EQ (server_->body (), "");
    EXPECT_EQ (server_->content_type (), "");
}

// The method must survive the body: both encoders switch curl to POST, so a
// PUT that lost its verb would arrive as a POST (the trap apply_method_and_body
// already documents for POSTFIELDS, now shared with MIMEPOST).
TEST_F (FormBodyWireTest, FormBodyKeepsANonPostMethod) {
    auto request =
    form_request (server_->url (), BodyMode::FormData, { { "a", "1", true } });
    request.method = HttpMethod::PUT;

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200); // only PUT /echo answers 200
}

// ---------------------------------------------------------------------------
// The wire, through the event loop - the driver every load run uses. Both
// drivers share apply_method_and_body; this proves the sharing is real rather
// than assumed, and that a load run sends the same bytes a Send does.
// ---------------------------------------------------------------------------

TEST_F (FormBodyWireTest, LoadDriverSendsTheSameUrlEncodedBody) {
    EventLoop loop;
    loop.start ();

    auto request = form_request (server_->url (), BodyMode::Form,
    { { "name", "ada lovelace", true }, { "off", "x", false } });
    auto handle  = loop.submit_async (request);
    auto result  = handle.future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (server_->body (), "name=ada%20lovelace");
    EXPECT_EQ (server_->content_type (), "application/x-www-form-urlencoded");
}

TEST_F (FormBodyWireTest, LoadDriverSendsTheSameMultipartBody) {
    EventLoop loop;
    loop.start ();

    auto request =
    form_request (server_->url (), BodyMode::FormData, { { "name", "ada", true } });
    auto handle = loop.submit_async (request);
    auto result = handle.future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_TRUE (
    server_->content_type ().starts_with ("multipart/form-data; boundary="))
    << server_->content_type ();
    EXPECT_EQ (server_->parts ().at ("name"), "ada");
}

// The multipart body is attached to a pooled handle and freed with the
// transfer; a leak or a double free would show up as a second request that
// sends the previous body, or as a crash. Three sends in a row through the
// same loop is the cheapest way to exercise handle reuse.
TEST_F (FormBodyWireTest, MultipartSurvivesHandleReuse) {
    EventLoop loop;
    loop.start ();

    for (int i = 0; i < 3; ++i) {
        auto request = form_request (server_->url (), BodyMode::FormData,
        { { "n", std::to_string (i), true } });
        auto result  = loop.submit_async (request).future.get ();
        ASSERT_TRUE (result.is_ok ()) << result.error ().message;
        EXPECT_EQ (server_->parts ().at ("n"), std::to_string (i));
    }

    loop.stop ();
}

// ---------------------------------------------------------------------------
// The encoding rules on their own - no handle, no socket.
// ---------------------------------------------------------------------------

TEST (FormBodyRules, EncodesEnabledFieldsOnly) {
    EXPECT_EQ (encode_urlencoded ({ { "a", "1", true }, { "b", "2", false } }), "a=1");
    EXPECT_EQ (encode_urlencoded ({}), "");
    EXPECT_EQ (encode_urlencoded ({ { "empty", "", true } }), "empty=");
}

TEST (FormBodyRules, HasWireBodyIsModeAware) {
    Body none;
    EXPECT_FALSE (has_wire_body (none));

    Body text;
    text.mode = BodyMode::Text;
    EXPECT_FALSE (has_wire_body (text));
    text.content = "hi";
    EXPECT_TRUE (has_wire_body (text));

    // A form body's content lives in `fields`; a non-empty `content` on a form
    // mode is not a body, which is exactly what the old `content`-only
    // predicate got wrong in the other direction.
    Body form;
    form.mode    = BodyMode::Form;
    form.content = "ignored";
    EXPECT_FALSE (has_wire_body (form));
    form.fields = { { "a", "1", false } };
    EXPECT_FALSE (has_wire_body (form));
    form.fields = { { "a", "1", true } };
    EXPECT_TRUE (has_wire_body (form));
}

TEST (FormBodyRules, ContentTypeOwnership) {
    Body urlencoded;
    urlencoded.mode   = BodyMode::Form;
    urlencoded.fields = { { "a", "1", true } };
    EXPECT_EQ (implied_content_type (urlencoded), "application/x-www-form-urlencoded");
    EXPECT_FALSE (content_type_is_engine_owned (urlencoded));

    Body multipart;
    multipart.mode   = BodyMode::FormData;
    multipart.fields = { { "a", "1", true } };
    EXPECT_EQ (implied_content_type (multipart), "");
    EXPECT_TRUE (content_type_is_engine_owned (multipart));

    // No body, nothing to describe.
    Body empty;
    empty.mode = BodyMode::Form;
    EXPECT_EQ (implied_content_type (empty), "");
    EXPECT_FALSE (content_type_is_engine_owned (empty));

    // The modes the engine has never derived a Content-Type for keep it that way.
    Body json;
    json.mode    = BodyMode::Json;
    json.content = "{}";
    EXPECT_EQ (implied_content_type (json), "");
}

// ---------------------------------------------------------------------------
// The payload shape, at the one parse point /execute and /runs share.
// ---------------------------------------------------------------------------

TEST (FormBodyPayload, AcceptsBothSpellingsOfEachMode) {
    const auto parse = [] (const char* mode) {
        vayu::json::Json json = { { "method", "POST" }, { "url", "http://x" },
            { "body", { { "mode", mode }, { "fields", vayu::json::Json::array () } } } };
        return vayu::json::deserialize_request (json);
    };

    for (const char* mode : { "x-www-form-urlencoded", "form" }) {
        auto parsed = parse (mode);
        ASSERT_TRUE (parsed.is_ok ()) << mode << ": " << parsed.error ().message;
        EXPECT_EQ (parsed.value ().body.mode, BodyMode::Form) << mode;
    }
    for (const char* mode : { "form-data", "formdata" }) {
        auto parsed = parse (mode);
        ASSERT_TRUE (parsed.is_ok ()) << mode << ": " << parsed.error ().message;
        EXPECT_EQ (parsed.value ().body.mode, BodyMode::FormData) << mode;
    }
}

TEST (FormBodyPayload, ParsesFieldsAndTheirEnabledFlag) {
    vayu::json::Json json = { { "method", "POST" }, { "url", "http://x" },
        { "body",
        { { "mode", "form-data" },
        { "fields",
        { { { "key", "a" }, { "value", "1" } },
        { { "key", "b" }, { "value", "2" }, { "enabled", false } },
        // Malformed-data leniency, matching parse_variables:
        // a non-string value reads as "" and a non-boolean
        // `enabled` reads as enabled.
        { { "key", "c" }, { "value", 7 }, { "enabled", "yes" } } } } } } };

    auto parsed = vayu::json::deserialize_request (json);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;

    const auto& fields = parsed.value ().body.fields;
    ASSERT_EQ (fields.size (), 3u);
    EXPECT_EQ (fields[0].key, "a");
    EXPECT_EQ (fields[0].value, "1");
    EXPECT_TRUE (fields[0].enabled);
    EXPECT_FALSE (fields[1].enabled);
    EXPECT_EQ (fields[2].value, "");
    EXPECT_TRUE (fields[2].enabled);
}

// The silent-empty-body failure had exactly one symptom: nothing. Every way of
// getting the shape wrong now says so instead.
TEST (FormBodyPayload, RejectsAMalformedFormBody) {
    const auto message_for = [] (const vayu::json::Json& body) {
        vayu::json::Json json = { { "method", "POST" }, { "url", "http://x" },
            { "body", body } };
        auto parsed           = vayu::json::deserialize_request (json);
        EXPECT_TRUE (parsed.is_error ()) << body.dump ();
        return parsed.is_error () ? parsed.error ().message : std::string{};
    };

    // A form mode with no fields at all - the shape MCP used to produce, which
    // previously went out as an empty body.
    EXPECT_NE (message_for ({ { "mode", "form-data" }, { "content", "a=1" } }).find ("fields"),
    std::string::npos);
    EXPECT_NE (message_for ({ { "mode", "x-www-form-urlencoded" } }).find ("fields"),
    std::string::npos);
    // Wrong container, wrong entry, unnamed field.
    message_for ({ { "mode", "form-data" }, { "fields", "a=1" } });
    message_for ({ { "mode", "form-data" }, { "fields", { "a" } } });
    message_for ({ { "mode", "form-data" }, { "fields", { { { "value", "1" } } } } });
    // `fields` on a mode whose content is a string is a client bug too - it
    // would otherwise be read by nothing.
    message_for ({ { "mode", "json" }, { "content", "{}" },
    { "fields", vayu::json::Json::array () } });
}

TEST (FormBodyPayload, RoundTripsThroughSerialization) {
    vayu::Request request;
    request.method      = HttpMethod::POST;
    request.url         = "http://x";
    request.body.mode   = BodyMode::Form;
    request.body.fields = { { "a", "1", true }, { "b", "2", false } };

    const vayu::json::Json json = vayu::json::serialize (request);
    EXPECT_EQ (json["body"]["mode"], "x-www-form-urlencoded");

    auto parsed = vayu::json::deserialize_request (json);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    ASSERT_EQ (parsed.value ().body.fields.size (), 2u);
    EXPECT_EQ (parsed.value ().body.fields[1].key, "b");
    EXPECT_FALSE (parsed.value ().body.fields[1].enabled);
    EXPECT_EQ (parsed.value ().body.mode, BodyMode::Form);
}

} // namespace
} // namespace vayu::http
