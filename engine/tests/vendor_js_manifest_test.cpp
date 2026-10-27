/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/vendor_js_manifest_test.cpp
 * @brief `engine/vendor/js-manifest.json` accounts for every script library the
 *        engine embeds (#2750).
 *
 * The libraries `require()` hands out are committed as build output, and a
 * README sentence saying "byte for byte" is not something a build can fail on.
 * The manifest records each shipped file's SHA-256, the npm tarballs it came
 * from and the command that produced it; this suite is its offline half: it
 * hashes the files and fails on a mismatch, on a script file the manifest does
 * not list, and on a manifest that lists nothing. The online half, fetching the
 * tarballs and rebuilding, is `scripts/vendor-js/rebuild.sh`.
 *
 * The checks run against a directory they are handed so the planted-defect
 * tests can drive each one at a fixture and not at the real tree.
 */

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <format>
#include <fstream>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sha256.hpp"

namespace {

namespace fs = std::filesystem;

/// Vendored C and C++ projects, not script libraries.
constexpr std::array<std::string_view, 2> NOT_SCRIPT_LIBRARIES = { "quickjs-ng", "hdrhistogram" };

/// A script file under `engine/vendor/` is shipped or it is a build input; both
/// are listed, so a file with one of these extensions that is not is a gap.
constexpr std::array<std::string_view, 3> SCRIPT_EXTENSIONS = { ".js", ".mjs", ".cjs" };

constexpr std::array<std::string_view, 2> BUILD_KINDS = { "verbatim", "esbuild" };

constexpr std::string_view MANIFEST_NAME = "js-manifest.json";

template <std::size_t N>
bool is_one_of (std::string_view value, const std::array<std::string_view, N>& choices) {
    return std::ranges::find (choices, value) != choices.end ();
}

std::string string_field (const nlohmann::json& object, const char* key) {
    if (!object.is_object () || !object.contains (key) || !object.at (key).is_string ()) {
        return {};
    }
    return object.at (key).get<std::string> ();
}

/// Lowercase hex SHA-256 of the file's bytes (binary mode, so no platform
/// rewrites a line ending before the hash sees it); empty if it cannot be read.
std::string file_sha256 (const fs::path& path) {
    std::ifstream file (path, std::ios::binary);
    std::ostringstream bytes;
    bytes << file.rdbuf ();
    if (!file) {
        return {};
    }
    const auto digest = vayu::utils::sha256 (bytes.str ());
    return vayu::utils::hex_encode (vayu::utils::byte_view (digest));
}

bool is_sha256_hex (const std::string& text) {
    constexpr std::size_t HEX_LENGTH = 64;
    return text.size () == HEX_LENGTH &&
    text.find_first_not_of ("0123456789abcdef") == std::string::npos;
}

/// One `{path, sha256}` pair, the shape of a shipped file and of a build input.
void check_hashed_file (const fs::path& vendor,
const nlohmann::json& item,
std::set<std::string>& listed,
std::vector<std::string>& problems) {
    const std::string path     = string_field (item, "path");
    const std::string expected = string_field (item, "sha256");
    if (path.empty () || !is_sha256_hex (expected)) {
        problems.push_back (
        "an entry needs a path and a lowercase 64-digit sha256, got " + item.dump ());
        return;
    }
    if (!listed.insert (path).second) {
        problems.push_back (path + " is listed more than once");
        return;
    }
    const fs::path on_disk = vendor / path;
    if (!fs::is_regular_file (on_disk)) {
        problems.push_back (path + " is in the manifest but is not a file under engine/vendor");
        return;
    }
    const std::string actual = file_sha256 (on_disk);
    if (actual != expected) {
        problems.push_back (path + " has sha256 " + actual + " but the manifest says " + expected +
        ": rebuild it with scripts/vendor-js/rebuild.sh, or update the "
        "manifest if the change is the point");
    }
}

/// Who published the file, in which version, under which registry digest.
void check_packages (const std::string& path,
const nlohmann::json& entry,
std::vector<std::string>& problems) {
    const auto& packages = entry.contains ("packages") ? entry.at ("packages") :
                                                         nlohmann::json::array ();
    if (!packages.is_array () || packages.empty ()) {
        problems.push_back (path + " names no source package");
        return;
    }
    for (const auto& package : packages) {
        const std::string name = string_field (package, "name");
        for (const char* key : { "name", "version", "tarball" }) {
            if (string_field (package, key).empty ()) {
                problems.push_back (
                std::format ("{}: a package has no {} ({})", path, key, name));
            }
        }
        if (!string_field (package, "integrity").starts_with ("sha512-")) {
            problems.push_back (std::format (
            "{}: {} has no sha512 dist.integrity from the registry", path, name));
        }
    }
}

/// How the committed bytes were made from the packages.
void check_build (const std::string& path,
const nlohmann::json& entry,
std::vector<std::string>& problems) {
    const auto& build =
    entry.contains ("build") ? entry.at ("build") : nlohmann::json::object ();
    const std::string kind = string_field (build, "kind");
    if (!is_one_of (kind, BUILD_KINDS)) {
        problems.push_back (
        path + ": build.kind must be verbatim or esbuild, got '" + kind + "'");
        return;
    }
    if (kind == "verbatim" && string_field (build, "source").empty ()) {
        problems.push_back (path + ": a verbatim build names the file it is copied from");
    }
    const bool has_args = build.contains ("args") && build.at ("args").is_array ();
    if (kind == "esbuild" && (string_field (build, "esbuild").empty () || !has_args)) {
        problems.push_back (path + ": an esbuild build pins the esbuild version and its args");
    }
}

/// The files an esbuild command reads that are not in the packages.
void check_inputs (const fs::path& vendor,
const nlohmann::json& entry,
std::set<std::string>& listed,
std::vector<std::string>& problems) {
    if (!entry.contains ("build") || !entry.at ("build").is_object ()) {
        return;
    }
    const auto& build = entry.at ("build");
    if (!build.contains ("inputs") || !build.at ("inputs").is_array ()) {
        return;
    }
    for (const auto& input : build.at ("inputs")) {
        check_hashed_file (vendor, input, listed, problems);
    }
}

/// Every script file under @p vendor outside the C and C++ trees, relative and
/// with forward slashes. Counted by the caller: a walk that found none would
/// pass the unlisted-file check whatever the tree held.
std::vector<std::string> script_files_under (const fs::path& vendor) {
    std::vector<std::string> found;
    std::error_code ec;
    for (fs::recursive_directory_iterator it (vendor, ec), end;
    !ec && it != end; it.increment (ec)) {
        const std::string name = it->path ().filename ().string ();
        if (it->is_directory () && is_one_of (name, NOT_SCRIPT_LIBRARIES)) {
            it.disable_recursion_pending ();
            continue;
        }
        const std::string extension = it->path ().extension ().string ();
        if (it->is_regular_file () && is_one_of (extension, SCRIPT_EXTENSIONS)) {
            found.push_back (fs::relative (it->path (), vendor).generic_string ());
        }
    }
    return found;
}

/// Every way @p vendor disagrees with its manifest, one message each; empty
/// means the tree is what the manifest says it is.
std::vector<std::string> vendor_js_problems (const fs::path& vendor) {
    std::vector<std::string> problems;
    std::ifstream manifest_file (vendor / std::string (MANIFEST_NAME), std::ios::binary);
    if (!manifest_file) {
        return { std::string (MANIFEST_NAME) + " cannot be read from " + vendor.string () };
    }
    const auto manifest = nlohmann::json::parse (manifest_file, nullptr, false);
    if (manifest.is_discarded () || !manifest.is_object ()) {
        return { std::string (MANIFEST_NAME) + " is not a JSON object" };
    }
    const auto& entries = manifest.contains ("files") ? manifest.at ("files") :
                                                        nlohmann::json::array ();
    if (!entries.is_array () || entries.empty ()) {
        return { std::string (MANIFEST_NAME) + " lists no files" };
    }

    std::set<std::string> listed;
    for (const auto& entry : entries) {
        const std::string path = string_field (entry, "path");
        check_hashed_file (vendor, entry, listed, problems);
        check_packages (path, entry, problems);
        check_build (path, entry, problems);
        check_inputs (vendor, entry, listed, problems);
    }

    const auto on_disk = script_files_under (vendor);
    if (on_disk.empty ()) {
        problems.push_back ("found no script file under " + vendor.string () +
        ": the unlisted-file check is looking in the wrong place");
    }
    for (const auto& path : on_disk) {
        if (!listed.contains (path)) {
            problems.push_back (path + " is a script file under engine/vendor that " +
            std::string (MANIFEST_NAME) +
            " does not list (a shipped library, or a "
            "build input of one)");
        }
    }
    return problems;
}

std::string joined (const std::vector<std::string>& problems) {
    std::string out;
    for (const auto& problem : problems) {
        out += "\n  " + problem;
    }
    return out;
}

bool mentions (const std::vector<std::string>& problems, std::string_view needle) {
    for (const auto& problem : problems) {
        if (problem.find (needle) != std::string::npos) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

TEST (VendorJsManifest, EveryShippedScriptLibraryMatchesItsManifestEntry) {
    const fs::path vendor = fs::path (VAYU_ENGINE_SOURCE_DIR) / "vendor";
    const auto problems   = vendor_js_problems (vendor);
    EXPECT_TRUE (problems.empty ())
    << "engine/vendor disagrees with js-manifest.json:" << joined (problems);
}

// ---------------------------------------------------------------------------
// The checks themselves, against a fixture they can fail on
// ---------------------------------------------------------------------------

constexpr std::string_view LIBRARY_BYTES = "module.exports = 1;\n";
constexpr std::string_view SHIM_BYTES    = "export const shim = 2;\n";

/// A two-file vendor tree (one verbatim library, one esbuild bundle with a
/// build input) and the manifest that describes it.
class VendorJsFixture : public ::testing::Test {
    protected:
    void SetUp () override {
        const auto* test = ::testing::UnitTest::GetInstance ()->current_test_info ();
        root_ = fs::current_path () / (std::string ("vendor-js-") + test->name ());
        fs::remove_all (root_);
        fs::create_directories (root_ / "plain");
        fs::create_directories (root_ / "bundled");
        write ("plain/plain.min.js", LIBRARY_BYTES);
        write ("bundled/bundled.min.js", LIBRARY_BYTES);
        write ("bundled/shims.mjs", SHIM_BYTES);
        write_manifest (manifest ());
    }

    void TearDown () override {
        std::error_code ec;
        fs::remove_all (root_, ec);
    }

    void write (const std::string& relative, std::string_view bytes) const {
        fs::create_directories ((root_ / relative).parent_path ());
        std::ofstream (root_ / relative, std::ios::binary | std::ios::trunc) << bytes;
    }

    void write_manifest (const nlohmann::json& manifest) const {
        write (std::string (MANIFEST_NAME), manifest.dump (2));
    }

    static std::string sha_of (std::string_view bytes) {
        const auto digest = vayu::utils::sha256 (bytes);
        return vayu::utils::hex_encode (vayu::utils::byte_view (digest));
    }

    static nlohmann::json package (const std::string& name) {
        return { { "name", name }, { "version", "1.0.0" },
            { "tarball", "https://registry.npmjs.org/" + name + "/-/" + name + "-1.0.0.tgz" },
            { "integrity", "sha512-AAAA" } };
    }

    nlohmann::json manifest () const {
        const nlohmann::json plain   = { { "name", "plain" },
            { "path", "plain/plain.min.js" }, { "sha256", sha_of (LIBRARY_BYTES) },
            { "packages", nlohmann::json::array ({ package ("plain") }) },
            { "build", { { "kind", "verbatim" }, { "source", "dist/plain.min.js" } } } };
        const nlohmann::json bundled = { { "name", "bundled" },
            { "path", "bundled/bundled.min.js" }, { "sha256", sha_of (LIBRARY_BYTES) },
            { "packages", nlohmann::json::array ({ package ("bundled") }) },
            { "build",
            { { "kind", "esbuild" }, { "esbuild", "0.28.2" },
            { "args", nlohmann::json::array ({ "--minify" }) },
            { "inputs",
            nlohmann::json::array ({ { { "path", "bundled/shims.mjs" },
            { "sha256", sha_of (SHIM_BYTES) } } }) } } } };
        return { { "schema", 1 }, { "files", nlohmann::json::array ({ plain, bundled }) } };
    }

    fs::path root_;
};

TEST_F (VendorJsFixture, ACleanTreePasses) {
    EXPECT_TRUE (vendor_js_problems (root_).empty ())
    << joined (vendor_js_problems (root_));
}

TEST_F (VendorJsFixture, OneChangedByteFailsNamingTheFile) {
    write ("plain/plain.min.js", "module.exports = 2;\n");
    const auto problems = vendor_js_problems (root_);
    ASSERT_EQ (problems.size (), 1u) << joined (problems);
    EXPECT_TRUE (mentions (problems, "plain/plain.min.js has sha256")) << joined (problems);
}

TEST_F (VendorJsFixture, ALineEndingChangeIsAChange) {
    write ("plain/plain.min.js", "module.exports = 1;\r\n");
    EXPECT_TRUE (mentions (vendor_js_problems (root_), "plain/plain.min.js has sha256"));
}

TEST_F (VendorJsFixture, AChangedBuildInputFails) {
    write ("bundled/shims.mjs", "export const shim = 3;\n");
    const auto problems = vendor_js_problems (root_);
    ASSERT_EQ (problems.size (), 1u) << joined (problems);
    EXPECT_TRUE (mentions (problems, "bundled/shims.mjs has sha256")) << joined (problems);
}

TEST_F (VendorJsFixture, AListedFileThatIsGoneFails) {
    fs::remove (root_ / "plain" / "plain.min.js");
    EXPECT_TRUE (mentions (vendor_js_problems (root_), "plain/plain.min.js is in the manifest"));
}

TEST_F (VendorJsFixture, AnUnlistedShippedScriptFails) {
    write ("extra/extra.js", "1;\n");
    const auto problems = vendor_js_problems (root_);
    ASSERT_EQ (problems.size (), 1u) << joined (problems);
    EXPECT_TRUE (mentions (problems, "extra/extra.js is a script file"));
}

TEST_F (VendorJsFixture, AnUnlistedModuleOrCommonJsScriptFails) {
    write ("bundled/unused.mjs", "export {};\n");
    write ("bundled/shims/unused.cjs", "module.exports = {};\n");
    const auto problems = vendor_js_problems (root_);
    EXPECT_TRUE (mentions (problems, "bundled/unused.mjs")) << joined (problems);
    EXPECT_TRUE (mentions (problems, "bundled/shims/unused.cjs")) << joined (problems);
}

TEST_F (VendorJsFixture, TheCAndCppTreesAreNotScanned) {
    write ("quickjs-ng/example.js", "1;\n");
    write ("hdrhistogram/nested/example.js", "1;\n");
    EXPECT_TRUE (vendor_js_problems (root_).empty ())
    << joined (vendor_js_problems (root_));
}

TEST_F (VendorJsFixture, AnEmptyManifestFails) {
    write_manifest ({ { "schema", 1 }, { "files", nlohmann::json::array () } });
    EXPECT_TRUE (mentions (vendor_js_problems (root_), "lists no files"));
}

TEST_F (VendorJsFixture, AMissingOrMalformedManifestFails) {
    write (std::string (MANIFEST_NAME), "{ not json");
    EXPECT_TRUE (mentions (vendor_js_problems (root_), "is not a JSON object"));
    fs::remove (root_ / std::string (MANIFEST_NAME));
    EXPECT_TRUE (mentions (vendor_js_problems (root_), "cannot be read"));
}

TEST_F (VendorJsFixture, AnEntryWithoutProvenanceFails) {
    auto broken = manifest ();
    broken["files"][0].erase ("packages");
    broken["files"][1]["build"]["kind"]            = "copied-by-hand";
    broken["files"][1]["packages"][0]["integrity"] = "sha1-AAAA";
    write_manifest (broken);
    const auto problems = vendor_js_problems (root_);
    EXPECT_TRUE (mentions (problems, "plain/plain.min.js names no source package"))
    << joined (problems);
    EXPECT_TRUE (mentions (problems, "build.kind must be verbatim or esbuild"))
    << joined (problems);
    EXPECT_TRUE (mentions (problems, "bundled has no sha512 dist.integrity"))
    << joined (problems);
}

TEST_F (VendorJsFixture, AFileListedTwiceFails) {
    auto doubled = manifest ();
    doubled["files"].push_back (doubled["files"][0]);
    write_manifest (doubled);
    EXPECT_TRUE (mentions (vendor_js_problems (root_), "is listed more than once"));
}

} // namespace
