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
#include <string>
#include <vector>

namespace {

using vayu::core::ImportOptions;
using vayu::core::ImportParse;
using vayu::core::ImportSource;
using vayu::core::is_jmeter_document;
using vayu::core::parse_import;

const nlohmann::ordered_json& first_request (const nlohmann::ordered_json& collection) {
    return collection.at ("requests").at (0);
}

/// How many elements the import tallied under @p kind; 0 when it did not.
int skipped_count (const nlohmann::ordered_json& meta, const std::string& kind) {
    for (const nlohmann::ordered_json& item : meta.at ("skipped")) {
        if (item.at ("kind").get<std::string> () == kind) {
            return item.at ("count").get<int> ();
        }
    }
    return 0;
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

/// A sampler's query arguments keep `encodeURIComponent` on the join (issue
/// #1771), not Postman's set: JMeter's own URL encoding is not Postman's.
TEST (JmeterImport, JoinsQueryArgumentsWithEncodeUriComponent) {
    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Search">
      <stringProp name="HTTPSampler.domain">example.com</stringProp>
      <stringProp name="HTTPSampler.protocol">https</stringProp>
      <stringProp name="HTTPSampler.path">/search</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
      <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          <elementProp name="q" elementType="HTTPArgument">
            <stringProp name="Argument.name">q</stringProp>
            <stringProp name="Argument.value">a|b</stringProp>
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
    EXPECT_EQ (first_request (parsed.result.at ("collections").at (0)).at ("url"),
    "https://example.com/search?q=a%7Cb");
}

/// A sampler's `HTTPSampler.protocol` left empty (what JMeter's GUI saves for
/// an unset field) means `http` like an absent one; it used to join as
/// `://host/path` (#3191).
TEST (JmeterImport, AnEmptyOrBlankProtocolDefaultsToHttp) {
    for (const char* protocol : { "", "  " }) {
        const std::string plan = std::string (R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Ping">
      <stringProp name="HTTPSampler.domain">example.com</stringProp>
      <stringProp name="HTTPSampler.protocol">)jmx") +
        protocol + R"jmx(</stringProp>
      <stringProp name="HTTPSampler.path">/ping</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
        const ImportParse parsed = parse_import (plan, {}, {});
        ASSERT_TRUE (parsed.ok ()) << parsed.error;
        EXPECT_EQ (first_request (parsed.result.at ("collections").at (0)).at ("url"),
        "http://example.com/ping")
        << "protocol [" << protocol << "]";
    }
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

/// A `Response Assertion` plan with one pattern string and a given
/// `Assertion.test_type` bitmask, against the response body (the default
/// `Assertion.test_field`).
nlohmann::ordered_json
response_assertion_plan (long test_type, const std::vector<std::string>& texts) {
    std::string strings;
    for (size_t i = 0; i < texts.size (); ++i) {
        strings += "<stringProp name=\"" + std::to_string (i + 1) + "\">" +
        texts[i] + "</stringProp>";
    }
    const std::string jmx = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Page">
      <stringProp name="HTTPSampler.path">/page</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree>
      <ResponseAssertion testname="Check">
        <collectionProp name="Asserion.test_strings">)jmx" +
    strings + R"jmx(</collectionProp>
        <intProp name="Assertion.test_type">)jmx" +
    std::to_string (test_type) + R"jmx(</intProp>
      </ResponseAssertion>
      <hashTree/>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (jmx, {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result;
}

/**
 * The `Not` bit (4) inverts the assertion (issue #1660): a Response
 * Assertion with `test_type` `6` (Contains + Not), `20` (Substring + Not) or
 * `12` (Equals + Not) imports as `assert.contains` with `negate: true`, and
 * the pattern-kind bits (1 Matches, 2 Contains, 16 Substring) resolve to the
 * mode that assertion type actually performs in JMeter: Matches and Contains
 * are both a regular-expression search (`mode: "matches"`), only Substring is
 * a plain text search (`mode: "contains"`).
 */
TEST (JmeterImport, ResponseAssertionNotBitInvertsTheMappedAssertion) {
    {
        const nlohmann::ordered_json result = response_assertion_plan (6, { "error" });
        const nlohmann::ordered_json& config =
        first_request (result.at ("collections").at (0)).at ("elements").at (0).at ("config");
        EXPECT_EQ (config.at ("negate").get<bool> (), true);
        EXPECT_EQ (config.at ("mode").get<std::string> (), "matches");
    }
    {
        const nlohmann::ordered_json result = response_assertion_plan (20, { "error" });
        const nlohmann::ordered_json& config =
        first_request (result.at ("collections").at (0)).at ("elements").at (0).at ("config");
        EXPECT_EQ (config.at ("negate").get<bool> (), true);
        EXPECT_EQ (config.at ("mode").get<std::string> (), "contains");
    }
    {
        const nlohmann::ordered_json result = response_assertion_plan (12, { "error" });
        const nlohmann::ordered_json& config =
        first_request (result.at ("collections").at (0)).at ("elements").at (0).at ("config");
        EXPECT_EQ (config.at ("negate").get<bool> (), true);
        EXPECT_EQ (config.at ("mode").get<std::string> (), "equals");
    }
    {
        const nlohmann::ordered_json result =
        response_assertion_plan (1, { R"(id":\s*\d+)" });
        const nlohmann::ordered_json& config =
        first_request (result.at ("collections").at (0)).at ("elements").at (0).at ("config");
        EXPECT_EQ (config.at ("mode").get<std::string> (), "matches");
        EXPECT_EQ (config.at ("text").get<std::string> (), "id\":\\s*\\d+");
    }
}

/**
 * The `Or` bit (32) means "any of these patterns passes"; with more than one
 * pattern this parser has no Vayu kind that expresses that, so it refuses the
 * assertion and tallies `ResponseAssertion_or` rather than emitting ANDed
 * rows that would mean something else (issue #1660). A single pattern with
 * Or set is unaffected - the existing `test_type: 2` shape still holds.
 */
TEST (JmeterImport, ResponseAssertionOrWithMultiplePatternsIsTalliedNotAnded) {
    const nlohmann::ordered_json or_result =
    response_assertion_plan (34, { "foo", "bar" });
    EXPECT_FALSE (first_request (or_result.at ("collections").at (0)).contains ("elements"));
    EXPECT_TRUE (has_skipped_kind (or_result.at ("meta"), "ResponseAssertion_or"));

    const nlohmann::ordered_json single_result = response_assertion_plan (2, { "foo" });
    const nlohmann::ordered_json& config =
    first_request (single_result.at ("collections").at (0))
    .at ("elements")
    .at (0)
    .at ("config");
    EXPECT_EQ (config.at ("field").get<std::string> (), "body");
    EXPECT_EQ (config.at ("mode").get<std::string> (), "matches");
    EXPECT_EQ (config.at ("negate").get<bool> (), false);
}

/**
 * JMeter's patterns are Java's; one outside RE2's dialect (lookaround, a
 * backreference) is dropped and tallied `<kind>_unmappable` (#3043) rather
 * than imported as an element that could only ever report `error`. Mutation
 * check: drop `assert.contains`' or `extract.regex`'s `validate_config` and
 * its element is imported.
 */
TEST (JmeterImport, AJavaOnlyPatternIsTalliedUnmappableRatherThanImported) {
    const nlohmann::ordered_json lookahead = response_assertion_plan (2, { "id(?=:)" });
    EXPECT_FALSE (first_request (lookahead.at ("collections").at (0)).contains ("elements"));
    EXPECT_TRUE (has_skipped_kind (lookahead.at ("meta"), "assert.contains_unmappable"));

    const char* plan         = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Page">
      <stringProp name="HTTPSampler.path">/page</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree>
      <RegexExtractor testname="Repeated word">
        <stringProp name="RegexExtractor.refname">word</stringProp>
        <stringProp name="RegexExtractor.regex">(\w+) \1</stringProp>
      </RegexExtractor>
      <hashTree/>
    </hashTree>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    EXPECT_FALSE (
    first_request (parsed.result.at ("collections").at (0)).contains ("elements"));
    EXPECT_TRUE (has_skipped_kind (parsed.result.at ("meta"), "extract.regex_unmappable"));
}

/**
 * A Substring assertion on an empty string finds it in every response, so the
 * `assert.contains` it would become is refused (#3055) and tallied
 * `assert.contains_unmappable`; the same empty string under Equals or Matches
 * is a judgement and is kept. Mutation check: drop `assert_contains_problem`'s
 * empty-text rule and the Substring plan imports the element.
 */
TEST (JmeterImport, AnEmptySubstringAssertionIsTalliedUnmappable) {
    const nlohmann::ordered_json substring = response_assertion_plan (16, { "" });
    EXPECT_FALSE (first_request (substring.at ("collections").at (0)).contains ("elements"));
    EXPECT_TRUE (has_skipped_kind (substring.at ("meta"), "assert.contains_unmappable"));

    for (const long equals_or_matches : { 8L, 1L }) {
        const nlohmann::ordered_json kept =
        response_assertion_plan (equals_or_matches, { "" });
        EXPECT_TRUE (first_request (kept.at ("collections").at (0)).contains ("elements"))
        << equals_or_matches;
        EXPECT_FALSE (has_skipped_kind (kept.at ("meta"), "assert.contains_unmappable"))
        << equals_or_matches;
    }
}

/// `HTTPsampler.Files` (`HTTPFileArgs`/`HTTPFileArg`) is nested inside the
/// sampler tag itself rather than a sibling tag the generic fallback would
/// tally on its own, so a file-only upload builds a `form-data` body row per
/// file (issue #1657) instead of being silently dropped, and is no longer
/// reported in `meta.skipped`. Mutation check: reverting `apply_sampler_arguments`
/// to the pre-#1657 stopgap makes `body.mode` stay `"none"` and reddens the
/// `has_skipped_kind` assertion the other way.
TEST (JmeterImport, FileOnlyUploadBuildsAFormDataBodyRow) {
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
    EXPECT_FALSE (has_skipped_kind (parsed.result.at ("meta"), "HTTPsampler.Files"));

    const nlohmann::ordered_json& body =
    first_request (parsed.result.at ("collections").at (0)).at ("body");
    EXPECT_EQ (body.at ("mode").get<std::string> (), "form-data");
    ASSERT_EQ (body.at ("fields").size (), 1u);
    const nlohmann::ordered_json& field = body.at ("fields").at (0);
    EXPECT_EQ (field.at ("key").get<std::string> (), "file");
    EXPECT_EQ (field.at ("type").get<std::string> (), "file");
    EXPECT_EQ (field.at ("src").get<std::string> (), "/tmp/a.png");
    EXPECT_EQ (field.at ("fileName").get<std::string> (), "a.png");
    EXPECT_EQ (field.at ("contentType").get<std::string> (), "image/png");
    EXPECT_FALSE (field.contains ("unresolved")) << "the parse states no trust";
}

/// A sampler mixing `HTTPsampler.Files` with regular `HTTPsampler.Arguments`
/// folds both into the same `form-data` body rather than the arguments going
/// to query `params` the way they would with no file parts present.
TEST (JmeterImport, FileAndArgumentMixFoldsIntoOneFormDataBody) {
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
      <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          <elementProp name="caption" elementType="HTTPArgument">
            <stringProp name="Argument.name">caption</stringProp>
            <stringProp name="Argument.value">hello</stringProp>
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
    const nlohmann::ordered_json& request =
    first_request (parsed.result.at ("collections").at (0));
    EXPECT_TRUE (request.at ("params").empty ());
    const nlohmann::ordered_json& body = request.at ("body");
    EXPECT_EQ (body.at ("mode").get<std::string> (), "form-data");
    ASSERT_EQ (body.at ("fields").size (), 2u);
    EXPECT_EQ (body.at ("fields").at (0).at ("type").get<std::string> (), "file");
    EXPECT_EQ (body.at ("fields").at (1).at ("key").get<std::string> (), "caption");
    EXPECT_EQ (body.at ("fields").at (1).at ("value").get<std::string> (), "hello");
    EXPECT_FALSE (body.at ("fields").at (1).contains ("type"));
}

/// One sampler on @p method, with @p extra_props (raw `<boolProp>` lines) and
/// two arguments, `a=1` and `b=two words`, imported on its own.
nlohmann::ordered_json import_sampler_with_arguments (const std::string& method,
const std::string& extra_props = "") {
    const std::string plan = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <HTTPSamplerProxy testname="Submit">
      <stringProp name="HTTPSampler.domain">example.com</stringProp>
      <stringProp name="HTTPSampler.protocol">https</stringProp>
      <stringProp name="HTTPSampler.path">/submit</stringProp>
      <stringProp name="HTTPSampler.method">)jmx" +
    method + "</stringProp>\n" + extra_props + R"jmx(
      <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          <elementProp name="a" elementType="HTTPArgument">
            <stringProp name="Argument.name">a</stringProp>
            <stringProp name="Argument.value">1</stringProp>
          </elementProp>
          <elementProp name="b" elementType="HTTPArgument">
            <stringProp name="Argument.name">b</stringProp>
            <stringProp name="Argument.value">two words</stringProp>
          </elementProp>
        </collectionProp>
      </elementProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return first_request (parsed.result.at ("collections").at (0));
}

/// JMeter sends a POST's arguments as the form body, not the query (#3191).
/// Before, they were `params` rows and so joined into the URL.
TEST (JmeterImport, APostsArgumentsAreAFormBodyAndNotAQuery) {
    for (const char* method : { "POST", "PUT", "PATCH", " post " }) {
        const nlohmann::ordered_json request = import_sampler_with_arguments (method);
        EXPECT_EQ (request.at ("url"), "https://example.com/submit") << method;
        EXPECT_TRUE (request.at ("params").empty ()) << method;
        const nlohmann::ordered_json& body = request.at ("body");
        EXPECT_EQ (body.at ("mode"), "x-www-form-urlencoded") << method;
        ASSERT_EQ (body.at ("fields").size (), 2u) << method;
        const nlohmann::ordered_json& second = body.at ("fields").at (1);
        EXPECT_EQ (body.at ("fields").at (0).at ("key"), "a");
        EXPECT_EQ (body.at ("fields").at (0).at ("value"), "1");
        EXPECT_EQ (second.at ("key"), "b");
        EXPECT_EQ (second.at ("value"), "two words");
        EXPECT_TRUE (second.at ("enabled").get<bool> ());
    }
}

/// The methods JMeter sends no body for keep the arguments in the query,
/// whatever the case the plan spelled the method in.
TEST (JmeterImport, ArgumentsOfAMethodWithNoBodyStayInTheQuery) {
    for (const char* method : { "GET", "DELETE", "HEAD", "OPTIONS", "delete", " get " }) {
        const nlohmann::ordered_json request = import_sampler_with_arguments (method);
        EXPECT_EQ (request.at ("url"), "https://example.com/submit?a=1&b=two%20words")
        << method;
        EXPECT_EQ (request.at ("params").size (), 2u) << method;
        EXPECT_EQ (request.at ("body").at ("mode"), "none") << method;
    }
}

/// `HTTPSampler.DO_MULTIPART_POST` picks multipart for a body method, and
/// means nothing for one with no body.
TEST (JmeterImport, DoMultipartPostMakesTheArgumentsAFormDataBody) {
    const char* flag = R"(<boolProp name="HTTPSampler.DO_MULTIPART_POST">true</boolProp>)";
    const nlohmann::ordered_json post = import_sampler_with_arguments ("POST", flag);
    EXPECT_EQ (post.at ("body").at ("mode"), "form-data");
    EXPECT_EQ (post.at ("body").at ("fields").size (), 2u);
    EXPECT_TRUE (post.at ("params").empty ());
    EXPECT_EQ (post.at ("url"), "https://example.com/submit");

    const nlohmann::ordered_json get = import_sampler_with_arguments ("GET", flag);
    EXPECT_EQ (get.at ("body").at ("mode"), "none");
    EXPECT_EQ (get.at ("params").size (), 2u);
}

/// A raw body still wins over the method, as it did before.
TEST (JmeterImport, ARawPostBodyStillWinsOverTheFormBody) {
    const char* raw = R"(<boolProp name="HTTPSampler.postBodyRaw">true</boolProp>)";
    const nlohmann::ordered_json request =
    import_sampler_with_arguments ("POST", raw);
    EXPECT_EQ (request.at ("body").at ("mode"), "text");
    EXPECT_EQ (request.at ("body").at ("content"), "1");
    EXPECT_TRUE (request.at ("params").empty ());
}

/// A plan whose HTTP Request Defaults carry @p defaults_props (raw
/// `<stringProp>` lines) above one sampler that names no domain of its own.
nlohmann::ordered_json import_with_http_defaults (const std::string& defaults_props) {
    const std::string plan = R"jmx(<?xml version="1.0"?>
<jmeterTestPlan version="1.2"><hashTree>
  <TestPlan testname="Plan"/><hashTree>
    <ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="Defaults">
)jmx" +
    defaults_props + R"jmx(
    </ConfigTestElement>
    <hashTree/>
    <HTTPSamplerProxy testname="List">
      <stringProp name="HTTPSampler.path">/items</stringProp>
      <stringProp name="HTTPSampler.method">GET</stringProp>
    </HTTPSamplerProxy>
    <hashTree/>
  </hashTree>
</hashTree></jmeterTestPlan>
)jmx";
    const ImportParse parsed = parse_import (plan, {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result;
}

/// HTTP Request Defaults name their host through variables as often as not;
/// the `baseUrl` it becomes is rewritten like a sampler's own URL, not left
/// as a literal `${host}` (#3191).
TEST (JmeterImport, HttpDefaultsRewriteVariableReferencesInTheBaseUrl) {
    const nlohmann::ordered_json result      = import_with_http_defaults (R"(
      <stringProp name="HTTPSampler.domain">${host}</stringProp>
      <stringProp name="HTTPSampler.protocol">https</stringProp>
      <stringProp name="HTTPSampler.port">${port}</stringProp>)");
    const nlohmann::ordered_json& collection = result.at ("collections").at (0);
    EXPECT_EQ (collection.at ("variables").at ("baseUrl").at ("value"),
    "https://{{host}}:{{port}}");
    EXPECT_EQ (first_request (collection).at ("url"), "{{baseUrl}}/items");
}

/// The scheme of a defaults element falls back to `http` like a sampler's.
TEST (JmeterImport, HttpDefaultsWithAnEmptyProtocolUseHttp) {
    const nlohmann::ordered_json result = import_with_http_defaults (R"(
      <stringProp name="HTTPSampler.domain">api.example.com</stringProp>
      <stringProp name="HTTPSampler.protocol"></stringProp>
      <stringProp name="HTTPSampler.port">8080</stringProp>)");
    EXPECT_EQ (result.at ("collections").at (0).at ("variables").at ("baseUrl").at ("value"),
    "http://api.example.com:8080");
}

namespace {

/// The `<stringProp>` lines of a connect and a response timeout; an empty
/// argument leaves its property out.
std::string timeout_props (const std::string& connect, const std::string& response) {
    std::string props;
    if (!connect.empty ()) {
        props += R"(<stringProp name="HTTPSampler.connect_timeout">)" + connect + "</stringProp>";
    }
    if (!response.empty ()) {
        props += R"(<stringProp name="HTTPSampler.response_timeout">)" + response + "</stringProp>";
    }
    return props;
}

/// A sampler named @p name carrying @p props, with an empty tree.
std::string sampler_xml (const std::string& name, const std::string& props = "") {
    return R"(<HTTPSamplerProxy testname=")" + name +
    R"("><stringProp name="HTTPSampler.domain">example.com</stringProp>)" +
    props + "</HTTPSamplerProxy><hashTree/>";
}

/// An HTTP Request Defaults element carrying @p props (it names no domain, so
/// `baseUrl` stays out of the way).
std::string defaults_xml (const std::string& props, const char* enabled = "true") {
    return R"(<ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="Defaults" enabled=")" +
    std::string (enabled) + R"(">)" + props + "</ConfigTestElement><hashTree/>";
}

