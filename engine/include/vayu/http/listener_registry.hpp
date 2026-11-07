#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/stop_signal.hpp"

#include <atomic>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <expected>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

namespace vayu::http {

// Named, never defined here: this header is included by manager headers that
// stay clear of httplib, and only a member function's body reaches the type.
class ManagedListener;

/**
 * What a `ListenerRegistry` entry carries: the signal its handlers wait on and
 * the listener serving them. `listener` is declared last in the entry, so it is
 * destroyed first (managed_listener.hpp, "Own the listener last").
 *
 * The registry constrains the functions that touch an entry rather than the
 * class, because the managers name `ListenerRegistry<Entry>` in their headers
 * while `Entry` is still incomplete.
 */
template <typename Entry>
concept ListenerEntry = requires (Entry& entry) {
    { entry.stop_signal } -> std::same_as<vayu::utils::StopSignal&>;
    { entry.listener } -> std::same_as<ManagedListener&>;
};

/**
 * End @p entry's listener: wake every handler waiting on its signal, then stop
 * and join. Returns once no handler of this entry is running, so it must not
 * run under a lock a handler takes. Idempotent.
 */
template <ListenerEntry Entry> void retire_listener (Entry& entry) {
    entry.stop_signal.request ();
    entry.listener.stop ();
}

/// Why `ListenerRegistry::reserve` refused a start.
enum class RegistryRefusal : std::uint8_t {
    /// The cap is held by running entries and starts still in progress.
    AtCapacity,
    /// `shutdown()` has run; nothing starts again.
    ShutDown,
};

/**
 * The refusal every manager's start answers once its registry has shut down.
 * @p out is any of the managers' start results; they share these four fields.
 */
template <typename StartResult> void refuse_shut_down (StartResult& out) {
    out.ok            = false;
    out.http_status   = 503;
    out.error_code    = "unavailable";
    out.error_message = "Engine is shutting down";
}

namespace detail {
/// Reports a failed shutdown from the registry's destructor; cannot throw.
void log_registry_shutdown_failure (std::string_view detail) noexcept;
} // namespace detail

/**
 * The running entries of one listener manager (#3345): the map, the one lock
 * over it, the cap, and the terminal shutdown.
 *
 * - **The cap holds under concurrent starts.** `reserve()` counts running
 *   entries and starts still in progress under one lock, and the slot passes to
 *   the entry at `commit`, so no number of simultaneous starts exceeds it.
 * - **Teardown happens outside the lock.** `remove()` erases under the lock and
 *   retires outside it: the retire joins the listener, and a handler still
 *   sleeping there would otherwise stall every caller of the manager.
 *   `with_entries` is the escape hatch for a manager that keeps a stopped
 *   record (an inbox, a settled OAuth attempt); a retire inside it joins under
 *   the lock and is that manager's stated choice.
 * - **Handlers never take this lock.** That is what lets a retire under
 *   `with_entries` join at all.
 * - **`shutdown()` is terminal.** It moves every entry out, signals all of them
 *   and only then joins each, so teardown costs one handler's stop latency
 *   rather than the sum, the shape `SseStreamManager::shutdown` takes. Every
 *   later `reserve` and `commit` is refused.
 */
template <typename Entry> class ListenerRegistry {
    public:
    using Entries = std::map<std::string, std::unique_ptr<Entry>>;

    static constexpr std::size_t UNBOUNDED = std::numeric_limits<std::size_t>::max ();

    /**
     * One start's slot, held from `reserve` to `commit`. Destroyed without a
     * commit (a start that failed after reserving) it frees the slot.
     */
    class Reservation {
        public:
        Reservation (Reservation&& other) noexcept
        : owner_ (std::exchange (other.owner_, nullptr)) {
        }
        ~Reservation () {
            release ();
        }

        Reservation (const Reservation&)            = delete;
        Reservation& operator= (const Reservation&) = delete;
        Reservation& operator= (Reservation&&)      = delete;

        private:
        friend class ListenerRegistry;

        explicit Reservation (ListenerRegistry& owner) noexcept
        : owner_ (&owner) {
        }

        void release () noexcept {
            if (owner_ != nullptr) {
                owner_->reserved_.fetch_sub (1, std::memory_order_acq_rel);
                owner_ = nullptr;
            }
        }

        ListenerRegistry* owner_ = nullptr;
    };

    explicit ListenerRegistry (std::size_t capacity = UNBOUNDED)
    : capacity_ (capacity) {
    }

    /// Shuts down, so the manager owning this registry never leaks a thread.
    ~ListenerRegistry () {
        try {
            shutdown ();
        } catch (const std::exception& e) {
            detail::log_registry_shutdown_failure (e.what ());
        } catch (...) {
            detail::log_registry_shutdown_failure ("unknown exception");
        }
    }

    ListenerRegistry (const ListenerRegistry&)            = delete;
    ListenerRegistry& operator= (const ListenerRegistry&) = delete;
    ListenerRegistry (ListenerRegistry&&)                 = delete;
    ListenerRegistry& operator= (ListenerRegistry&&)      = delete;

    /// Claim a slot before building an entry, so a refused start opens no port.
    std::expected<Reservation, RegistryRefusal> reserve () {
        std::lock_guard<std::mutex> lock (mutex_);
        if (shutting_down_) {
            return std::unexpected (RegistryRefusal::ShutDown);
        }
        if (entries_.size () + reserved_.load (std::memory_order_acquire) >= capacity_) {
            return std::unexpected (RegistryRefusal::AtCapacity);
        }
        reserved_.fetch_add (1, std::memory_order_acq_rel);
        return Reservation (*this);
    }

    /**
     * Insert @p entry under @p id in the slot @p reservation holds. False when
     * `shutdown()` ran since the reservation: the entry has then been retired
     * here, and the start answers `refuse_shut_down`.
     */
    bool commit (Reservation reservation, std::string id, std::unique_ptr<Entry> entry) {
        {
            std::lock_guard<std::mutex> lock (mutex_);
            if (!shutting_down_) {
                // Released under the lock `reserve` counts under, in the same
                // scope as the insert, so no reserve sees the slot twice.
                reservation.release ();
                entries_.insert_or_assign (std::move (id), std::move (entry));
                return true;
            }
        }
        retire_listener (*entry);
        return false;
    }

    /// Erase @p id under the lock and retire it outside. False when no entry
    /// has that id.
    bool remove (const std::string& id) {
        std::unique_ptr<Entry> entry;
        {
            std::lock_guard<std::mutex> lock (mutex_);
            const auto it = entries_.find (id);
            if (it == entries_.end ()) {
                return false;
            }
            entry = std::move (it->second);
            entries_.erase (it);
        }
        retire_listener (*entry);
        return true;
    }

    /**
     * Run @p visit on the entry under @p id, under the lock, and return what it
     * returns; nullopt when no entry has that id. @p visit returns a value.
     */
    template <typename Visit>
    auto with_entry (const std::string& id, Visit&& visit) {
        using Result = std::invoke_result_t<Visit&, Entry&>;
        std::lock_guard<std::mutex> lock (mutex_);
        const auto it = entries_.find (id);
        if (it == entries_.end ()) {
            return std::optional<Result>{};
        }
        return std::optional<Result>{ visit (*it->second) };
    }

    /// Run @p visit over the entries under the lock and return what it returns.
    template <typename Visit> decltype (auto) with_entries (Visit&& visit) {
        std::lock_guard<std::mutex> lock (mutex_);
        return std::forward<Visit> (visit) (entries_);
    }

    template <typename Visit>
    decltype (auto) with_entries (Visit&& visit) const {
        std::lock_guard<std::mutex> lock (mutex_);
        return std::forward<Visit> (visit) (entries_);
    }

    /// Retire every entry and refuse every later start. Idempotent.
    void shutdown () {
        Entries draining;
        {
            std::lock_guard<std::mutex> lock (mutex_);
            shutting_down_ = true;
            draining.swap (entries_);
        }
        for (auto& [id, entry] : draining) {
            entry->stop_signal.request ();
        }
        for (auto& [id, entry] : draining) {
            retire_listener (*entry);
        }
    }

    private:
    const std::size_t capacity_;
    mutable std::mutex mutex_;
    Entries entries_;
    /// Starts between `reserve` and `commit`. Raised and handed to an entry
    /// under `mutex_`; an abandoned reservation lowers it without the lock,
    /// which can only make a concurrent `reserve` refuse at the boundary, never
    /// admit one past the cap.
    std::atomic<std::size_t> reserved_{ 0 };
    bool shutting_down_ = false;
};

} // namespace vayu::http
