/**
 * @file tests/listener_registry_test.cpp
 * @brief `ListenerRegistry` (#3345), the record keeping all four listener
 *        managers share: the cap counted across starts in progress, teardown
 *        outside the lock, and a terminal shutdown that signals every entry
 *        before it joins any.
 *
 * The managers' own suites pin the same rules through their start routes
 * (mock_issuer_test, mock_server_routes_test, inbox_test,
 * oauth_authorize_test); this one drives the registry with entries whose
 * handlers block on purpose.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "optional_assert.hpp"
#include "vayu/http/listener_registry.hpp"
#include "vayu/http/managed_listener.hpp"
#include "vayu/utils/stop_signal.hpp"
#include "wait_until.hpp"

using vayu::http::ListenerRegistry;
using vayu::http::ManagedListener;
using vayu::http::RegistryRefusal;
using vayu::utils::StopSignal;

namespace {

struct TestEntry {
    StopSignal stop_signal;
    ManagedListener listener;
};

using Registry = ListenerRegistry<TestEntry>;

std::size_t entry_count (Registry& registry) {
    return registry.with_entries (
    [] (const auto& entries) { return entries.size (); });
}

/// An entry already listening on an ephemeral loopback port, with a `/block`
/// route that runs @p handler.
std::unique_ptr<TestEntry> listening_entry (std::function<void ()> handler, int& port) {
    auto entry = std::make_unique<TestEntry> ();
    entry->listener.server ().Get ("/block",
    [handler = std::move (handler)] (const httplib::Request&, httplib::Response& res) {
        handler ();
        res.set_content ("done", "text/plain");
    });
    port = entry->listener.start ("127.0.0.1").port;
    return entry;
}

/// Send `GET /block` from a thread of its own; the caller joins it.
std::thread send_block (int port) {
    return std::thread ([port] {
        httplib::Client client ("127.0.0.1", port);
        client.set_read_timeout (std::chrono::seconds (60));
        client.Get ("/block");
    });
}

TEST (ListenerRegistry, AReservationHoldsItsSlotUntilCommittedOrDropped) {
    Registry registry (2);
    auto first = registry.reserve ();
    ASSERT_HAS_VALUE (first);
    {
        const auto second = registry.reserve ();
        ASSERT_HAS_VALUE (second);

        // Nothing is committed yet; the two starts in progress are what fill
        // the cap. Mutation check: count only `entries_.size ()` in `reserve`
        // and this third reservation is admitted.
        const auto third = registry.reserve ();
        ASSERT_FALSE (third.has_value ());
        EXPECT_EQ (third.error (), RegistryRefusal::AtCapacity);
    }
    // The second start failed after reserving, and gave its slot back.
    EXPECT_TRUE (registry.reserve ().has_value ());

    ASSERT_TRUE (
    registry.commit (std::move (*first), "a", std::make_unique<TestEntry> ()));
    EXPECT_EQ (entry_count (registry), 1u);
}

TEST (ListenerRegistry, RemoveJoinsTheListenerWithoutHoldingTheLock) {
    Registry registry;
    StopSignal release;
    std::atomic<bool> entered{ false };
    std::atomic<bool> finished{ false };
    int port   = 0;
    auto entry = listening_entry (
    [&] {
        entered.store (true);
        // Not the entry's own signal, which the remove requests: this has to
        // stay blocked while the remove joins it.
        (void)release.wait_for (vayu::tests::WAIT_DEADLINE);
        finished.store (true);
    },
    port);
    ASSERT_GT (port, 0);
    auto slot = registry.reserve ();
    ASSERT_HAS_VALUE (slot);
    ASSERT_TRUE (registry.commit (std::move (*slot), "busy", std::move (entry)));

    auto caller = send_block (port);
    ASSERT_TRUE (vayu::tests::wait_until ([&] { return entered.load (); }))
    << "the handler never ran";

    std::thread remover ([&] { EXPECT_TRUE (registry.remove ("busy")); });
    // Each poll takes the registry's lock. A remove that joined under it would
    // hold this until the handler's 20s wait ran out, and the handler would be
    // finished by the time the poll first answered.
    ASSERT_TRUE (
    vayu::tests::wait_until ([&] { return entry_count (registry) == 0; }));
    EXPECT_FALSE (finished.load ())
    << "the registry's lock was held for the whole join";

    release.request ();
    remover.join ();
    caller.join ();
    EXPECT_TRUE (finished.load ());
    EXPECT_FALSE (registry.remove ("busy"));
}

TEST (ListenerRegistry, ShutdownSignalsEveryEntryBeforeJoiningAny) {
    // Each handler blocks until the *other* entry is signalled. A shutdown that
    // signals and joins one entry at a time joins the first while its handler
    // still waits on the second's signal, which nothing has requested yet: that
    // handler then runs out its 20s wait and reports it was never signalled.
    // Mutation check: drop the signalling loop from `shutdown` and this fails.
    Registry registry;
    std::vector<std::unique_ptr<TestEntry>> entries;
    entries.push_back (std::make_unique<TestEntry> ());
    entries.push_back (std::make_unique<TestEntry> ());
    std::atomic<int> entered{ 0 };
    std::atomic<bool> first_signalled{ false };
    std::atomic<bool> second_signalled{ false };

    const auto wait_on = [&] (StopSignal& other, std::atomic<bool>& signalled) {
        return [&entered, &other, &signalled] {
            entered.fetch_add (1);
            signalled.store (other.wait_for (vayu::tests::WAIT_DEADLINE));
        };
    };
    std::vector<int> ports (2, 0);
    for (std::size_t i = 0; i < 2; ++i) {
        TestEntry& self  = *entries[i];
        TestEntry& other = *entries[1 - i];
        self.listener.server ().Get ("/block",
        [handler = wait_on (other.stop_signal, i == 0 ? first_signalled : second_signalled)] (
        const httplib::Request&, httplib::Response& res) {
            handler ();
            res.set_content ("done", "text/plain");
        });
        ports[i] = self.listener.start ("127.0.0.1").port;
        ASSERT_GT (ports[i], 0);
    }
    for (std::size_t i = 0; i < 2; ++i) {
        auto slot = registry.reserve ();
        ASSERT_HAS_VALUE (slot);
        ASSERT_TRUE (registry.commit (std::move (*slot),
        "entry_" + std::to_string (i), std::move (entries[i])));
    }

    auto first_caller  = send_block (ports[0]);
    auto second_caller = send_block (ports[1]);
    ASSERT_TRUE (vayu::tests::wait_until ([&] { return entered.load () == 2; }))
    << "both handlers must be in flight before the shutdown";

    registry.shutdown ();
    first_caller.join ();
    second_caller.join ();

    EXPECT_TRUE (first_signalled.load ());
    EXPECT_TRUE (second_signalled.load ());
    EXPECT_EQ (entry_count (registry), 0u);
}

TEST (ListenerRegistry, ShutdownIsTerminalAndIdempotent) {
    Registry registry (4);
    int port   = 0;
    auto entry = listening_entry ([] {}, port);
    ASSERT_GT (port, 0);
    auto slot = registry.reserve ();
    ASSERT_HAS_VALUE (slot);
    ASSERT_TRUE (registry.commit (std::move (*slot), "live", std::move (entry)));

    // A start that reserved before the shutdown and commits after it.
    auto late = registry.reserve ();
    ASSERT_HAS_VALUE (late);

    registry.shutdown ();
    registry.shutdown ();
    EXPECT_EQ (entry_count (registry), 0u);

    httplib::Client client ("127.0.0.1", port);
    client.set_connection_timeout (std::chrono::milliseconds (300));
    EXPECT_FALSE (client.Get ("/block")) << "the entry is still listening";

    const auto refused = registry.reserve ();
    ASSERT_FALSE (refused.has_value ());
    EXPECT_EQ (refused.error (), RegistryRefusal::ShutDown);

    int late_port   = 0;
    auto late_entry = listening_entry ([] {}, late_port);
    ASSERT_GT (late_port, 0);
    EXPECT_FALSE (registry.commit (std::move (*late), "late", std::move (late_entry)));
    EXPECT_EQ (entry_count (registry), 0u);
    httplib::Client late_client ("127.0.0.1", late_port);
    late_client.set_connection_timeout (std::chrono::milliseconds (300));
    EXPECT_FALSE (late_client.Get ("/block"))
    << "a commit refused after shutdown must still stop the listener";
}

} // namespace
