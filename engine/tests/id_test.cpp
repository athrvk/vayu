/**
 * @file tests/id_test.cpp
 * @brief Tests for vayu::utils::generate_id - the random UUIDv4 record-ID
 *        generator that replaced the collision-prone prefix + now_ms() scheme.
 */

#include <gtest/gtest.h>

#include <regex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "vayu/utils/id.hpp"

using vayu::utils::generate_id;

// Canonical RFC 4122 version-4 UUID: 8-4-4-4-12 lowercase hex, the third group
// starts with '4' (version) and the fourth with 8/9/a/b (variant 10xx).
static const std::regex kUuidV4 (
"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

// A timestamp implementation fails this instantly: in a tight single-threaded
// loop every generation lands in the same millisecond, so the old scheme
// collides on the first duplicate. Doubles as the mutation-check.
TEST (GenerateId, UniquenessHammerSingleThread) {
    constexpr int kCount = 100000;
    std::unordered_set<std::string> ids;
    ids.reserve (kCount);
    for (int i = 0; i < kCount; ++i) {
        EXPECT_TRUE (ids.insert (generate_id ("run_")).second)
        << "duplicate ID at iteration " << i;
    }
    EXPECT_EQ (ids.size (), static_cast<size_t> (kCount));
}

// Each thread owns its PRNG (thread_local), so IDs must stay unique across
// threads too - not just within one.
TEST (GenerateId, UniquenessAcrossThreads) {
    constexpr int kThreads   = 8;
    constexpr int kPerThread = 10000;
    std::vector<std::vector<std::string>> per_thread (kThreads);
    std::vector<std::thread> workers;
    workers.reserve (kThreads);
    for (int t = 0; t < kThreads; ++t) {
        workers.emplace_back ([&per_thread, t] {
            auto& bucket = per_thread[static_cast<size_t> (t)];
            bucket.reserve (kPerThread);
            for (int i = 0; i < kPerThread; ++i) {
                bucket.push_back (generate_id ("req_"));
            }
        });
    }
    for (auto& w : workers) {
        w.join ();
    }

    constexpr size_t kTotal = static_cast<size_t> (kThreads) * kPerThread;
    std::unordered_set<std::string> all;
    all.reserve (kTotal);
    for (const auto& bucket : per_thread) {
        for (const auto& id : bucket) {
            EXPECT_TRUE (all.insert (id).second) << "duplicate across threads: " << id;
        }
    }
    EXPECT_EQ (all.size (), kTotal);
}

// Prefix is preserved verbatim and the suffix is a well-formed UUIDv4 with the
// version and variant bits set.
TEST (GenerateId, FormatPrefixAndUuidV4) {
    for (const char* prefix : { "run_", "col_", "req_", "env_", "oauth_" }) {
        const std::string id = generate_id (prefix);
        const std::string prefix_str (prefix);
        ASSERT_EQ (id.rfind (prefix_str, 0), 0U) << "prefix missing in " << id;
        const std::string suffix = id.substr (prefix_str.size ());
        EXPECT_TRUE (std::regex_match (suffix, kUuidV4))
        << "suffix is not a UUIDv4: " << suffix;
    }
}

// An empty prefix yields a bare UUID (the app's crypto.randomUUID() shape).
TEST (GenerateId, EmptyPrefixIsBareUuid) {
    const std::string id = generate_id ("");
    EXPECT_TRUE (std::regex_match (id, kUuidV4)) << id;
}
