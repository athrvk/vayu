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

#include <atomic>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "echo_server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::http {
namespace {

// The echo endpoint lives in `echo_server.hpp`: the GraphQL body test asserts
// on the same wire, and two copies of a server would drift apart.
using vayu::tests::EchoServer;

Request form_request (const std::string& url, BodyMode mode, std::vector<FormField> fields) {
    Request request;
    request.method      = HttpMethod::POST;
    request.url         = url;
    request.body.mode   = mode;
    request.body.fields = std::move (fields);
    return request;
}

/// A file part, spelled out - the aggregate has enough members now that a
/// positional initializer at each call site would be unreadable.
FormField file_field (std::string key,
std::string src,
std::string file_name    = {},
std::string content_type = {}) {
    FormField field;
    field.key          = std::move (key);
    field.type         = FormFieldType::File;
    field.src          = std::move (src);
    field.file_name    = std::move (file_name);
    field.content_type = std::move (content_type);
    return field;
}

/// A real file on disk for the duration of a test - a file part is only
/// meaningful against one, and the engine reads it rather than being handed
/// bytes.
class TempFile {
    public:
    explicit TempFile (const std::string& name, const std::string& contents) {
        static std::atomic<int> counter{ 0 };
        path_ = std::filesystem::temp_directory_path () /
        ("vayu-form-body-" + std::to_string (counter.fetch_add (1)) + "-" + name);
        std::ofstream out (path_, std::ios::binary);
        out << contents;
    }

    ~TempFile () {
        std::error_code ignored;
        std::filesystem::remove (path_, ignored);
    }

    TempFile (const TempFile&)            = delete;
    TempFile& operator= (const TempFile&) = delete;

    std::string path () const {
        return path_.string ();
    }

    private:
    std::filesystem::path path_;
};

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
    EXPECT_EQ (parts.at ("name").content, "ada");
    EXPECT_EQ (parts.at ("note").content, "hello world");
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
// File parts (issue #393). A part that names a file has to arrive as a file:
// with its bytes, its filename, and - when the request states one - its own
// Content-Type. Text and file parts mix in one body.
// ---------------------------------------------------------------------------

TEST_F (FormBodyWireTest, FilePartUploadsTheFileBesideTextParts) {
    TempFile file ("avatar.png", "\x89PNG\r\n binary-ish bytes");

    auto request = form_request (server_->url (), BodyMode::FormData,
    { { "caption", "my avatar", true }, file_field ("avatar", file.path ()) });

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200);

    const auto parts = server_->parts ();
    ASSERT_EQ (parts.size (), 2u);
    EXPECT_EQ (parts.at ("caption").content, "my avatar");
    EXPECT_EQ (parts.at ("avatar").content, "\x89PNG\r\n binary-ish bytes");
    // The basename, which is what libcurl declares when nothing overrides it -
    // a part with no filename is indistinguishable from a text field server-side.
    EXPECT_EQ (parts.at ("avatar").filename,
    std::filesystem::path (file.path ()).filename ().string ());
    EXPECT_EQ (parts.at ("caption").filename, "");
}

TEST_F (FormBodyWireTest, FilePartHonoursAnExplicitNameAndContentType) {
    TempFile file ("upload.bin", "id,name\n1,ada\n");

    auto request = form_request (server_->url (), BodyMode::FormData,
    { file_field ("dataset", file.path (), "people.csv", "text/csv") });

    ASSERT_TRUE (client_->send (request).is_ok ());
    const auto parts = server_->parts ();
    ASSERT_EQ (parts.count ("dataset"), 1u);
    // Not the basename on disk: an imported part keeps the filename the
    // exporting app recorded, and a per-part type is the only way to say what
    // the bytes are.
    EXPECT_EQ (parts.at ("dataset").filename, "people.csv");
    EXPECT_EQ (parts.at ("dataset").content_type, "text/csv");
    EXPECT_EQ (parts.at ("dataset").content, "id,name\n1,ada\n");
}

