/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file jmeter_import_test.cpp
 * @brief The `.jmx` importer (issue #1518): format detection, the mapping
 *        table's acceptance-criteria scenario, and the "nothing dropped
 *        quietly" rule for a class this parser has no mapping for.
 */

#include "vayu/core/import_document.hpp"
#include "vayu/core/jmeter_import.hpp"

#include <gtest/gtest.h>

#include <algorithm>

namespace {

using vayu::core::ImportOptions;
using vayu::core::ImportParse;
using vayu::core::ImportSource;
using vayu::core::is_jmeter_document;
using vayu::core::parse_import;

const nlohmann::ordered_json& first_request (const nlohmann::ordered_json& collection) {
    return collection.at ("requests").at (0);
}

bool has_skipped_kind (const nlohmann::ordered_json& meta, const std::string& kind) {
    const nlohmann::ordered_json& skipped = meta.at ("skipped");
    return std::any_of (
    skipped.begin (), skipped.end (), [&] (const nlohmann::ordered_json& item) {
        return item.at ("kind").get<std::string> () == kind;
    });
}

/**
 * A login sampler, a JSON extractor, a bearer header on the next sampler, a
 * response assertion (against the status) and a constant timer - the issue's
 * own acceptance-criteria scenario - plus a `CookieManager` neither this
 * parser nor Vayu's element model has anything to map it onto.
 */
const char* PLAN = R"jmx(<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan testname="Test Plan" enabled="true"/>
    <hashTree>
      <ThreadGroup testname="Users" enabled="true"/>
      <hashTree>
        <HTTPSamplerProxy testname="Login" enabled="true">
          <stringProp name="HTTPSampler.domain">example.com</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/login</stringProp>
          <stringProp name="HTTPSampler.method">POST</stringProp>
          <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="" elementType="HTTPArgument">
                <stringProp name="Argument.value">{"user":"a","pass":"b"}</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>
        </HTTPSamplerProxy>
        <hashTree>
          <JSONPostProcessor testname="Extract token" enabled="true">
            <stringProp name="JSONPostProcessor.referenceNames">token</stringProp>
            <stringProp name="JSONPostProcessor.jsonPathExprs">$.access_token</stringProp>
            <stringProp name="JSONPostProcessor.match_numbers">1</stringProp>
          </JSONPostProcessor>
          <hashTree/>
        </hashTree>
        <HTTPSamplerProxy testname="Get profile" enabled="true">
          <stringProp name="HTTPSampler.path">/profile</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree>
          <HeaderManager testname="Auth header" enabled="true">
            <collectionProp name="HeaderManager.headers">
              <elementProp name="" elementType="Header">
                <stringProp name="Header.name">Authorization</stringProp>
                <stringProp name="Header.value">Bearer ${token}</stringProp>
              </elementProp>
            </collectionProp>
          </HeaderManager>
          <hashTree/>
          <ResponseAssertion testname="Check 200" enabled="true">
            <collectionProp name="Asserion.test_strings">
              <stringProp name="49586">200</stringProp>
            </collectionProp>
            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
            <intProp name="Assertion.test_type">2</intProp>
          </ResponseAssertion>
          <hashTree/>
        </hashTree>
        <ConstantTimer testname="Pause" enabled="true">
          <stringProp name="ConstantTimer.delay">250</stringProp>
        </ConstantTimer>
        <hashTree/>
        <CookieManager testname="HTTP Cookie Manager" enabled="true"/>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
)jmx";

} // namespace

TEST (JmeterDetection, RecognisesAJmeterTestPlanAndNothingElse) {
    EXPECT_TRUE (is_jmeter_document (PLAN));
    EXPECT_FALSE (is_jmeter_document (R"({"openapi":"3.0.0"})"));
    EXPECT_FALSE (is_jmeter_document (""));
}

