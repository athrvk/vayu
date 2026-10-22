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
 *  3. **trust**: `policy.allows (src)` - the path resolves under a folder the
 *     user allowed (`file_roots`) or to a file a person picked (`file_grants`),
 *     both held by `FileAccessPolicy` (#2356). Nothing in the request decides
 *     this: a body's `unresolved` member is ignored on the way in and derived
 *     on the way out (`vayu::json::derive_file_trust`);
 *  4. it is a regular file - a directory, a FIFO or `/dev/zero` is refused;
 *  5. this process can open it.
 *
 * Every refusal names the row ("Body file", or the form field's key) and the
 * path, and says what to do.
 *
 * The check runs **once per send** on the design path and **once per run** on
 * the load and collection paths (`FilePlan`), never per transfer. For a binary
 * body, a file at or under `INLINE_FILE_LIMIT` is read in the same pass, and
 * the bytes are shared by every transfer of the run; a larger one is hashed in
 * that pass and streamed from disk per transfer. A form-data file part is
 * opened in that pass (`ApprovedFile`) and every transfer reads that open file.
 */

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <shared_mutex>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>

#include "vayu/http/file_access_policy.hpp"
#include "vayu/platform/platform.hpp"
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

/// True once `FilePlan` has filled the plan-time members of @p file.
[[nodiscard]] bool is_prepared (const FileRef& file);

/**
 * @brief Why @p body cannot reach a transfer because no plan checked a file it
 * names, or nothing.
 *
 * A binary body without its plan-time members, or an enabled file part without
 * `approved`, never went through the rule, so the send gate
 * (`validate_transferable`) refuses it rather than read the path on its behalf.
 */
[[nodiscard]] std::optional<std::string> unplanned_file_ref (const Body& body);

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
 * plan's check-and-read, a part's `ApprovedFile`, or a streamed transfer.
 * Monotonic; tests read the difference across a send or a run.
 */
[[nodiscard]] std::uint64_t body_file_opens ();

/**
 * @brief A form-data file part's file, opened when the rule approved it (#2416).
 *
 * Opened on the canonical path the policy approved
 * (`FileAccessPolicy::approved_path`), never on `src` again, and without
 * following a final symlink (`platform::open_regular_file`), so a link swapped
 * in at the path after the check, or between a run's iterations, is not what a
 * transfer reads. Shared by every copy of the request it was opened for (and
 * kept by the plan when `PartFiles::KeptByPlan` says so); reads are
 * positional, so concurrent transfers share no position.
 * The size is the one the open saw, and a transfer sends exactly that many
 * bytes.
 */
class ApprovedFile {
    public:
    /// @p canonical opened, or why it could not be.
    [[nodiscard]] static std::expected<std::shared_ptr<const ApprovedFile>, std::string>
    open (const std::filesystem::path& canonical);

    /// Takes ownership of @p opened's file.
    explicit ApprovedFile (platform::OpenedFile opened);
    ~ApprovedFile ();
    ApprovedFile (const ApprovedFile&)            = delete;
    ApprovedFile& operator= (const ApprovedFile&) = delete;
    ApprovedFile (ApprovedFile&&)                 = delete;
    ApprovedFile& operator= (ApprovedFile&&)      = delete;

    [[nodiscard]] std::uint64_t size () const {
        return size_;
    }

    /// Up to @p buffer's size at @p offset: the count read, 0 at the end, or
    /// nothing on a read error.
    [[nodiscard]] std::optional<std::size_t>
    read_at (std::uint64_t offset, std::span<char> buffer) const;

    private:
    platform::ReadOnlyFile file_;
    std::uint64_t size_;
};

/// Who holds a file part's open file after `FilePlan::prepare`.
enum class PartFiles : std::uint8_t {
    /// The prepared request only: the file closes with the last copy of it.
    PerRequest,
    /// The plan too, for the run: `fill` shares it with every request.
    KeptByPlan,
};

/**
 * @brief The file references of a send or a run, checked once.
 *
 * `prepare` applies the rule to every enabled reference of a request and fills
 * its plan-time members (a binary body's `inline_bytes`, `sha256`, `size`; a
 * file part's `approved`), reading each distinct binary path once for the life
 * of the plan. `fill` is the hot-path half: it answers only from paths
 * `prepare` already checked, so a load run's transfers never re-check a file
 * and never open a small binary body.
 *
 * A file part's open file is kept by the plan only for a path the run's own
 * request names (`PartFiles::KeptByPlan`), so every transfer of the run shares
 * one; a path a data row binds is approved without being kept, and `fill`
 * opens it again for that request alone, through the policy again (#2416). A
 * plan over a data file of many rows therefore holds no file open per row.
 *
 * Thread-safe: a run prepares on one thread and fills from many.
 */
class FilePlan {
    public:
    explicit FilePlan (FileAccessPolicy policy = {});

    /**
     * Check and read every file @p request names, and open its file parts.
     * Nothing on success; the first refusal otherwise, with @p request's
     * binary members untouched. @p part_files says whether the plan keeps
     * the parts' open files for later `fill`s.
     */
    [[nodiscard]] std::optional<std::string>
    prepare (Request& request, PartFiles part_files = PartFiles::PerRequest);

    /**
     * Fill @p request's file references from what `prepare` already checked.
     * A path it never saw is refused rather than read here: on the load path
     * that is a path a per-iteration value produced, which no plan could see.
     */
    [[nodiscard]] std::optional<std::string> fill (Request& request) const;

    /**
     * Apply the rule to one reference; @p needs_bytes reads (or hashes) it, as
     * a binary body needs, and otherwise opens and closes it, as a file part
     * needs. Cached by `src` like `prepare`.
     */
    [[nodiscard]] std::optional<std::string>
    check (const FileRef& file, std::string_view label, bool needs_bytes);

    [[nodiscard]] const FileAccessPolicy& policy () const {
        return policy_;
    }

    /// How many file parts' open files the plan itself keeps.
    [[nodiscard]] std::size_t kept_files () const;

    private:
    /// A path that passed the whole rule; one the policy refused is never
    /// cached, so a hit needs no second trust check. One path can serve both
    /// needs, a binary body in one step and a file part in another.
    struct Checked {
        bool read = false; // bytes or hash taken (a binary body's need)
        std::shared_ptr<const std::string> inline_bytes;
        std::string sha256;
        std::uint64_t size = 0;
        std::string canonical; // a file part's approval: what it resolved to

        [[nodiscard]] bool serves (bool needs_bytes) const {
            return needs_bytes ? read : !canonical.empty ();
        }
    };

    [[nodiscard]] std::expected<std::filesystem::path, std::string>
    approve (const FileRef& file, std::string_view label) const;
    std::optional<std::string>
    check_locked (const FileRef& file, std::string_view label, bool needs_bytes);
    [[nodiscard]] const Checked* checked (const std::string& src, bool needs_bytes) const;
    std::optional<std::string> read_body_file (const FileRef& file, std::string_view label);
    std::expected<std::shared_ptr<const ApprovedFile>, std::string>
    open_part_file (const FileRef& file, std::string_view label, PartFiles part_files);
    std::optional<std::string> prepare_part (FormField& field, PartFiles part_files);
    std::optional<std::string> fill_body_file (FileRef& file) const;
    std::optional<std::string> fill_part (FormField& field) const;

    FileAccessPolicy policy_;
    mutable std::shared_mutex mutex_;
    std::unordered_map<std::string, Checked> by_src_;
    /// The open files `PartFiles::KeptByPlan` keeps, by canonical path, so
    /// two spellings of one file share one.
    std::unordered_map<std::string, std::shared_ptr<const ApprovedFile>> kept_;
};

/// The label a form-data file part's refusal names it by.
[[nodiscard]] std::string form_part_label (const FormField& field);

/// The view of a form-data file part the shared rule reads.
[[nodiscard]] FileRef file_ref_of (const FormField& field);

} // namespace vayu::http