TEST_F (FormBodyWireTest, ADisabledFilePartIsNeitherSentNorRead) {
    // The row is off, so its (nonexistent) file must not even be opened - a
    // disabled part that still refused the request would make the checkbox
    // useless for exactly the row that needs it.
    auto request = form_request (server_->url (), BodyMode::FormData,
    { { "kept", "1", true }, file_field ("gone", "/nonexistent/vayu/file.png") });
    request.body.fields[1].enabled = false;

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (result.value ().status_code, 200);
    EXPECT_EQ (server_->parts ().count ("gone"), 0u);
}

// The failure the issue names: a file that is not there must fail the request
// with a message naming it, never a part that quietly does not go out.
// Mutation-check: drop the unsendable_file_part call from validate_transferable
// and this reaches the server as a 200 with the part missing.
TEST_F (FormBodyWireTest, AMissingFileFailsTheRequestByName) {
    const std::string missing =
    (std::filesystem::temp_directory_path () / "vayu-no-such-file.png").string ();
    auto request = form_request (
    server_->url (), BodyMode::FormData, { file_field ("avatar", missing) });

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ())
    << "a refusal is a failed response, not an Error";
    EXPECT_EQ (result.value ().status_code, 0);
    EXPECT_EQ (result.value ().error_code, ErrorCode::InternalError);
    EXPECT_NE (result.value ().error_message.find ("avatar"), std::string::npos)
    << result.value ().error_message;
    EXPECT_NE (result.value ().error_message.find (missing), std::string::npos)
    << result.value ().error_message;
}

TEST_F (FormBodyWireTest, AFilePartWithNoFileChosenFailsTheRequest) {
    auto request =
    form_request (server_->url (), BodyMode::FormData, { file_field ("avatar", "") });

    auto result = client_->send (request);
    ASSERT_TRUE (result.is_ok ());
    EXPECT_EQ (result.value ().status_code, 0);
    EXPECT_NE (result.value ().error_message.find ("avatar"), std::string::npos)
    << result.value ().error_message;
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
    EXPECT_EQ (server_->parts ().at ("name").content, "ada");
}

// A load run uploads the file too, and re-reads it per iteration (libcurl reads
// the file during the transfer, so the second send carries the same bytes
// rather than a consumed stream).
TEST_F (FormBodyWireTest, LoadDriverUploadsAFilePartOnEveryIteration) {
    TempFile file ("payload.txt", "iteration payload");
    EventLoop loop;
    loop.start ();

    for (int i = 0; i < 2; ++i) {
        auto request = form_request (server_->url (), BodyMode::FormData,
        { file_field ("blob", file.path (), "payload.txt", "text/plain") });
        auto result  = loop.submit_async (request).future.get ();
        ASSERT_TRUE (result.is_ok ()) << result.error ().message;
        EXPECT_EQ (server_->parts ().at ("blob").content, "iteration payload");
        EXPECT_EQ (server_->parts ().at ("blob").filename, "payload.txt");
    }

    loop.stop ();
}