TEST (JmeterImport, ImportsTheLoginThenCallScenario) {
    const ImportParse parsed = parse_import (PLAN, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const nlohmann::ordered_json& collection = parsed.result.at ("collections").at (0);
    const nlohmann::ordered_json& requests = collection.at ("requests");
    ASSERT_EQ (requests.size (), 2);

    const nlohmann::ordered_json& login = requests.at (0);
    EXPECT_EQ (login.at ("method"), "POST");
    EXPECT_EQ (login.at ("url"), "https://example.com/login");
    EXPECT_EQ (login.at ("body").at ("mode"), "text");
    ASSERT_TRUE (login.contains ("elements"));
    EXPECT_EQ (login.at ("elements").at (0).at ("kind"), "extract.json");
    EXPECT_EQ (login.at ("elements").at (0).at ("config").at ("path"), "$.access_token");
    EXPECT_EQ (login.at ("elements").at (0).at ("config").at ("variable"), "token");

    const nlohmann::ordered_json& profile = requests.at (1);
    EXPECT_EQ (profile.at ("method"), "GET");
    ASSERT_EQ (profile.at ("headers").size (), 1);
    EXPECT_EQ (profile.at ("headers").at (0).at ("key"), "Authorization");
    // JMeter's `${token}` became Vayu's `{{token}}` - the extractor's own
    // variable, resolvable against what the login step wrote.
    EXPECT_EQ (profile.at ("headers").at (0).at ("value"), "Bearer {{token}}");
    ASSERT_TRUE (profile.contains ("elements"));
    const bool asserts_status = std::any_of (profile.at ("elements").begin (),
    profile.at ("elements").end (), [] (const nlohmann::ordered_json& element) {
        return element.at ("kind") == "assert.status" &&
        element.at ("config").at ("in").at (0) == 200;
    });
    EXPECT_TRUE (asserts_status);
    // `ConstantTimer` sits beside both samplers in the plan, not inside
    // either one's own `<hashTree>` - it lands on the enclosing collection's
    // own `elements`, inherited into every request the same way any other
    // collection-level element is (Vayu has no per-sampler timer scope of
    // its own to distinguish this from that inherited case).
    ASSERT_TRUE (collection.contains ("elements"));
    const bool waits = std::any_of (collection.at ("elements").begin (),
    collection.at ("elements").end (), [] (const nlohmann::ordered_json& element) {
        return element.at ("kind") == "timer.think" &&
        element.at ("config").at ("ms") == 250;
    });
    EXPECT_TRUE (waits);

    // `CookieManager` has no element-kind mapping - counted, not dropped
    // quietly, per the issue's own rule.
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "CookieManager"));
}

/// Mutation check for the timer mapping above: with `ConstantTimer.delay`
/// missing, no `timer.think` element is built and the class is counted as
/// unrecognised instead of silently applying a 0ms wait.
TEST (JmeterImport, ADelaylessConstantTimerIsCountedRatherThanGuessedAt) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <ConstantTimer testname="Pause"/>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& collection = parsed.result.at ("collections").at (0);
    EXPECT_FALSE (collection.contains ("elements"));
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "ConstantTimer_unrecognised"));
}

TEST (JmeterImport, AnIfControllerBecomesAFolderWithAControlIfElement) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <ThreadGroup testname="Users"/><hashTree>
      <IfController testname="Only gold tier">
        <stringProp name="IfController.condition">${tier} == "gold"</stringProp>
      </IfController>
      <hashTree>
        <HTTPSamplerProxy testname="Checkout">
          <stringProp name="HTTPSampler.path">/checkout</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& collection = parsed.result.at ("collections").at (0);
    ASSERT_EQ (collection.at ("children").size (), 1);
    const nlohmann::ordered_json& folder = collection.at ("children").at (0);
    ASSERT_TRUE (folder.contains ("elements"));
    EXPECT_EQ (folder.at ("elements").at (0).at ("kind"), "control.if");
    EXPECT_EQ (folder.at ("elements").at (0).at ("config").at ("condition"), "{{tier}} == gold");
    ASSERT_EQ (folder.at ("requests").size (), 1);
    EXPECT_EQ (folder.at ("requests").at (0).at ("name"), "Checkout");
}