/// A `LoopController` folder named @p name holding @p members.
std::string folder_xml (const std::string& name, const std::string& members) {
    return R"(<LoopController testname=")" + name + R"("/><hashTree>)" + members + "</hashTree>";
}

/// @p members imported as the children of the plan's `TestPlan`.
nlohmann::ordered_json import_plan (const std::string& members) {
    const std::string plan =
    R"(<?xml version="1.0"?><jmeterTestPlan version="1.2"><hashTree><TestPlan testname="Plan"/><hashTree>)" +
    members + "</hashTree></hashTree></jmeterTestPlan>";
    const ImportParse parsed = parse_import (plan, {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result;
}

/// The request called @p name anywhere under @p node (a collection or folder),
/// null when there is none.
nlohmann::ordered_json
request_named (const nlohmann::ordered_json& node, const std::string& name) {
    for (const nlohmann::ordered_json& request : node.at ("requests")) {
        if (request.at ("name") == name) {
            return request;
        }
    }
    for (const nlohmann::ordered_json& folder : node.at ("children")) {
        if (nlohmann::ordered_json found = request_named (folder, name); !found.is_null ()) {
            return found;
        }
    }
    return nullptr;
}

/// The request @p name of an imported plan; fails the test when it is missing.
nlohmann::ordered_json imported_request (const nlohmann::ordered_json& result,
const std::string& name) {
    nlohmann::ordered_json request =
    request_named (result.at ("collections").at (0), name);
    EXPECT_FALSE (request.is_null ()) << "no request " << name;
    return request;
}

/// The `timeout` of the request @p name, -1 when it carries none.
long long timeout_of (const nlohmann::ordered_json& result, const std::string& name) {
    const nlohmann::ordered_json request = imported_request (result, name);
    return request.contains ("timeout") ? request.at ("timeout").get<long long> () : -1;
}

/// The names the import attached to @p kind, in the order given.
std::vector<std::string>
skipped_names (const nlohmann::ordered_json& meta, const std::string& kind) {
    for (const nlohmann::ordered_json& item : meta.at ("skipped")) {
        if (item.at ("kind") == kind && item.contains ("names")) {
            return item.at ("names").get<std::vector<std::string>> ();
        }
    }
    return {};
}

} // namespace

/// Vayu has one total timeout, so a sampler's connect and response timeouts
/// are added; the request is named so the sum is not a surprise (#3217).
TEST (JmeterImport, ASamplerWithBothTimeoutsGetsTheirSumAndIsNamedInANotice) {
    const nlohmann::ordered_json result =
    import_plan (sampler_xml ("Both", timeout_props ("2000", "5000")));
    EXPECT_EQ (timeout_of (result, "Both"), 7000);
    const nlohmann::ordered_json& meta = result.at ("meta");
    EXPECT_EQ (skipped_count (meta, "Timeout_total"), 1);
    EXPECT_EQ (skipped_names (meta, "Timeout_total"), (std::vector<std::string>{ "Both" }));
}

/// A comma in the name would read as two requests where the app joins `names`.
TEST (JmeterImport, TheTimeoutNoticeNamesARequestWithoutCommas) {
    const nlohmann::ordered_json result =
    import_plan (sampler_xml ("Get a, b", timeout_props ("1", "1")));
    EXPECT_EQ (skipped_names (result.at ("meta"), "Timeout_total"),
    (std::vector<std::string>{ "Get a  b" }));
}

TEST (JmeterImport, ASamplerWithOneTimeoutKeepsThatValueAndRaisesNoNotice) {
    const nlohmann::ordered_json result =
    import_plan (sampler_xml ("Connect", timeout_props ("3000", "")) +
    sampler_xml ("Response", timeout_props ("", "4000")));
    EXPECT_EQ (timeout_of (result, "Connect"), 3000);
    EXPECT_EQ (timeout_of (result, "Response"), 4000);
    EXPECT_FALSE (has_skipped_kind (result.at ("meta"), "Timeout_total"));
}

/// Blank and `0` are JMeter's "none": no key, so the request keeps the
/// `defaultTimeout` setting, never a `0` that would mean something else.
TEST (JmeterImport, BlankAndZeroTimeoutsStampNoTimeout) {
    const nlohmann::ordered_json result = import_plan (sampler_xml ("None") +
    sampler_xml ("Zero", timeout_props ("0", "0")) +
    sampler_xml ("Blank", timeout_props (" ", " ")));
    for (const char* name : { "None", "Zero", "Blank" }) {
        EXPECT_EQ (timeout_of (result, name), -1) << name;
    }
    EXPECT_FALSE (has_skipped_kind (result.at ("meta"), "Timeout_total"));
    EXPECT_FALSE (has_skipped_kind (result.at ("meta"), "HTTPSampler_timeout_unrecognised"));
}

/// A `${var}` has no number to read: that part is left out and counted, once
/// per request, while the other part still applies.
TEST (JmeterImport, ATimeoutThatIsNotANumberIsOmittedAndTallied) {
    const nlohmann::ordered_json result =
    import_plan (sampler_xml ("Half", timeout_props ("${t}", "5000")) +
    sampler_xml ("Neither", timeout_props ("${t}", "-5")));
    EXPECT_EQ (timeout_of (result, "Half"), 5000);
    EXPECT_EQ (timeout_of (result, "Neither"), -1);
    const nlohmann::ordered_json& meta = result.at ("meta");
    EXPECT_EQ (skipped_count (meta, "HTTPSampler_timeout_unrecognised"), 2);
    EXPECT_FALSE (has_skipped_kind (meta, "Timeout_total"));
}

/// The stored `timeout` is bounded to a day; a value past what a number holds
/// is unreadable rather than wrapped.
TEST (JmeterImport, TheTimeoutIsClampedToTheStoredRange) {
    const nlohmann::ordered_json result =
    import_plan (sampler_xml ("Sum", timeout_props ("86400000", "86400000")) +
    sampler_xml ("Huge", timeout_props ("99999999999999999999", "")));
    EXPECT_EQ (timeout_of (result, "Sum"), 86400000);
    EXPECT_EQ (timeout_of (result, "Huge"), -1);
    EXPECT_EQ (skipped_count (result.at ("meta"), "HTTPSampler_timeout_unrecognised"), 1);
}

/// JMeter's defaults cover the samplers at their level and below, wherever the
/// element sits among them: a sampler ahead of it, one after it, one in a
/// nested folder - and none beside the folder.
TEST (JmeterImport, DefaultsTimeoutsReachTheSamplersInScopeInAnyDocumentOrder) {
    const nlohmann::ordered_json result = import_plan (
    folder_xml ("Scoped",
    sampler_xml ("Before") + defaults_xml (timeout_props ("2000", "5000")) +
    sampler_xml ("After") + folder_xml ("Nested", sampler_xml ("Deep"))) +
    folder_xml ("Outside", sampler_xml ("Beside")) + sampler_xml ("Top"));
    for (const char* name : { "Before", "After", "Deep" }) {
        EXPECT_EQ (timeout_of (result, name), 7000) << name;
    }
    for (const char* name : { "Beside", "Top" }) {
        EXPECT_EQ (timeout_of (result, name), -1) << name;
    }
    const nlohmann::ordered_json& meta = result.at ("meta");
    EXPECT_EQ (skipped_count (meta, "Timeout_total"), 3);
    EXPECT_EQ (skipped_names (meta, "Timeout_total"),
    (std::vector<std::string>{ "Before", "After", "Deep" }));
}

/// A defaults element in the `TestPlan`'s tree covers its thread groups, and
/// one inside a thread group covers that group alone, though both groups
/// flatten into the same collection.
TEST (JmeterImport, DefaultsScopeFollowsTheThreadGroupTheyAreIn) {
    const nlohmann::ordered_json result = import_plan (
    defaults_xml (timeout_props ("", "1000")) + R"(<ThreadGroup testname="A"/><hashTree>)" +
    defaults_xml (timeout_props ("", "2000")) + sampler_xml ("InA") + "</hashTree>" +
    R"(<ThreadGroup testname="B"/><hashTree>)" + sampler_xml ("InB") + "</hashTree>");
    EXPECT_EQ (timeout_of (result, "InA"), 2000);
    EXPECT_EQ (timeout_of (result, "InB"), 1000);
}

/// The nearest defaults win per field, so an inner element that sets only the
/// connect timeout still inherits the outer response timeout; among defaults at
/// one level the later sibling wins, as in JMeter.
TEST (JmeterImport, NearerDefaultsOverrideOuterOnesPerField) {
    const nlohmann::ordered_json result =
    import_plan (defaults_xml (timeout_props ("1000", "2000")) +
    folder_xml ("Inner", defaults_xml (timeout_props ("300", "")) + sampler_xml ("InInner")) +
    folder_xml ("Siblings",
    defaults_xml (timeout_props ("10", "20")) +
    defaults_xml (timeout_props ("", "40")) + sampler_xml ("InSiblings")) +
    sampler_xml ("InOuter"));
    EXPECT_EQ (timeout_of (result, "InInner"), 2300);
    EXPECT_EQ (timeout_of (result, "InSiblings"), 50);
    EXPECT_EQ (timeout_of (result, "InOuter"), 3000);
}

/// A sampler's own timeout beats the defaults' for that field alone; its own
/// `0` is a stated "none", not an absent value.
TEST (JmeterImport, ASamplersOwnTimeoutBeatsTheDefaultsPerField) {
    const nlohmann::ordered_json result =
    import_plan (defaults_xml (timeout_props ("1000", "2000")) +
    sampler_xml ("OwnConnect", timeout_props ("500", "")) +
    sampler_xml ("OwnNone", timeout_props ("", "0")) + sampler_xml ("Inherits"));
    EXPECT_EQ (timeout_of (result, "OwnConnect"), 2500);
    EXPECT_EQ (timeout_of (result, "OwnNone"), 1000);
    EXPECT_EQ (timeout_of (result, "Inherits"), 3000);
}

/// A disabled element covers nothing, and is counted once - the pre-pass that
/// finds defaults ahead of the walk must not tally it a second time.
TEST (JmeterImport, ADisabledDefaultsElementCoversNothingAndIsCountedOnce) {
    const nlohmann::ordered_json result = import_plan (
    defaults_xml (timeout_props ("", "1000"), "false") + sampler_xml ("Plain"));
    EXPECT_EQ (timeout_of (result, "Plain"), -1);
    EXPECT_EQ (skipped_count (result.at ("meta"), "ConfigTestElement_disabled"), 1);
}

/// JMeter uses a default path only for a sampler whose own is empty; a path of
/// its own replaces it, and it is no prefix. Outside the defaults' scope it
/// does not apply.
TEST (JmeterImport, ADefaultsPathFillsAnEmptySamplerPathOnly) {
    const std::string path = R"(<stringProp name="HTTPSampler.path">)";
    const nlohmann::ordered_json result = import_plan (
    folder_xml ("Scoped",
    sampler_xml ("Empty", path + "</stringProp>") + defaults_xml (path + "/v2</stringProp>") +
    sampler_xml ("Absent") + sampler_xml ("Blank", path + "  </stringProp>") +
    sampler_xml ("Own", path + "/items</stringProp>")) +
    sampler_xml ("Outside"));
    for (const char* name : { "Empty", "Absent", "Blank" }) {
        EXPECT_EQ (imported_request (result, name).at ("url"), "http://example.com/v2")
        << name;
    }
    EXPECT_EQ (imported_request (result, "Own").at ("url"), "http://example.com/items");
    EXPECT_EQ (imported_request (result, "Outside").at ("url"), "http://example.com");
}

/// A default path with a variable in it is rewritten like a sampler's own.
TEST (JmeterImport, ADefaultsPathVariableIsRewritten) {
    const nlohmann::ordered_json result = import_plan (
    defaults_xml (R"(<stringProp name="HTTPSampler.path">/${version}/items</stringProp>)") +
    sampler_xml ("Versioned"));
    EXPECT_EQ (imported_request (result, "Versioned").at ("url"),
    "http://example.com/{{version}}/items");
}

/// A `HTTPFileArg` with no `File.paramname` names nothing a `form-data` field
/// could key on - tallied rather than imported as a nameless row, the same
/// "nothing dropped quietly" rule the sibling-tag fallback follows.
TEST (JmeterImport, FileArgWithNoParamNameIsTalliedNotImported) {
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
            <stringProp name="File.paramname"></stringProp>
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
    EXPECT_EQ (first_request (parsed.result.at ("collections").at (0))
               .at ("body")
               .at ("mode")
               .get<std::string> (),
    "none");
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

namespace {

/// A plan whose single request sits under @p levels nested LoopControllers.
std::string plan_nested_under (size_t levels) {
    std::string open;
    std::string close;
    for (size_t i = 0; i < levels; ++i) {
        open += "<LoopController testname=\"L\"/><hashTree>";
        close += "</hashTree>";
    }
    return std::string (R"(<?xml version="1.0"?><jmeterTestPlan jmeter="5.6.3"><hashTree>)") +
    "<TestPlan testname=\"P\"/><hashTree>" + open +
    R"(<HTTPSamplerProxy testname="Deep"><stringProp name="HTTPSampler.domain">example.com</stringProp>)"
    R"(<stringProp name="HTTPSampler.path">/deep</stringProp></HTTPSamplerProxy><hashTree/>)" +
    close + "</hashTree></hashTree></jmeterTestPlan>";
}

} // namespace

TEST (JmeterImport, ANestPastTheDepthBoundIsTalliedAndTheFileStillImports) {
    // Far past the bound: an unbounded walk would overflow the stack here.
    const ImportParse parsed = parse_import (plan_nested_under (10000), {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& meta = parsed.result.at ("meta");
    EXPECT_TRUE (has_skipped_kind (meta, "nesting_too_deep"));
    EXPECT_EQ (meta.at ("requestCount"), 0);
}

TEST (JmeterImport, ANestWithinTheDepthBoundImportsWithoutATally) {
    const ImportParse parsed = parse_import (plan_nested_under (10), {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& meta = parsed.result.at ("meta");
    EXPECT_FALSE (has_skipped_kind (meta, "nesting_too_deep"));
    EXPECT_EQ (meta.at ("requestCount"), 1);
}

namespace {

/// A sampler named @p name, nothing else.
std::string sampler (const std::string& name, const char* enabled = "true") {
    return "<HTTPSamplerProxy testname=\"" + name + "\" enabled=\"" + enabled +
    "\"><stringProp name=\"HTTPSampler.path\">/" + name +
    "</stringProp></HTTPSamplerProxy><hashTree/>";
}

/// A controller named @p name holding @p members.
std::string controller (const char* tag, const std::string& name, const std::string& members) {
    return std::string ("<") + tag + " testname=\"" + name + "\"/><hashTree>" +
    members + "</hashTree>";
}

std::string plan_with (const std::string& body) {
    return R"(<?xml version="1.0"?><jmeterTestPlan jmeter="5.6.3"><hashTree>)"
           R"(<TestPlan testname="P"/><hashTree>)" +
    body + "</hashTree></hashTree></jmeterTestPlan>";
}

/// @p list's names in the order their drafts state, each written
/// `<name>=<order>`, so a failed comparison reads like the tree it describes.
std::vector<std::string> stated_orders (const nlohmann::ordered_json& list) {
    std::vector<std::string> stated;
    for (const nlohmann::ordered_json& draft : list) {
        stated.push_back (draft.at ("name").get<std::string> () + "=" +
        std::to_string (draft.at ("order").get<int> ()));
    }
    return stated;
}

} // namespace

// A plan's samplers and controllers are one sibling list in document order
// (#2573), so each draft states its position in it: one counter per parent
// across both kinds, shared by every ThreadGroup under it, burned by neither a
// disabled element nor a setup group. Mutation check: stop stamping `order` in
// `Sink` and this reds.
TEST (JmeterImport, SamplersAndControllersShareOneOrderPerParent) {
    const std::string plan =
    plan_with ("<ThreadGroup testname=\"G1\"/><hashTree>" + sampler ("A") +
    controller ("LoopController", "Loop",
    sampler ("X") + controller ("TransactionController", "Inner", sampler ("Y")) +
    sampler ("Z")) +
    sampler ("Off", "false") + "<SetupThreadGroup testname=\"Setup\"/><hashTree/>" +
    sampler ("B") + "</hashTree>" + "<ThreadGroup testname=\"G2\"/><hashTree>" +
    sampler ("C") + "</hashTree>");
    const ImportParse parsed = parse_import (plan, {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const nlohmann::ordered_json& root = parsed.result.at ("collections").at (0);
    EXPECT_EQ (stated_orders (root.at ("requests")),
    (std::vector<std::string>{ "A=0", "B=2", "C=3" }));
    EXPECT_EQ (stated_orders (root.at ("children")), (std::vector<std::string>{ "Loop=1" }));

    const nlohmann::ordered_json& loop = root.at ("children").at (0);
    EXPECT_EQ (stated_orders (loop.at ("requests")),
    (std::vector<std::string>{ "X=0", "Z=2" }));
    EXPECT_EQ (stated_orders (loop.at ("children")),
    (std::vector<std::string>{ "Inner=1" }));
    EXPECT_EQ (stated_orders (loop.at ("children").at (0).at ("requests")),
    (std::vector<std::string>{ "Y=0" }));
}

// Folders only: every controller states its place, in document order, so the
// listing is the one a plan without samplers always had.
TEST (JmeterImport, ControllersAloneAreNumberedInDocumentOrder) {
    const ImportParse parsed = parse_import (
    plan_with (controller ("LoopController", "B", "") + controller ("IfController", "A", "")),
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& root = parsed.result.at ("collections").at (0);
    EXPECT_EQ (stated_orders (root.at ("children")),
    (std::vector<std::string>{ "B=0", "A=1" }));
    EXPECT_TRUE (root.at ("requests").empty ());
}

// A Simple Controller only groups, so its members import in source order
// inside one folder and nothing is reported as lost (#3190). Mutation check:
// drop `GenericController` from `is_folder_controller` and the folder, its
// members and the count all go red, the controller falling back to a bare-tag
// tally that drops every sampler inside it.
TEST (JmeterImport, ASimpleControllerImportsItsMembersInOrderInsideAFolder) {
    const ImportParse parsed = parse_import (
    plan_with (sampler ("Before") +
    controller ("GenericController", "Group", sampler ("First") + sampler ("Second")) +
    sampler ("After")),
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const nlohmann::ordered_json& root = parsed.result.at ("collections").at (0);
    ASSERT_EQ (root.at ("children").size (), 1);
    const nlohmann::ordered_json& folder = root.at ("children").at (0);
    EXPECT_EQ (folder.at ("name"), "Group");
    EXPECT_EQ (stated_orders (folder.at ("requests")),
    (std::vector<std::string>{ "First=0", "Second=1" }));
    EXPECT_FALSE (folder.contains ("elements"));

    const nlohmann::ordered_json& meta = parsed.result.at ("meta");
    EXPECT_EQ (meta.at ("requestCount"), 4);
    EXPECT_EQ (meta.at ("folderCount"), 1);
    EXPECT_TRUE (meta.at ("skipped").empty ()) << meta.at ("skipped").dump ();
}

// Every controller with no element-kind equivalent for its looping or
// selection semantic keeps its members as a folder and tallies one notice kind
// per tag, counting each controller (#3190). Mutation check: remove a tag from
// `is_folder_controller` and its members vanish into the bare-tag tally,
// failing the request count and the `_unrecognised` count together.
TEST (JmeterImport, AnUnmappedControllerKeepsItsMembersAndTalliesOneNotice) {
    const std::vector<std::string> tags = { "WhileController", "ForeachController",
        "RandomController", "InterleaveControl", "RandomOrderController", "RunTime",
        "CriticalSectionController", "ModuleController", "IncludeController" };
    for (const std::string& tag : tags) {
        const ImportParse parsed = parse_import (
        plan_with (controller (tag.c_str (), "One", sampler ("A") + sampler ("B")) +
        controller (tag.c_str (), "Two", sampler ("C"))),
        {}, {});
        ASSERT_TRUE (parsed.ok ()) << tag << ": " << parsed.error;

        const nlohmann::ordered_json& root = parsed.result.at ("collections").at (0);
        const nlohmann::ordered_json& meta = parsed.result.at ("meta");
        ASSERT_EQ (root.at ("children").size (), 2) << tag;
        EXPECT_EQ (stated_orders (root.at ("children").at (0).at ("requests")),
        (std::vector<std::string>{ "A=0", "B=1" }))
        << tag;
        EXPECT_EQ (meta.at ("requestCount"), 3) << tag;
        EXPECT_EQ (meta.at ("folderCount"), 2) << tag;
        EXPECT_EQ (skipped_count (meta, tag + "_unrecognised"), 2) << tag;
        EXPECT_FALSE (has_skipped_kind (meta, tag)) << tag << " tallied as dropped";
    }
}

// A controller nested in an unmapped one keeps source order at both levels.
TEST (JmeterImport, AnUnmappedControllerNestsAndKeepsSourceOrder) {
    const ImportParse parsed = parse_import (
    plan_with (controller ("WhileController", "Outer",
    sampler ("X") + controller ("GenericController", "Inner", sampler ("Y")) + sampler ("Z"))),
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;

    const nlohmann::ordered_json& outer =
    parsed.result.at ("collections").at (0).at ("children").at (0);
    EXPECT_EQ (stated_orders (outer.at ("requests")),
    (std::vector<std::string>{ "X=0", "Z=2" }));
    EXPECT_EQ (stated_orders (outer.at ("children")),
    (std::vector<std::string>{ "Inner=1" }));
    EXPECT_EQ (outer.at ("children").at (0).at ("requests").at (0).at ("name"), "Y");
}

namespace {

/// A plan with one Throughput Controller holding one sampler, its percent
/// written as @p percent_props (the controller's own property children).
nlohmann::ordered_json throughput_plan (const std::string& percent_props) {
    const std::string plan =
    plan_with ("<ThroughputController testname=\"Gate\">" + percent_props +
    "</ThroughputController><hashTree>" + sampler ("Gated") + "</hashTree>");
    const ImportParse parsed = parse_import (plan, {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result;
}

/// The nested form JMeter's GUI saves for the percent.
std::string float_percent (const char* value) {
    return std::string (
           "<FloatProperty><name>ThroughputController.percentThroughput</name>"
           "<value>") +
    value + "</value><savedValue>0.0</savedValue></FloatProperty>";
}

} // namespace

// The percent JMeter saves as a nested `FloatProperty` is read, not defaulted
// to 100 (#3190). Mutation check: drop the nested read from
// `scalar_text` and the 25 reads 100.
TEST (JmeterImport, AThroughputControllerReadsItsNestedFloatPercent) {
    const nlohmann::ordered_json result = throughput_plan (
    R"(<intProp name="ThroughputController.style">1</intProp>)" + float_percent ("25.0"));
    const nlohmann::ordered_json& folder =
    result.at ("collections").at (0).at ("children").at (0);
    ASSERT_TRUE (folder.contains ("elements"));
    EXPECT_EQ (folder.at ("elements").at (0).at ("kind"), "control.throughput");
    EXPECT_EQ (folder.at ("elements").at (0).at ("config").at ("percent"), 25.0);
    EXPECT_FALSE (has_skipped_kind (result.at ("meta"), "ThroughputController_unrecognised"));
}

TEST (JmeterImport, AThroughputControllerStillReadsAFlatStringPercent) {
    const nlohmann::ordered_json result = throughput_plan (
    R"(<stringProp name="ThroughputController.percentThroughput">40</stringProp>)");
    const nlohmann::ordered_json& folder =
    result.at ("collections").at (0).at ("children").at (0);
    EXPECT_EQ (folder.at ("elements").at (0).at ("config").at ("percent"), 40.0);
}

// Style 0 caps a number of executions, which `control.throughput` cannot
// express: the members still import, no percent is invented, and one notice
// says so (#3190). Mutation check: drop the style test from
// `parse_throughput_controller` and the folder gains a `control.throughput`.
TEST (JmeterImport, ATotalExecutionsThroughputControllerIsTalliedNotImportedAsAPercent) {
    const nlohmann::ordered_json result =
    throughput_plan (R"(<intProp name="ThroughputController.style">0</intProp>)"
                     R"(<intProp name="ThroughputController.maxThroughput">5</intProp>)" +
    float_percent ("100.0"));
    const nlohmann::ordered_json& folder =
    result.at ("collections").at (0).at ("children").at (0);
    EXPECT_FALSE (folder.contains ("elements"));
    EXPECT_EQ (folder.at ("requests").size (), 1);
    EXPECT_EQ (skipped_count (result.at ("meta"), "ThroughputController_unrecognised"), 1);
}

namespace {

/// The `meta` of a plan whose body under the TestPlan is @p body.
nlohmann::ordered_json meta_of_plan_with (const std::string& body) {
    const ImportParse parsed = parse_import (plan_with (body), {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result.at ("meta");
}

} // namespace

// A refused element is one entry in the preview, not two: a parser that looked
// at it tallies its own kind and the bare tag stays out; a tag no parser looked
// at keeps the bare tag (#3190). Mutation check: restore the bare-tag tally
// after `build_leaf_elements` returns empty and each `EXPECT_FALSE` below reds.
TEST (JmeterImport, ARefusedLeafIsTalliedOnce) {
    const nlohmann::ordered_json delayless =
    meta_of_plan_with (R"(<ConstantTimer testname="Pause"/><hashTree/>)");
    EXPECT_EQ (skipped_count (delayless, "ConstantTimer_unrecognised"), 1);
    EXPECT_FALSE (has_skipped_kind (delayless, "ConstantTimer"));

    const nlohmann::ordered_json scoped = meta_of_plan_with (
    R"(<HTTPSamplerProxy testname="S"/><hashTree>)"
    R"(<ConstantTimer testname="Pause"/><hashTree/></hashTree>)");
    EXPECT_EQ (skipped_count (scoped, "ConstantTimer_unrecognised"), 1);
    EXPECT_FALSE (has_skipped_kind (scoped, "ConstantTimer"));

    const nlohmann::ordered_json lookahead = response_assertion_plan (2, { "id(?=:)" });
    EXPECT_TRUE (has_skipped_kind (lookahead.at ("meta"), "assert.contains_unmappable"));
    EXPECT_FALSE (has_skipped_kind (lookahead.at ("meta"), "ResponseAssertion"));

    const nlohmann::ordered_json or_result =
    response_assertion_plan (34, { "foo", "bar" });
    EXPECT_TRUE (has_skipped_kind (or_result.at ("meta"), "ResponseAssertion_or"));
    EXPECT_FALSE (has_skipped_kind (or_result.at ("meta"), "ResponseAssertion"));

    const nlohmann::ordered_json unlooked =
    meta_of_plan_with (R"(<CookieManager testname="C"/><hashTree/>)");
    EXPECT_EQ (skipped_count (unlooked, "CookieManager"), 1);
}

namespace {

/// A thread group named "Users" carrying @p props, with @p members inside.
std::string thread_group (const std::string& props,
const std::string& members = "",
const char* enabled        = "true") {
    return std::string ("<ThreadGroup testname=\"Users\" enabled=\"") + enabled +
    "\">" + props + "</ThreadGroup><hashTree>" + members + "</hashTree>";
}

std::string string_prop_xml (const char* name, const std::string& value) {
    return std::string ("<stringProp name=\"") + name + "\">" + value + "</stringProp>";
}

/// The loop count JMeter nests under `ThreadGroup.main_controller`; @p prop is
/// the property element, since JMeter writes a count as either a string or an
/// int.
std::string main_controller (const std::string& prop) {
    return "<elementProp name=\"ThreadGroup.main_controller\" "
           "elementType=\"LoopController\">" +
    prop + "</elementProp>";
}

} // namespace

// The app joins a notice's `names` with commas and prints the first words of
// each, so a comma in the group's name must not read as two groups and an
// empty name must not read as ": 10 threads". Mutation check: restore the
// raw `testname` read in `thread_group_profile` and this reds.
TEST (JmeterImport, AThreadGroupProfileNameHasNoCommaAndIsNeverEmpty) {
    const std::string props = string_prop_xml ("ThreadGroup.num_threads", "10");
    const auto named        = [&] (const char* testname) {
        return skipped_names (
        meta_of_plan_with (std::string ("<ThreadGroup testname=\"") + testname +
        "\" enabled=\"true\">" + props + "</ThreadGroup><hashTree></hashTree>"),
        "ThreadGroup_profile");
    };
    EXPECT_EQ (named ("Users, EU"),
    (std::vector<std::string>{ "Users  EU: 10 threads; 1 loop" }));
    EXPECT_EQ (named (""), (std::vector<std::string>{ "Thread Group: 10 threads; 1 loop" }));
}

// A thread group's threads, ramp-up, duration and loops are the run profile
// the collection does not carry, so the import names them (#3190). Values are
// read from `ThreadGroup.*` and the loop count under
// `ThreadGroup.main_controller`, whether JMeter wrote it as a string or an
// int. Mutation check: drop the `tally_thread_group_profile` call in
// `dispatch_child` and this reds.
TEST (JmeterImport, AThreadGroupsRunProfileIsTalliedWithItsValues) {
    const nlohmann::ordered_json meta = meta_of_plan_with (
    thread_group (string_prop_xml ("ThreadGroup.num_threads", "10") +
    string_prop_xml ("ThreadGroup.ramp_time", "5") +
    main_controller (R"(<intProp name="LoopController.loops">3</intProp>)")));
    EXPECT_EQ (skipped_count (meta, "ThreadGroup_profile"), 1);
    EXPECT_EQ (skipped_names (meta, "ThreadGroup_profile"),
    (std::vector<std::string>{ "Users: 10 threads; ramp-up 5s; 3 loops" }));

    const nlohmann::ordered_json as_string =
    meta_of_plan_with (thread_group (string_prop_xml ("ThreadGroup.num_threads", "2") +
    main_controller (R"(<stringProp name="LoopController.loops">1</stringProp>)")));
    EXPECT_EQ (skipped_names (as_string, "ThreadGroup_profile"),
    (std::vector<std::string>{ "Users: 2 threads; 1 loop" }));
}

// A duration counts only with the scheduler on, as in JMeter (a stale value
// under an unticked scheduler is not the plan's intent), and an unbounded loop
// reads "forever". A property that is a JMeter function call stays as written.
// Mutation check: read `ThreadGroup.duration` without the scheduler flag and
// the scheduler-off half reds.
TEST (JmeterImport, AThreadGroupsDurationNeedsTheSchedulerAndForeverIsSpelledOut) {
    const nlohmann::ordered_json scheduled = meta_of_plan_with (
    thread_group (R"(<boolProp name="ThreadGroup.scheduler">true</boolProp>)" +
    string_prop_xml ("ThreadGroup.duration", "60") +
    string_prop_xml ("ThreadGroup.num_threads", "${__P(users,10)}") +
    string_prop_xml ("ThreadGroup.ramp_time", "20") +
    main_controller (R"(<intProp name="LoopController.loops">-1</intProp>)")));
    EXPECT_EQ (skipped_names (scheduled, "ThreadGroup_profile"),
    (std::vector<std::string>{
    "Users: ${__P(users,10)} threads; ramp-up 20s; duration 60s; forever" }));

    const nlohmann::ordered_json unscheduled = meta_of_plan_with (
    thread_group (R"(<boolProp name="ThreadGroup.scheduler">false</boolProp>)" +
    string_prop_xml ("ThreadGroup.duration", "60")));
    EXPECT_FALSE (has_skipped_kind (unscheduled, "ThreadGroup_profile"));
}

// A group at JMeter's defaults has nothing for the user to set, so it is not
// reported: no properties at all, or one thread making one pass (its ramp-up
// is moot with a single thread). Mutation check: return the description
// unconditionally from `thread_group_profile` and both groups red.
TEST (JmeterImport, ADefaultThreadGroupIsNotReported) {
    EXPECT_FALSE (
    has_skipped_kind (meta_of_plan_with (thread_group ("")), "ThreadGroup_profile"));

    const nlohmann::ordered_json explicit_defaults =
    meta_of_plan_with (thread_group (string_prop_xml ("ThreadGroup.num_threads", "1") +
    string_prop_xml ("ThreadGroup.ramp_time", "1") +
    main_controller (R"(<stringProp name="LoopController.loops">1</stringProp>)")));
    EXPECT_FALSE (has_skipped_kind (explicit_defaults, "ThreadGroup_profile"));
}

// One count per group, aggregated under the one kind with a name each; a
// disabled group is not reported (it never ran in JMeter) and the samplers
// inside a group still import. Mutation check: tally outside the per-group
// call (once per kind) and the count of 2 reds.
TEST (JmeterImport, EachThreadGroupIsCountedAndItsSamplersStillImport) {
    const ImportParse parsed = parse_import (
    plan_with (thread_group (string_prop_xml ("ThreadGroup.num_threads", "3"), sampler ("A")) +
    thread_group (string_prop_xml ("ThreadGroup.num_threads", "7"), sampler ("B")) +
    thread_group (string_prop_xml ("ThreadGroup.num_threads", "9"), sampler ("C"), "false")),
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& meta = parsed.result.at ("meta");
    EXPECT_EQ (skipped_count (meta, "ThreadGroup_profile"), 2);
    EXPECT_EQ (skipped_names (meta, "ThreadGroup_profile"),
    (std::vector<std::string>{ "Users: 3 threads; 1 loop", "Users: 7 threads; 1 loop" }));
    EXPECT_EQ (meta.at ("requestCount"), 2);
}

namespace {

/// A request under the plan holding one @p tag element built from @p props.
nlohmann::ordered_json sampler_scope_result (const char* tag, const std::string& props) {
    const ImportParse parsed = parse_import (
    plan_with (R"(<HTTPSamplerProxy testname="S"/><hashTree>)" + std::string ("<") +
    tag + " testname=\"T\">" + props + "</" + tag + "><hashTree/></hashTree>"),
    {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result;
}

const nlohmann::ordered_json& request_elements (const nlohmann::ordered_json& result) {
    return first_request (result.at ("collections").at (0)).at ("elements");
}

} // namespace

// Several patterns without Or all have to hold, so each is its own assertion
// with the shared mode and Not; the Or case stays refused. Mutation check:
// emit only `texts.front ()` and the size and `bar` expectations red.
TEST (JmeterImport, EveryPatternOfAResponseAssertionBecomesAnAssertion) {
    const nlohmann::ordered_json plain = response_assertion_plan (16, { "foo", "bar" });
    const nlohmann::ordered_json& elements = request_elements (plain);
    ASSERT_EQ (elements.size (), 2);
    EXPECT_EQ (elements.at (0).at ("kind"), "assert.contains");
    EXPECT_EQ (elements.at (0).at ("config").at ("text"), "foo");
    EXPECT_EQ (elements.at (1).at ("config").at ("text"), "bar");
    EXPECT_EQ (elements.at (1).at ("config").at ("mode"), "contains");
    EXPECT_FALSE (has_skipped_kind (plain.at ("meta"), "ResponseAssertion_or"));

    const nlohmann::ordered_json negated = response_assertion_plan (6, { "foo", "bar" });
    ASSERT_EQ (request_elements (negated).size (), 2);
    for (const nlohmann::ordered_json& element : request_elements (negated)) {
        EXPECT_EQ (element.at ("config").at ("negate"), true);
    }

    const nlohmann::ordered_json either = response_assertion_plan (34, { "foo", "bar" });
    EXPECT_FALSE (first_request (either.at ("collections").at (0)).contains ("elements"));
    EXPECT_EQ (skipped_count (either.at ("meta"), "ResponseAssertion_or"), 1);
}

// A pattern the registry refuses drops only itself: its sibling still imports
// and the refusal is counted once. Mutation check: validate the patterns as
// one all-or-nothing list and the surviving `ok` reds.
TEST (JmeterImport, OneBadPatternDoesNotTakeItsSiblingsWithIt) {
    const nlohmann::ordered_json result =
    response_assertion_plan (2, { "id(?=:)", "ok" });
    const nlohmann::ordered_json& elements = request_elements (result);
    ASSERT_EQ (elements.size (), 1);
    EXPECT_EQ (elements.at (0).at ("config").at ("text"), "ok");
    EXPECT_EQ (skipped_count (result.at ("meta"), "assert.contains_unmappable"), 1);
}

// A response-code assertion keeps its one `assert.status` listing every code.
TEST (JmeterImport, SeveralResponseCodesStayOneStatusAssertion) {
    const nlohmann::ordered_json result =
    sampler_scope_result ("ResponseAssertion",
    R"(<collectionProp name="Asserion.test_strings">)"
    R"(<stringProp name="1">200</stringProp><stringProp name="2">201</stringProp>)"
    R"(</collectionProp>)"
    R"(<stringProp name="Assertion.test_field">Assertion.response_code</stringProp>)");
    const nlohmann::ordered_json& elements = request_elements (result);
    ASSERT_EQ (elements.size (), 1);
    EXPECT_EQ (elements.at (0).at ("kind"), "assert.status");
    EXPECT_EQ (elements.at (0).at ("config").at ("in"),
    (nlohmann::ordered_json{ 200, 201 }));
}

namespace {

std::string json_extractor_props (const std::string& names,
const std::string& paths,
const std::string& defaults = "",
const std::string& matches  = "") {
    return string_prop_xml ("JSONPostProcessor.referenceNames", names) +
    string_prop_xml ("JSONPostProcessor.jsonPathExprs", paths) +
    string_prop_xml ("JSONPostProcessor.defaultValues", defaults) +
    string_prop_xml ("JSONPostProcessor.match_numbers", matches);
}

} // namespace

// A JSON Extractor's `;`-separated lists are parallel: one extractor per
// pair, the default and match number read by the same index. Mutation check:
// take only the first segment of each list again and the size and `b`
// expectations red.
TEST (JmeterImport, EveryNamePathPairOfAJsonExtractorBecomesAnExtractor) {
    const nlohmann::ordered_json result = sampler_scope_result (
    "JSONPostProcessor", json_extractor_props ("a;b", "$.x;$.y", "d1", "2;-1"));
    const nlohmann::ordered_json& elements = request_elements (result);
    ASSERT_EQ (elements.size (), 2);
    const nlohmann::ordered_json& first = elements.at (0).at ("config");
    EXPECT_EQ (first.at ("variable"), "a");
    EXPECT_EQ (first.at ("path"), "$.x");
    EXPECT_EQ (first.at ("default"), "d1");
    EXPECT_EQ (first.at ("matchNo"), 2);
    const nlohmann::ordered_json& second = elements.at (1).at ("config");
    EXPECT_EQ (second.at ("variable"), "b");
    EXPECT_EQ (second.at ("path"), "$.y");
    EXPECT_FALSE (second.contains ("default"));
    EXPECT_EQ (second.at ("matchNo"), -1);
    EXPECT_TRUE (result.at ("meta").at ("skipped").empty ());
}

// JMeter's lists are split the way Java's `String.split` does, so a trailing
// `;` adds nothing, and a match number JMeter wrote as a string is honoured
// (the old reader looked only at numeric properties and always used 1).
// Mutation check: keep trailing empty segments and the trailing-`;` plan is
// refused as unrecognised.
TEST (JmeterImport, ATrailingSeparatorAddsNoExtractorAndAStringMatchNumberIsRead) {
    const nlohmann::ordered_json result = sampler_scope_result (
    "JSONPostProcessor", json_extractor_props ("a;", "$.x;", "", "0"));
    const nlohmann::ordered_json& elements = request_elements (result);
    ASSERT_EQ (elements.size (), 1);
    EXPECT_EQ (elements.at (0).at ("config").at ("matchNo"), 0);
}

// Lists that cannot be paired (different lengths, an empty name or path
// between separators) import nothing and are counted once, rather than
// guessing which name goes with which path. Mutation check: pair by the
// shorter list and the first case imports an extractor.
TEST (JmeterImport, UnpairableExtractorListsAreCountedNotGuessedAt) {
    for (const auto& [names, paths] : std::vector<std::pair<std::string, std::string>>{
         { "a;b", "$.x" }, { "a", "$.x;$.y" }, { "a;;b", "$.x;$.y;$.z" }, { "", "" } }) {
        const nlohmann::ordered_json result = sampler_scope_result (
        "JSONPostProcessor", json_extractor_props (names, paths));
        EXPECT_FALSE (first_request (result.at ("collections").at (0)).contains ("elements"))
        << names << " / " << paths;
        EXPECT_EQ (skipped_count (result.at ("meta"), "JSONPostProcessor_unrecognised"), 1)
        << names << " / " << paths;
    }
}

namespace {

/// The folder a plan's one @p tag controller (carrying @p props, holding one
/// sampler) imports as.
nlohmann::ordered_json controller_folder (const char* tag, const std::string& props) {
    const ImportParse parsed =
    parse_import (plan_with (std::string ("<") + tag + " testname=\"C\">" + props +
                  "</" + tag + "><hashTree>" + sampler ("S") + "</hashTree>"),
    {}, {});
    EXPECT_TRUE (parsed.ok ()) << parsed.error;
    return parsed.result;
}

/// @p result's only folder.
const nlohmann::ordered_json& only_folder (const nlohmann::ordered_json& result) {
    return result.at ("collections").at (0).at ("children").at (0);
}

} // namespace

// JMeter's GUI saves a loop count as a `<stringProp>` (so `${var}` can stand
// in for it); hand-written plans use `<intProp>` / `<longProp>`. All three
// import as the same `control.loop`. Mutation check: drop `stringProp` from
// `SCALAR_TAGS` and the string case reads "forever" and is tallied instead.
TEST (JmeterImport, ALoopCountIsReadWhateverTagJMeterSavedItUnder) {
    for (const char* tag : { "stringProp", "intProp", "longProp" }) {
        const std::string prop =
        std::string ("<") + tag + " name=\"LoopController.loops\">3</" + tag + ">";
        const nlohmann::ordered_json result =
        controller_folder ("LoopController", prop);
        const nlohmann::ordered_json& folder = only_folder (result);
        ASSERT_EQ (folder.at ("elements").size (), 1) << tag;
        EXPECT_EQ (folder.at ("elements").at (0).at ("kind"), "control.loop") << tag;
        EXPECT_EQ (folder.at ("elements").at (0).at ("config").at ("count"), 3) << tag;
        EXPECT_FALSE (has_skipped_kind (result.at ("meta"), "LoopController_unrecognised"))
        << tag;
    }
}

// A count that is not a number - a `${var}` the plan resolves at run time, a
// blank (the GUI's "forever" box), `-1` - has no `control.loop`; the folder
// still imports and one notice says so, never a loop of the wrong size.
// Mutation check: have `integer_prop` accept a prefix (`5${n}` reads 5) and the
// `5${n}` case grows an element.
TEST (JmeterImport, ALoopCountThatIsNotANumberIsTalliedNotImported) {
    for (const char* loops : { "${loops}", "", "-1", "5${n}" }) {
        const nlohmann::ordered_json result =
        controller_folder ("LoopController",
        std::string (R"(<stringProp name="LoopController.loops">)") + loops + "</stringProp>");
        const nlohmann::ordered_json& folder = only_folder (result);
        EXPECT_FALSE (folder.contains ("elements")) << loops;
        EXPECT_EQ (folder.at ("requests").size (), 1) << loops;
        EXPECT_EQ (skipped_count (result.at ("meta"), "LoopController_unrecognised"), 1)
        << loops;
    }
}

// A match number saved as a `<stringProp>` is honoured by the Regular
// Expression and Boundary extractors; a `${var}` falls back to JMeter's first
// match. Mutation check: drop `stringProp` from `SCALAR_TAGS` and the 2 reads 1.
TEST (JmeterImport, AStringMatchNumberIsReadByRegexAndBoundaryExtractors) {
    const std::string regex_props = string_prop_xml ("RegexExtractor.refname", "id") +
    string_prop_xml ("RegexExtractor.regex", "id=(\\d+)");
    const nlohmann::ordered_json regex = sampler_scope_result ("RegexExtractor",
    regex_props + string_prop_xml ("RegexExtractor.match_number", "2"));
    EXPECT_EQ (request_elements (regex).at (0).at ("config").at ("matchNo"), 2);

    const nlohmann::ordered_json regex_var =
    sampler_scope_result ("RegexExtractor",
    regex_props + string_prop_xml ("RegexExtractor.match_number", "${n}"));
    EXPECT_EQ (request_elements (regex_var).at (0).at ("config").at ("matchNo"), 1);

    const nlohmann::ordered_json boundary =
    sampler_scope_result ("BoundaryExtractor",
    string_prop_xml ("BoundaryExtractor.refname", "id") +
    string_prop_xml ("BoundaryExtractor.lboundary", "id=") +
    string_prop_xml ("BoundaryExtractor.rboundary", ";") +
    string_prop_xml ("BoundaryExtractor.match_number", "3"));
    EXPECT_EQ (request_elements (boundary).at (0).at ("config").at ("matchNo"), 3);
}

namespace {

/// The `timer.think` config a random timer (@p tag) saved with @p base and
/// @p range imports as, written the way JMeter's GUI writes them.
nlohmann::ordered_json
random_timer_config (const char* tag, const std::string& base, const std::string& range) {
    const nlohmann::ordered_json result = sampler_scope_result (tag,
    string_prop_xml ("ConstantTimer.delay", base) +
    string_prop_xml ("RandomTimer.range", range));
    return request_elements (result).at (0).at ("config");
}

} // namespace

// A random timer's floor is `ConstantTimer.delay` and its spread
// `RandomTimer.range`, the names the GUI saves. Mutation check: read
// `ConstantDelay` again as the base and `minMs` is 0, `maxMs` 500.
TEST (JmeterImport, AUniformRandomTimerIsFlooredAtItsConstantDelay) {
    const nlohmann::ordered_json config =
    random_timer_config ("UniformRandomTimer", "1000", "500.0");
    EXPECT_EQ (config.at ("minMs"), 1000);
    EXPECT_EQ (config.at ("maxMs"), 1500);
}

TEST (JmeterImport, AGaussianRandomTimerIsCentredOnItsConstantDelay) {
    const nlohmann::ordered_json config =
    random_timer_config ("GaussianRandomTimer", "1000", "500.0");
    EXPECT_EQ (config.at ("gaussian").at ("meanMs"), 1000.0);
    EXPECT_EQ (config.at ("gaussian").at ("deviationMs"), 500.0);
}

// A random timer whose numbers cannot be read - a `${var}`, or the property
// names an older reader looked for - is counted, not imported as a 0ms wait.
TEST (JmeterImport, ARandomTimerWithUnreadableNumbersIsTalliedNotImported) {
    for (const char* tag : { "UniformRandomTimer", "GaussianRandomTimer" }) {
        const nlohmann::ordered_json variable = sampler_scope_result (tag,
        string_prop_xml ("ConstantTimer.delay", "${base}") +
        string_prop_xml ("RandomTimer.range", "500.0"));
        EXPECT_FALSE (first_request (variable.at ("collections").at (0)).contains ("elements"))
        << tag;
        EXPECT_EQ (skipped_count (variable.at ("meta"), std::string (tag) + "_unrecognised"), 1)
        << tag;

        const nlohmann::ordered_json renamed = sampler_scope_result (tag,
        string_prop_xml ("ConstantDelay", "1000") +
        string_prop_xml ("RandomTime.range", "500.0"));
        EXPECT_EQ (skipped_count (renamed.at ("meta"), std::string (tag) + "_unrecognised"), 1)
        << tag;
    }
}

namespace {

/// A Constant Throughput Timer config; @p throughput is the property element.
nlohmann::ordered_json throughput_timer_result (const std::string& throughput,
const std::string& calc_mode) {
    return sampler_scope_result ("ConstantThroughputTimer", throughput + calc_mode);
}

} // namespace

// The GUI saves `throughput` as a nested `<doubleProp>` (name and value as
// children), and `calcMode` as an int; a hand-written plan uses a flat string.
// 60 per minute is one every 1000ms. Mutation check: drop the nested read from
// `scalar_text` and the plan is tallied unrecognised instead.
TEST (JmeterImport, AConstantThroughputTimerReadsItsNestedDoubleThroughput) {
    const nlohmann::ordered_json nested =
    throughput_timer_result (R"(<doubleProp><name>throughput</name><value>60.0</value>)"
                             R"(<savedValue>0.0</savedValue></doubleProp>)",
    R"(<intProp name="calcMode">0</intProp>)");
    const nlohmann::ordered_json& config = request_elements (nested).at (0).at ("config");
    EXPECT_EQ (request_elements (nested).at (0).at ("kind"), "timer.pacing");
    EXPECT_EQ (config.at ("everyMs"), 1000);
    EXPECT_EQ (config.at ("perUser"), true);
    EXPECT_FALSE (
    has_skipped_kind (nested.at ("meta"), "ConstantThroughputTimer_unrecognised"));

    const nlohmann::ordered_json flat = throughput_timer_result (
    string_prop_xml ("throughput", "30"), string_prop_xml ("calcMode", "2"));
    const nlohmann::ordered_json& flat_config =
    request_elements (flat).at (0).at ("config");
    EXPECT_EQ (flat_config.at ("everyMs"), 2000);
    EXPECT_EQ (flat_config.at ("perUser"), false);
}

TEST (JmeterImport, AConstantThroughputTimerWithAVariableRateIsTalliedNotImported) {
    const nlohmann::ordered_json result = throughput_timer_result (
    string_prop_xml ("throughput", "${rate}"), R"(<intProp name="calcMode">0</intProp>)");
    EXPECT_FALSE (first_request (result.at ("collections").at (0)).contains ("elements"));
    EXPECT_EQ (
    skipped_count (result.at ("meta"), "ConstantThroughputTimer_unrecognised"), 1);
}

namespace {

/// A setup or teardown group (@p tag) holding @p members, inside the test plan.
std::string lifecycle_group (const char* tag, const std::string& members) {
    return std::string ("<") + tag + " testname=\"Lifecycle\"/><hashTree>" +
    members + "</hashTree>";
}

std::string script_element (const char* tag, const std::string& body) {
    return std::string ("<") + tag + " testname=\"Script\">" +
    string_prop_xml ("script", body) + "</" + tag + "><hashTree/>";
}

} // namespace

// A setup/teardown group of samplers is not imported as requests (they would
// run on every pass instead of once) and each sampler is counted, at any
// depth, so the number is how many to rebuild by hand. An empty group is still
// one loss. Mutation check: count the group as 1 again and the 3 reds; import
// the samplers and `requestCount` reds.
TEST (JmeterImport, ALifecycleGroupOfSamplersIsCountedPerSamplerNotImported) {
    const ImportParse parsed = parse_import (
    plan_with (lifecycle_group ("SetupThreadGroup",
               sampler ("Login") + sampler ("Seed") +
               controller ("TransactionController", "Inner", sampler ("Warm"))) +
    lifecycle_group ("PostThreadGroup", sampler ("Cleanup"))),
    {}, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& meta = parsed.result.at ("meta");
    EXPECT_EQ (skipped_count (meta, "SetupThreadGroup"), 3);
    EXPECT_EQ (skipped_count (meta, "PostThreadGroup"), 1);
    EXPECT_EQ (meta.at ("requestCount"), 0);
    const nlohmann::ordered_json& collection = parsed.result.at ("collections").at (0);
    EXPECT_TRUE (collection.at ("requests").empty ());
    EXPECT_TRUE (collection.at ("children").empty ());

    const nlohmann::ordered_json empty =
    meta_of_plan_with (lifecycle_group ("SetupThreadGroup", ""));
    EXPECT_EQ (skipped_count (empty, "SetupThreadGroup"), 1);
}

// The script a group carries imports as the lifecycle script; a sampler beside
// it is still reported, and a scripted sampler that became the script is not.
// Mutation check: return without tallying after the script imports and the
// `Cleanup` count reds; stop subtracting `scripted_samplers` and the
// script-only case reports a loss.
TEST (JmeterImport, ALifecycleScriptImportsAndTheSamplersBesideItAreStillCounted) {
    const ImportParse beside = parse_import (
    plan_with (lifecycle_group ("PostThreadGroup",
    script_element ("JSR223PostProcessor", "pm.environment.clear();") + sampler ("Cleanup"))),
    {}, {});
    ASSERT_TRUE (beside.ok ()) << beside.error;
    const nlohmann::ordered_json& collection = beside.result.at ("collections").at (0);
    ASSERT_EQ (collection.at ("elements").size (), 1);
    EXPECT_EQ (collection.at ("elements").at (0).at ("kind"), "script.teardown");
    EXPECT_EQ (skipped_count (beside.result.at ("meta"), "PostThreadGroup"), 1);

    const ImportParse script_only = parse_import (
    plan_with (lifecycle_group ("SetupThreadGroup", script_element ("JSR223Sampler", "x();"))),
    {}, {});
    ASSERT_TRUE (script_only.ok ()) << script_only.error;
    EXPECT_EQ (script_only.result.at ("collections").at (0).at ("elements").size (), 1);
    EXPECT_FALSE (has_skipped_kind (script_only.result.at ("meta"), "SetupThreadGroup"));
}

// With scripts not imported, a scripted sampler is one more thing left out.
// An element switched off in JMeter is tallied once, by the walk that counts
// the group, and the group is still one loss.
TEST (JmeterImport, ALifecycleScriptThatIsNotImportedIsCountedAndADisabledSamplerOnce) {
    ImportOptions without_scripts;
    without_scripts.import_scripts = false;
    const ImportParse parsed       = parse_import (
    plan_with (lifecycle_group ("SetupThreadGroup",
    script_element ("JSR223Sampler", "x();") + sampler ("Off", "false"))),
    without_scripts, {});
    ASSERT_TRUE (parsed.ok ()) << parsed.error;
    const nlohmann::ordered_json& meta = parsed.result.at ("meta");
    EXPECT_EQ (skipped_count (meta, "SetupThreadGroup"), 1);
    EXPECT_EQ (skipped_count (meta, "HTTPSamplerProxy_disabled"), 1);
    EXPECT_FALSE (parsed.result.at ("collections").at (0).contains ("elements"));
}