// The refusal is the same on the load path - both drivers gate on
// validate_transferable, and a load run that silently dropped the file would
// measure a request nobody asked for.
TEST_F (FormBodyWireTest, LoadDriverRefusesAMissingFileByName) {
    EventLoop loop;
    loop.start ();

    auto request = form_request (server_->url (), BodyMode::FormData,
    { file_field ("avatar", "/nonexistent/vayu/avatar.png") });
    auto result  = loop.submit_async (request).future.get ();
    loop.stop ();

    ASSERT_TRUE (result.is_ok ())
    << "a refusal is a failed response, not an Error";
    EXPECT_EQ (result.value ().status_code, 0);
    EXPECT_NE (result.value ().error_message.find ("avatar"), std::string::npos)
    << result.value ().error_message;
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
        EXPECT_EQ (server_->parts ().at ("n").content, std::to_string (i));
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

// ---------------------------------------------------------------------------
// The form-data rendering (#411). A file part carries its content in `src`, so
// encoding it as a pair rendered `avatar=` - the same string an empty text part
// produces, which is the ambiguity these pin shut.
// ---------------------------------------------------------------------------

TEST (FormBodyRules, RendersAFilePartDistinguishablyFromAnEmptyTextPart) {
    EXPECT_EQ (render_form_data_parts ({ { "caption", "my avatar", true },
               file_field ("avatar", "/home/ada/portrait.png") }),
    "caption=my%20avatar&avatar=@portrait.png");

    // The string the defect produced, still produced by the text part alone -
    // so the two are now different strings rather than the same one.
    EXPECT_EQ (render_form_data_parts ({ { "avatar", "", true } }), "avatar=");
}

TEST (FormBodyRules, RendersTheDeclaredFilenameRatherThanThePath) {
    // Only the basename, because that is what the server is told and a path
    // discloses this machine's layout to anything the script logs.
    EXPECT_EQ (render_form_data_parts ({ file_field ("f", "/home/ada/secret-dir/report.pdf") }),
    "f=@report.pdf");
    EXPECT_EQ (render_form_data_parts ({ file_field ("f", "C:\\Users\\ada\\report.pdf") }),
    "f=@report.pdf");
    // An explicit name overrides the basename, exactly as curl_mime_filename
    // overrides what curl_mime_filedata declared.
    EXPECT_EQ (render_form_data_parts ({ file_field ("f", "/tmp/tmp123.bin", "report.pdf") }),
    "f=@report.pdf");
}

TEST (FormBodyRules, TheFileMarkerCannotBeForgedByATextValue) {
    // `@` is unreserved-adjacent but not unreserved, so a value starting with
    // one is escaped and can never render as the marker.
    EXPECT_EQ (render_form_data_parts ({ { "f", "@portrait.png", true } }), "f=%40portrait.png");
}

TEST (FormBodyRules, RenderFormDataSkipsDisabledPartsAndNamesUnchosenFiles) {
    FormField off = file_field ("off", "/home/ada/portrait.png");
    off.enabled   = false;
    EXPECT_EQ (render_form_data_parts ({ { "on", "1", true }, off }), "on=1");

    // A part authored but never pointed at a file. `unsendable_file_part`
    // refuses it before the transfer, but a pre-request script runs first and
    // reads the body as it stands - and a bare `@` is still not `chosen=`.
    EXPECT_EQ (render_form_data_parts ({ file_field ("chosen", "") }), "chosen=@");
}

TEST (FormBodyRules, ParsesUrlencodedBackIntoFields) {
    const auto fields = parse_urlencoded ("a=1&b=two");
    ASSERT_EQ (fields.size (), 2u);
    EXPECT_EQ (fields[0].key, "a");
    EXPECT_EQ (fields[0].value, "1");
    EXPECT_EQ (fields[1].key, "b");
    EXPECT_EQ (fields[1].value, "two");
    // Nothing in the string says a row is off, and inventing a disabled one
    // would drop a field the caller wrote.
    EXPECT_TRUE (fields[0].enabled);
    EXPECT_TRUE (fields[1].enabled);

    EXPECT_TRUE (parse_urlencoded ("").empty ());
}

TEST (FormBodyRules, ParseUrlencodedDecodesTheMediaTypesEscapes) {
    // `+` is a space in this media type; a literal plus arrives as %2B and has
    // to survive as one, which is why the two are handled in that order.
    const auto fields = parse_urlencoded ("q=hello+world&sum=1%2B1&sp=a%20b");
    ASSERT_EQ (fields.size (), 3u);
    EXPECT_EQ (fields[0].value, "hello world");
    EXPECT_EQ (fields[1].value, "1+1");
    EXPECT_EQ (fields[2].value, "a b");

    // Keys are decoded too - the encoder escapes both sides.
    const auto keyed = parse_urlencoded ("odd%20key=v");
    ASSERT_EQ (keyed.size (), 1u);
    EXPECT_EQ (keyed[0].key, "odd key");
}

TEST (FormBodyRules, ParseUrlencodedHandlesPairsWithoutAValue) {
    // A list of pairs has no malformed case to reject: a segment with no `=`
    // is a field with an empty value, and an empty segment is nothing at all.
    const auto fields = parse_urlencoded ("flag&a=1&&b=");
    ASSERT_EQ (fields.size (), 3u);
    EXPECT_EQ (fields[0].key, "flag");
    EXPECT_EQ (fields[0].value, "");
    EXPECT_EQ (fields[1].key, "a");
    EXPECT_EQ (fields[1].value, "1");
    EXPECT_EQ (fields[2].key, "b");
    EXPECT_EQ (fields[2].value, "");
}

TEST (FormBodyRules, EncodeAndParseAreInverses) {
    // The round-trip the script bridge depends on: a script that reads
    // pm.request.body and writes it straight back must change nothing.
    const std::vector<FormField> fields = { { "grant_type", "client_credentials", true },
        { "scope", "read write", true }, { "sum", "1+1", true }, { "empty", "", true } };

    const auto reparsed = parse_urlencoded (encode_urlencoded (fields));
    ASSERT_EQ (reparsed.size (), fields.size ());
    for (size_t i = 0; i < fields.size (); ++i) {
        EXPECT_EQ (reparsed[i].key, fields[i].key);
        EXPECT_EQ (reparsed[i].value, fields[i].value);
    }
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

TEST (FormBodyRules, FilePartDetectionIsModeAndRowAware) {
    Body text;
    text.mode   = BodyMode::FormData;
    text.fields = { { "a", "1", true } };
    EXPECT_FALSE (has_file_parts (text));
    EXPECT_FALSE (unsendable_file_part (text).has_value ());

    Body with_file;
    with_file.mode = BodyMode::FormData;
    FormField file;
    file.key         = "avatar";
    file.type        = FormFieldType::File;
    file.src         = "/nonexistent/vayu/avatar.png";
    with_file.fields = { file };
    EXPECT_TRUE (has_file_parts (with_file));

    // Off means off: neither counted nor opened.
    with_file.fields[0].enabled = false;
    EXPECT_FALSE (has_file_parts (with_file));
    EXPECT_FALSE (unsendable_file_part (with_file).has_value ());
}

TEST (FormBodyRules, UnsendableFilePartNamesTheFieldAndThePath) {
    Body body;
    body.mode = BodyMode::FormData;
    FormField file;
    file.key    = "avatar";
    file.type   = FormFieldType::File;
    file.src    = "/nonexistent/vayu/avatar.png";
    body.fields = { file };

    const auto missing = unsendable_file_part (body);
    ASSERT_TRUE (missing.has_value ());
    EXPECT_NE (missing->find ("avatar"), std::string::npos) << *missing;
    EXPECT_NE (missing->find ("/nonexistent/vayu/avatar.png"), std::string::npos)
    << *missing;

    // No file chosen at all is its own message - "cannot read ''" would point
    // the user at a path that does not exist because they never named one.
    body.fields[0].src = "";
    const auto unset   = unsendable_file_part (body);
    ASSERT_TRUE (unset.has_value ());
    EXPECT_NE (unset->find ("avatar"), std::string::npos) << *unset;
    EXPECT_NE (unset->find ("no file selected"), std::string::npos) << *unset;
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

    // A JSON body implies application/json (issue #889). It did not, and
    // libcurl's default for a POST with a body is
    // `application/x-www-form-urlencoded` - so a request whose mode says JSON,
    // whose editor highlights JSON and whose stored `bodyType` is `json` went
    // out declaring itself a form. The app's body panel wrote the header row for
    // a request built in the UI, which is why this survived: every request
    // created any other way (MCP `create_request`, an import, a payload posted
    // straight to /execute) sent the wrong type.
    Body json;
    json.mode    = BodyMode::Json;
    json.content = "{}";
    EXPECT_EQ (implied_content_type (json), "application/json");
    // Derived, not owned: a Content-Type the caller set still wins, which is
    // what lets a JSON body go out as `application/vnd.api+json`.
    EXPECT_FALSE (content_type_is_engine_owned (json));

    // An empty JSON body describes nothing, the same as every other mode.
    Body empty_json;
    empty_json.mode = BodyMode::Json;
    EXPECT_EQ (implied_content_type (empty_json), "");

    // `text` stays absent, and deliberately: JSON has exactly one right answer
    // and text has none - `text/plain`, `text/csv` and a JWT are all this mode,
    // so the header is the author's to write. Not an oversight, a different
    // question.
    Body text;
    text.mode    = BodyMode::Text;
    text.content = "hello";
    EXPECT_EQ (implied_content_type (text), "");
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

TEST (FormBodyPayload, ParsesAFilePart) {
    vayu::json::Json json = { { "method", "POST" }, { "url", "http://x" },
        { "body",
        { { "mode", "form-data" },
        { "fields",
        { { { "key", "caption" }, { "value", "hi" } },
        { { "key", "avatar" }, { "type", "file" }, { "src", "/tmp/a.png" },
        { "fileName", "profile.png" }, { "contentType", "image/png" } },
        // The explicit text spelling is accepted and means what the default means.
        { { "key", "note" }, { "value", "n" }, { "type", "text" } } } } } } };

    auto parsed = vayu::json::deserialize_request (json);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;

    const auto& fields = parsed.value ().body.fields;
    ASSERT_EQ (fields.size (), 3u);
    EXPECT_EQ (fields[0].type, FormFieldType::Text);
    EXPECT_EQ (fields[1].type, FormFieldType::File);
    EXPECT_EQ (fields[1].src, "/tmp/a.png");
    EXPECT_EQ (fields[1].file_name, "profile.png");
    EXPECT_EQ (fields[1].content_type, "image/png");
    EXPECT_EQ (fields[2].type, FormFieldType::Text);
}

// A file part that cannot be understood must not degrade into a text part
// carrying nothing - that is the silent-drop failure this issue removes, one
// layer earlier.
TEST (FormBodyPayload, RejectsAMalformedFilePart) {
    const auto message_for = [] (const vayu::json::Json& body) {
        vayu::json::Json json = { { "method", "POST" }, { "url", "http://x" },
            { "body", body } };
        auto parsed           = vayu::json::deserialize_request (json);
        EXPECT_TRUE (parsed.is_error ()) << body.dump ();
        return parsed.is_error () ? parsed.error ().message : std::string{};
    };

    // An unknown or non-string discriminator.
    EXPECT_NE (message_for ({ { "mode", "form-data" },
                            { "fields", { { { "key", "a" }, { "type", "binary" } } } } })
               .find ("type"),
    std::string::npos);
    message_for (
    { { "mode", "form-data" }, { "fields", { { { "key", "a" }, { "type", 7 } } } } });

    // urlencoded has no file form - its wire body is a string of pairs.
    EXPECT_NE (
    message_for ({ { "mode", "x-www-form-urlencoded" },
                 { "fields", { { { "key", "a" }, { "type", "file" }, { "src", "/tmp/a" } } } } })
    .find ("form-data"),
    std::string::npos);

    // A path on a text part: the caller pointed at a file nothing would send.
    EXPECT_NE (message_for ({ { "mode", "form-data" },
                            { "fields", { { { "key", "a" }, { "src", "/tmp/a" } } } } })
               .find ("src"),
    std::string::npos);

    // The file members have to be strings.
    message_for ({ { "mode", "form-data" },
    { "fields", { { { "key", "a" }, { "type", "file" }, { "src", 3 } } } } });
    message_for ({ { "mode", "form-data" },
    { "fields",
    { { { "key", "a" }, { "type", "file" }, { "src", "/tmp/a" }, { "fileName", 3 } } } } });
}

TEST (FormBodyPayload, RoundTripsAFilePartThroughSerialization) {
    vayu::Request request;
    request.method    = HttpMethod::POST;
    request.url       = "http://x";
    request.body.mode = BodyMode::FormData;
    FormField file;
    file.key            = "avatar";
    file.type           = FormFieldType::File;
    file.src            = "/tmp/a.png";
    file.file_name      = "profile.png";
    file.content_type   = "image/png";
    request.body.fields = { { "caption", "hi", true }, file };

    const vayu::json::Json json = vayu::json::serialize (request);
    // A text row keeps exactly the three keys it always had - a stored body
    // with no file part must serialize to the same bytes it used to.
    EXPECT_EQ (json["body"]["fields"][0].size (), 3u);
    EXPECT_EQ (json["body"]["fields"][1]["type"], "file");

    auto parsed = vayu::json::deserialize_request (json);
    ASSERT_TRUE (parsed.is_ok ()) << parsed.error ().message;
    const auto& fields = parsed.value ().body.fields;
    ASSERT_EQ (fields.size (), 2u);
    EXPECT_EQ (fields[1].type, FormFieldType::File);
    EXPECT_EQ (fields[1].src, "/tmp/a.png");
    EXPECT_EQ (fields[1].file_name, "profile.png");
    EXPECT_EQ (fields[1].content_type, "image/png");
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