TEST (JmeterImport, AnIfControllerWithAnUnparseableConditionIsTalliedNotDroppedSilently) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <ThreadGroup testname="Users"/><hashTree>
      <IfController testname="Only gold tier">
        <stringProp name="IfController.condition">${__javaScript("${tier}" == "gold")}</stringProp>
      </IfController>
      <hashTree>
        <HTTPSamplerProxy testname="Checkout">
          <stringProp name="HTTPSampler.path">/checkout</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& collection = parsed.result.at ("collections").at (0);
    ASSERT_EQ (collection.at ("children").size (), 1);
    const nlohmann::ordered_json& folder = collection.at ("children").at (0);
    EXPECT_FALSE (folder.contains ("elements"));
    ASSERT_EQ (folder.at ("requests").size (), 1);
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "IfController_unrecognised"));
}

TEST (JmeterImport, ASwitchControllerIsTalliedNotDroppedSilently) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <ThreadGroup testname="Users"/><hashTree>
      <SwitchController testname="By tier">
        <stringProp name="SwitchController.selection">gold</stringProp>
      </SwitchController>
      <hashTree>
        <HTTPSamplerProxy testname="Checkout">
          <stringProp name="HTTPSampler.path">/checkout</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "SwitchController_unrecognised"));
}

TEST (JmeterImport, ALoopControllerSetToForeverIsTalliedNotDroppedSilently) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <ThreadGroup testname="Users"/><hashTree>
      <LoopController testname="Forever">
        <boolProp name="LoopController.continue_forever">true</boolProp>
        <stringProp name="LoopController.loops">-1</stringProp>
      </LoopController>
      <hashTree>
        <HTTPSamplerProxy testname="Poll">
          <stringProp name="HTTPSampler.path">/poll</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "LoopController_unrecognised"));
}

TEST (JmeterImport, BoundaryExtractorMapsOntoTheNewExtractBoundaryKind) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Page">
      <stringProp name="HTTPSampler.path">/page</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree>
      <BoundaryExtractor testname="Between quotes">
        <stringProp name="BoundaryExtractor.refname">csrf</stringProp>
        <stringProp name="BoundaryExtractor.lboundary">csrf":"</stringProp>
        <stringProp name="BoundaryExtractor.rboundary">"</stringProp>
      </BoundaryExtractor>
      <hashTree/>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections").at (0));
    ASSERT_TRUE (request.contains ("elements"));
    EXPECT_EQ (request.at ("elements").at (0).at ("kind"), "extract.boundary");
    EXPECT_EQ (request.at ("elements").at (0).at ("config").at ("leftBoundary"), "csrf\":\"");
    EXPECT_EQ (request.at ("elements").at (0).at ("config").at ("rightBoundary"), "\"");
}

/**
 * `enabled="false"` on a sampler must exclude it - and everything nested
 * under it, since JMeter itself never runs a disabled element's children
 * either - rather than importing it as active with no way to turn it back
 * off (issue #1444). Mutation check: removing the `jmeter_enabled` guard in
 * `for_each_paired_child` reds `requests.size ()` to 2 with nothing counted.
 */
TEST (JmeterImport, ADisabledSamplerIsExcludedAndCounted) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Active">
      <stringProp name="HTTPSampler.path">/active</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree/>
    <HTTPSamplerProxy testname="Off" enabled="false">
      <stringProp name="HTTPSampler.path">/off</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& requests =
    parsed.result.at ("collections").at (0).at ("requests");
    ASSERT_EQ (requests.size (), 1u);
    EXPECT_EQ (requests.at (0).at ("name"), "Active");
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "HTTPSamplerProxy_disabled"));
}

