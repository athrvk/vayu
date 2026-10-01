#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file file_ref.hpp
 * @brief Whether a file a request body names may be sent, and what it holds.
 *
 * Two body shapes name a file on this machine: a `binary` body (`Body::file`)
 * and a `form-data` file part (`FormField` with `type == File`). Both answer to
 * one rule, checked here and nowhere else:
 *
 *  1. `src` is not empty ("no file selected");
 *  2. `src` holds no `{{` - composition resolves a path once and the residual
 *     pass never does, so a token left here is an unresolved variable;
 *  3. **trust**: `!unresolved || policy.allows (src)` - a path a person chose in
 *     the editor is sent, and any other path only when it resolves under a
 *     folder the user allowed (`FileAccessPolicy`, `file_roots`);
 *  4. it is a regular file - a directory, a FIFO or `/dev/zero` is refused;
 *  5. this process can open it.
 *
 * Every refusal names the row ("Body file", or the form field's key) and the
 * path, and says what to do.
 *
 * The check runs **once per send** on the design path and **once per run** on
 * the load and collection paths (`FilePlan`), never per transfer. A file at or
 * under `INLINE_FILE_LIMIT` is read in the same pass, and the bytes are shared
 * by every transfer of the run; a larger one is hashed in that pass and
 * streamed from disk per transfer.
 */

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <optional>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <unordered_map>

#include "vayu/http/file_access_policy.hpp"
#include "vayu/types.hpp"

namespace vayu::http {

/**
 * @brief The registered media type a file extension names, or empty.
 *
 * One table for the engine: the binary body's Content-Type default reads it,
 * and so does OpenAPI export. Case-insensitive on the extension; a path with no
 * extension, or one the table does not know, answers empty and the caller
 * falls back to `application/octet-stream`.
 */
[[nodiscard]] std::string_view media_type_for_extension (std::string_view path);

/// The name a binary body's file goes by: `file_name`, else the basename of
/// `src` (both separators, since the path is whatever this machine wrote).
[[nodiscard]] std::string declared_file_name (const FileRef& file);

/// True when the body names at least one file: a `binary` body, or a
/// `form-data` body with an enabled file part.
[[nodiscard]] bool has_file_refs (const Body& body);

/// True when a file reference's path still holds a `{{` - one a data row
/// binds, or one nothing will.
[[nodiscard]] bool has_templated_file_path (const Body& body);

/// True once `FilePlan` has filled the plan-time members of @p file. A binary
/// body that reaches a transfer without them was never checked, and the send
/// gate refuses it (`validate_transferable`).
[[nodiscard]] bool is_prepared (const FileRef& file);

/**
 * @brief The raw-request and trace stand-in for a binary body's bytes:
 * `<file a.bin, 1234 bytes>`. A view of a request never carries the file.
 */
[[nodiscard]] std::string body_file_placeholder (const FileRef& file);

/**
 * @brief Why @p file cannot be sent, by the rule above, or nothing.
 *
 * @param label The row as a person reads it: `"Body file"` or
 *              `"Form field 'avatar'"`.
 */
[[nodiscard]] std::optional<std::string> unsendable_file_ref (const FileRef& file,
std::string_view label,
const FileAccessPolicy& policy);

/**
 * @brief Open @p file for a streamed transfer. Null when it cannot be opened,
 * which the read callback then reports to libcurl as an aborted read.
 */
[[nodiscard]] std::unique_ptr<std::FILE, int (*) (std::FILE*)> open_body_file (
const FileRef& file);

/**
 * @brief How many times this process has opened a request-body file - for a
 * plan's check-and-read, or a streamed transfer. Monotonic; tests read the
 * difference across a send or a run.
 */
[[nodiscard]] std::uint64_t body_file_opens ();

/**
 * @brief The file references of a send or a run, checked once.
 *
 * `prepare` applies the rule to every enabled reference of a request and fills
 * a binary body's plan-time members (`inline_bytes`, `sha256`, `size`), reading
 * each distinct path once for the life of the plan. `fill` is the hot-path half:
 * it answers only from paths `prepare` already checked, so a load run's
 * transfers never touch the filesystem for a small file and never re-check one.
 *
 * Thread-safe: a run prepares on one thread and fills from many.
 */
class FilePlan {
    public:
    explicit FilePlan (FileAccessPolicy policy = {});

    /**
     * Check and read every file @p request names. Nothing on success; the
     * first refusal otherwise, with @p request's binary members untouched.
     */
    [[nodiscard]] std::optional<std::string> prepare (Request& request);

    /**
     * Fill @p request's file references from what `prepare` already checked.
     * A path it never saw is refused rather than read here: on the load path
     * that is a path a per-iteration value produced, which no plan could see.
     */
    [[nodiscard]] std::optional<std::string> fill (Request& request) const;

    /**
     * Apply the rule to one reference; @p needs_bytes also reads (or hashes) it,
     * which only a binary body needs. Cached by `src` like `prepare`.
     */
    [[nodiscard]] std::optional<std::string>
    check (const FileRef& file, std::string_view label, bool needs_bytes);

    [[nodiscard]] const FileAccessPolicy& policy () const {
        return policy_;
    }

    private:
    struct Checked {
        bool under_root = false;
        bool read       = false; // bytes or hash taken (a binary body's need)
        std::shared_ptr<const std::string> inline_bytes;
        std::string sha256;
        std::uint64_t size = 0;
    };

    std::optional<std::string>
    check_locked (const FileRef& file, std::string_view label, bool needs_bytes);
    std::optional<std::string>
    fill_one (FileRef& file, std::string_view label, bool needs_bytes) const;

    FileAccessPolicy policy_;
    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, Checked> by_src_;
};

/// The label a form-data file part's refusal names it by.
[[nodiscard]] std::string form_part_label (const FormField& field);

/// The view of a form-data file part the shared rule reads.
[[nodiscard]] FileRef file_ref_of (const FormField& field);

} // namespace vayu::http
