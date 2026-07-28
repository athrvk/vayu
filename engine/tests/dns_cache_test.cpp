/**
 * @file tests/dns_cache_test.cpp
 * @brief Tests for the pre-resolution DNS cache the event loop pins onto every
 *        transfer with CURLOPT_RESOLVE.
 *
 * Two properties matter here and neither was true before: an entry has to
 * expire (curl treats a pinned address as authoritative, so a stale one
 * survives a blue/green deploy and fails every request until the daemon
 * restarts), and a *failed* lookup has to be remembered briefly (resolve()
 * blocks the worker thread on getaddrinfo, stalling every in-flight transfer
 * that worker owns).
 *
 * The resolver is injected so both are deterministic and countable rather than
 * dependent on real DNS.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>

#include "vayu/core/constants.hpp"
#include "vayu/http/event_loop/event_loop_worker.hpp"

using vayu::http::detail::dns_entry_is_fresh;
using vayu::http::detail::DnsCache;

namespace {

/// Counts lookups so a cache hit is distinguishable from a re-resolve.
class CountingResolver {
    public:
    explicit CountingResolver (std::string answer)
    : answer_ (std::move (answer)) {
    }

    std::string operator() (const std::string&) {
        calls_->fetch_add (1);
        return answer_;
    }

    int calls () const {
        return calls_->load ();
    }

    private:
    std::string answer_;
    // Shared: DnsCache stores the resolver by value (std::function copies it).
    std::shared_ptr<std::atomic<int>> calls_ = std::make_shared<std::atomic<int>> (0);
};

constexpr long kNeverExpires = -1;
constexpr long kCachingOff   = 0;

} // namespace

// ============================================================================
// dns_entry_is_fresh - the expiry rule, without waiting for wall-clock time
// ============================================================================

TEST (DnsEntryIsFresh, PositiveEntryLivesForItsTtlAndNoLonger) {
    EXPECT_TRUE (dns_entry_is_fresh (false, std::chrono::seconds (299), 300));
    EXPECT_FALSE (dns_entry_is_fresh (false, std::chrono::seconds (301), 300));
}

// Mutation-check: delete the `ttl_seconds == 0` branch and this fails - the
// setting documented as "no caching" would keep serving a cached address.
TEST (DnsEntryIsFresh, ZeroTtlDisablesCachingEntirely) {
    EXPECT_FALSE (dns_entry_is_fresh (false, std::chrono::seconds (0), kCachingOff));
    EXPECT_FALSE (dns_entry_is_fresh (true, std::chrono::seconds (0), kCachingOff));
}

TEST (DnsEntryIsFresh, NegativeTtlNeverExpiresAnAddress) {
    EXPECT_TRUE (dns_entry_is_fresh (false, std::chrono::hours (48), kNeverExpires));
}

// A remembered failure is the one entry that must expire even when addresses
// are configured never to: "this host does not resolve" stops being true as
// soon as the host comes up. Mutation-check: drop the `negative` branch and
// both of these report the failure as still fresh.
TEST (DnsEntryIsFresh, RememberedFailureExpiresEvenWhenAddressesDoNot) {
    const auto negative_ttl = std::chrono::seconds (
    vayu::core::constants::event_loop::DNS_NEGATIVE_CACHE_SECONDS);

    EXPECT_TRUE (dns_entry_is_fresh (
    true, negative_ttl - std::chrono::seconds (1), kNeverExpires));
    EXPECT_FALSE (dns_entry_is_fresh (
    true, negative_ttl + std::chrono::seconds (1), kNeverExpires));
    // ... and never outlives a shorter configured TTL either.
    EXPECT_FALSE (dns_entry_is_fresh (true, negative_ttl, 3600));
}

// ============================================================================
// DnsCache - lookups actually avoided
// ============================================================================

TEST (DnsCacheTest, ResolvedAddressIsReusedWithinTheTtl) {
    CountingResolver resolver ("10.0.0.1");
    DnsCache cache (resolver);

    EXPECT_EQ (cache.resolve ("example.com", 300), "10.0.0.1");
    EXPECT_EQ (cache.resolve ("example.com", 300), "10.0.0.1");
    EXPECT_EQ (resolver.calls (), 1) << "second call must be served from cache";
}

// The defect this cache had: nothing ever evicted an entry, so a DNS change
// was invisible for the life of the process. Mutation-check: make is_fresh
// return true unconditionally and the second lookup never happens.
TEST (DnsCacheTest, StaleEntryIsReResolved) {
    CountingResolver resolver ("10.0.0.1");
    DnsCache cache (resolver);

    EXPECT_EQ (cache.resolve ("example.com", 1), "10.0.0.1");
    std::this_thread::sleep_for (std::chrono::milliseconds (1100));
    EXPECT_EQ (cache.resolve ("example.com", 1), "10.0.0.1");

    EXPECT_EQ (resolver.calls (), 2)
    << "an entry past its TTL must be re-resolved";
}

// A failed lookup used to be dropped on the floor (`if (!ip.empty())`), so an
// unresolvable host re-entered blocking getaddrinfo on the worker thread for
// every single request. Mutation-check: restore the empty-check around the
// cache write and the second call resolves again.
TEST (DnsCacheTest, FailedLookupIsRememberedBriefly) {
    CountingResolver resolver ("");
    DnsCache cache (resolver);

    EXPECT_EQ (cache.resolve ("nope.invalid", 300), "");
    EXPECT_EQ (cache.resolve ("nope.invalid", 300), "");
    EXPECT_EQ (resolver.calls (), 1)
    << "a known-bad host must not re-block the worker";
    EXPECT_EQ (cache.size (), 1u);
}

TEST (DnsCacheTest, CachingOffAlwaysResolvesAndStoresNothing) {
    CountingResolver resolver ("10.0.0.1");
    DnsCache cache (resolver);

    EXPECT_EQ (cache.resolve ("example.com", kCachingOff), "10.0.0.1");
    EXPECT_EQ (cache.resolve ("example.com", kCachingOff), "10.0.0.1");
    EXPECT_EQ (resolver.calls (), 2);
    EXPECT_EQ (cache.size (), 0u);
}

TEST (DnsCacheTest, ResolveListIsNullForAHostThatDoesNotResolve) {
    CountingResolver resolver ("");
    DnsCache cache (resolver);

    EXPECT_EQ (cache.get_resolve_list ("nope.invalid", 80, 300), nullptr);
}

TEST (DnsCacheTest, ResolveListPinsHostPortAndAddress) {
    CountingResolver resolver ("10.0.0.1");
    DnsCache cache (resolver);

    struct curl_slist* list = cache.get_resolve_list ("example.com", 8080, 300);
    ASSERT_NE (list, nullptr);
    EXPECT_STREQ (list->data, "example.com:8080:10.0.0.1");
    curl_slist_free_all (list);
}

TEST (DnsCacheTest, ClearDropsEverything) {
    CountingResolver resolver ("10.0.0.1");
    DnsCache cache (resolver);

    (void)cache.resolve ("example.com", 300);
    EXPECT_EQ (cache.size (), 1u);
    cache.clear ();
    EXPECT_EQ (cache.size (), 0u);
    (void)cache.resolve ("example.com", 300);
    EXPECT_EQ (resolver.calls (), 2);
}