/// `HTTPSampler.follow_redirects` (and its "Redirect Automatically" sibling)
/// carries through to the stored request rather than always defaulting true
/// (issue #1444).
TEST (JmeterImport, FollowRedirectsIsRead) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="NoFollow">
      <stringProp name="HTTPSampler.path">/x</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
      <boolProp name="HTTPSampler.follow_redirects">false</boolProp>
      <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_FALSE (first_request (parsed.result.at ("collections").at (0))
    .at ("followRedirects")
    .get<bool> ());
}

/**
 * `Assertion.test_field` values with no `assert.contains` field to land on
 * (Request Data, Request Headers, Response Message, Document) are refused
 * rather than silently collapsed onto "body", which would assert against
 * text the source never named as its target (issue #1444). `sample_label`
 * ("URL Sampled") does have a home - `assert.contains`'s own "url" field.
 */
TEST (JmeterImport, AssertionTestFieldMapsUrlAndRefusesTheRest) {
    const char* url_plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Page">
      <stringProp name="HTTPSampler.path">/page</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree>
      <ResponseAssertion testname="URL check">
        <collectionProp name="Asserion.test_strings">
          <stringProp name="1">/page</stringProp>
        </collectionProp>
        <stringProp name="Assertion.test_field">Assertion.sample_label</stringProp>
        <intProp name="Assertion.test_type">2</intProp>
      </ResponseAssertion>
      <hashTree/>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse url_parsed = parse_import (url_plan, {}, {});
    ASSERT_TRUE (url_parsed.ok ()) << url_parsed.error;
    const nlohmann::ordered_json& request =
    first_request (url_parsed.result.at ("collections").at (0));
    ASSERT_TRUE (request.contains ("elements"));
    EXPECT_EQ (request.at ("elements").at (0).at ("config").at ("field"), "url");

    const char* message_plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Page">
      <stringProp name="HTTPSampler.path">/page</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree>
      <ResponseAssertion testname="Message check">
        <collectionProp name="Asserion.test_strings">
          <stringProp name="1">OK</stringProp>
        </collectionProp>
        <stringProp name="Assertion.test_field">Assertion.response_message</stringProp>
        <intProp name="Assertion.test_type">2</intProp>
      </ResponseAssertion>
      <hashTree/>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse message_parsed = parse_import (message_plan, {}, {});
    ASSERT_TRUE (message_parsed.ok ()) << message_parsed.error;
    const nlohmann::ordered_json& unmapped =
    first_request (message_parsed.result.at ("collections").at (0));
    EXPECT_FALSE (unmapped.contains ("elements"));
    EXPECT_TRUE (has_skipped_kind (
    message_parsed.result.at ("meta"), "ResponseAssertion_unrecognised"));
}

/// `HTTPsampler.Files` (a multipart file upload) has no formdata-part model
/// to build yet (issue #1657) - counted rather than dropped with nothing
/// said, since it is nested inside the sampler tag itself and would
/// otherwise never reach the generic sibling-tag tally.
TEST (JmeterImport, FileUploadArgsAreCountedRatherThanDroppedSilently) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Upload">
      <stringProp name="HTTPSampler.path">/upload</stringProp>
      <stringProp name="HTTPSampler.method">POST</stringProp>
      <elementProp name="HTTPsampler.Files" elementType="HTTPFileArgs">
        <collectionProp name="HTTPFileArgs.files">
          <elementProp name="/tmp/a.png" elementType="HTTPFileArg">
            <stringProp name="File.path">/tmp/a.png</stringProp>
            <stringProp name="File.paramname">file</stringProp>
            <stringProp name="File.mimetype">image/png</stringProp>
          </elementProp>
        </collectionProp>
      </elementProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "HTTPsampler.Files"));
}

TEST (JmeterImport, RefusesXmlThatIsNotAJmeterPlan) {
    vayu::core::ImportTally tally;
    EXPECT_THROW (
    {
        [[maybe_unused]] auto ignored =
        vayu::core::parse_jmeter ("<not-jmeter/>", {}, tally);
    },
    vayu::core::MalformedJmeter);
}
