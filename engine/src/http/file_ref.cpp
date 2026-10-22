/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/file_ref.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <filesystem>
#include <mutex>
#include <system_error>
#include <utility>

#include "vayu/http/form_body.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/reentrant.hpp"
#include "vayu/utils/sha256.hpp"

namespace vayu::http {

namespace fs = std::filesystem;

namespace {

struct MediaType {
    std::string_view extension;
    std::string_view type;
};

// Lower-case extensions without the dot. The common payload types an API
// accepts as a whole-file body or a part, not an exhaustive registry: a type
// that is missing falls back to `application/octet-stream`, which a server
// that cares will name in its own contract.
constexpr auto MEDIA_TYPES = std::to_array<MediaType> ({
{ "json", "application/json" },
{ "xml", "application/xml" },
{ "txt", "text/plain" },
{ "csv", "text/csv" },
{ "tsv", "text/tab-separated-values" },
{ "html", "text/html" },
{ "htm", "text/html" },
{ "css", "text/css" },
{ "js", "text/javascript" },
{ "mjs", "text/javascript" },
{ "md", "text/markdown" },
{ "yaml", "application/yaml" },
{ "yml", "application/yaml" },
{ "ndjson", "application/x-ndjson" },
{ "graphql", "application/graphql" },
{ "pdf", "application/pdf" },
{ "rtf", "application/rtf" },
{ "zip", "application/zip" },
{ "gz", "application/gzip" },
{ "tar", "application/x-tar" },
{ "7z", "application/x-7z-compressed" },
{ "bz2", "application/x-bzip2" },
{ "xz", "application/x-xz" },
{ "zst", "application/zstd" },
{ "wasm", "application/wasm" },
{ "bin", "application/octet-stream" },
{ "doc", "application/msword" },
{ "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
{ "xls", "application/vnd.ms-excel" },
{ "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
{ "ppt", "application/vnd.ms-powerpoint" },
{ "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
{ "png", "image/png" },
{ "jpg", "image/jpeg" },
{ "jpeg", "image/jpeg" },
{ "gif", "image/gif" },
{ "webp", "image/webp" },
{ "svg", "image/svg+xml" },
{ "ico", "image/vnd.microsoft.icon" },
{ "bmp", "image/bmp" },
{ "tif", "image/tiff" },
{ "tiff", "image/tiff" },
{ "avif", "image/avif" },
{ "heic", "image/heic" },
{ "mp3", "audio/mpeg" },
{ "wav", "audio/wav" },
{ "ogg", "audio/ogg" },
{ "flac", "audio/flac" },
{ "m4a", "audio/mp4" },
{ "mp4", "video/mp4" },
{ "webm", "video/webm" },
{ "mov", "video/quicktime" },
{ "avi", "video/x-msvideo" },
{ "mkv", "video/x-matroska" },
{ "woff", "font/woff" },
{ "woff2", "font/woff2" },
{ "ttf", "font/ttf" },
{ "otf", "font/otf" },
});

/// The label a binary body's refusal names it by.
constexpr std::string_view BODY_FILE_LABEL = "Body file";

std::atomic<std::uint64_t>& open_counter () {
    static std::atomic<std::uint64_t> opens{ 0 };
    return opens;
}

std::string basename_of (const std::string& path) {
    const auto slash = path.find_last_of ("/\\");
    return slash == std::string::npos ? path : path.substr (slash + 1);
}

// The two refusals that need no filesystem: they are about the text of `src`.
std::optional<std::string> refuse_shape (const FileRef& file, std::string_view label) {
    if (file.src.empty ()) {
        return std::string (label) +
        " has no file selected - choose a file in the request, or remove it";
    }
    if (file.src.find ("{{") != std::string::npos) {
        return std::string (label) + " path '" + file.src +
        "' still holds an unresolved variable - define the variable, or choose "
        "the file in the request";
    }
    return std::nullopt;
}

std::string untrusted_message (const FileRef& file, std::string_view label) {
    return std::string (label) + " '" + file.src +
    "' was not picked on this machine and is not under an allowed folder - "
    "pick it again in the request, or allow its folder in Settings > Files";
}

std::string unreadable_message (const FileRef& file, std::string_view label, std::string_view reason) {
    return std::string (label) + ": cannot read file '" + file.src + "' (" +
    std::string (reason) + ")";
}

std::string unreadable_message (const FileRef& file, std::string_view label, int error) {
    return unreadable_message (file, label, vayu::utils::errno_message (error));
}

/// A fill for a path the plan never checked: on the load path, one a
/// per-iteration value produced, which no plan could see.
std::string not_planned_message (const std::string& src, std::string_view label) {
    return std::string (label) + " '" + src +
    "' was not checked when the run started - a file path may take a data "
    "column, but not a value that changes per iteration";
}

std::string unplanned_message (const std::string& src, std::string_view label) {
    return std::string (label) + " '" + src +
    "' was not checked before the send - this driver skipped the file rule";
}

/// What the plan takes from a binary body's file: its bytes when they fit
/// inline, and their digest either way.
struct Contents {
    std::shared_ptr<const std::string> inline_bytes;
    std::string sha256;
};

/// The whole of @p file as its open saw it, read through that one handle, or
/// why it could not be read.
std::expected<Contents, std::string> read_contents (const ApprovedFile& file) {
    constexpr std::size_t CHUNK = std::size_t{ 64 } * 1024;
    const bool keeps_bytes      = file.size () <= INLINE_FILE_LIMIT;
    std::string chunk (CHUNK, '\0');
    std::string whole;
    vayu::utils::Sha256Stream hash;
    for (std::uint64_t offset = 0; offset < file.size ();) {
        const auto wanted = static_cast<std::size_t> (
        std::min<std::uint64_t> (CHUNK, file.size () - offset));
        const auto got = file.read_at (offset, std::span<char> (chunk.data (), wanted));
        if (!got) {
            return std::unexpected (got.error ().message ());
        }
        // Shorter than its open measured: whatever is read now is not the
        // file the size describes.
        if (*got == 0) {
            return std::unexpected (
            std::string ("it was truncated while being read"));
        }
        const std::string_view piece (chunk.data (), *got);
        hash.update (piece);
        if (keeps_bytes) {
            whole.append (piece);
        }
        offset += *got;
    }
    const auto digest = hash.finish ();
    Contents out;
    // Assigned in place rather than move-assigned from a temporary: GCC 13 at
    // -O3 reports the inlined small-string move as an out-of-bounds memcpy
    // (-Warray-bounds), a false positive that fails the -Werror release build.
    const std::string hex = vayu::utils::hex_encode (vayu::utils::byte_view (digest));
    out.sha256.assign (hex);
    if (keeps_bytes) {
        out.inline_bytes = std::make_shared<const std::string> (std::move (whole));
    }
    return out;
}

} // namespace

std::string_view media_type_for_extension (std::string_view path) {
    const auto slash = path.find_last_of ("/\\");
    const std::string_view name =
    slash == std::string_view::npos ? path : path.substr (slash + 1);
    const auto dot = name.rfind ('.');
    if (dot == std::string_view::npos || dot + 1 >= name.size ()) {
        return {};
    }
    const std::string extension = vayu::utils::ascii_lower (name.substr (dot + 1));
    for (const auto& entry : MEDIA_TYPES) {
        if (entry.extension == extension) {
            return entry.type;
        }
    }
    return {};
}

std::string declared_file_name (const FileRef& file) {
    return file.file_name.empty () ? basename_of (file.src) : file.file_name;
}

bool has_file_refs (const Body& body) {
    return body.mode == BodyMode::Binary || has_file_parts (body);
}

bool has_templated_file_path (const Body& body) {
    const auto templated = [] (const std::string& src) {
        return src.find ("{{") != std::string::npos;
    };
    if (body.mode == BodyMode::Binary) {
        return templated (body.file.src);
    }
    if (!has_file_parts (body)) {
        return false;
    }
    return std::any_of (
    body.fields.begin (), body.fields.end (), [&] (const FormField& field) {
        return field.enabled && field.type == FormFieldType::File &&
        templated (field.src);
    });
}

bool is_prepared (const FileRef& file) {
    return file.inline_bytes != nullptr || file.approved != nullptr;
}

std::optional<std::string> unplanned_file_ref (const Body& body) {
    if (body.mode == BodyMode::Binary) {
        if (is_prepared (body.file)) {
            return std::nullopt;
        }
        return unplanned_message (body.file.src, BODY_FILE_LABEL);
    }
    if (!has_file_parts (body)) {
        return std::nullopt;
    }
    for (const auto& field : body.fields) {
        if (field.enabled && field.type == FormFieldType::File && !field.approved) {
            return unplanned_message (field.src, form_part_label (field));
        }
    }
    return std::nullopt;
}

std::string body_file_placeholder (const FileRef& file) {
    return "<file " + declared_file_name (file) + ", " + std::to_string (file.size) + " bytes>";
}

std::string form_part_label (const FormField& field) {
    return "Form field '" +
    (field.key.empty () ? std::string{ "(unnamed)" } : field.key) + "'";
}

FileRef file_ref_of (const FormField& field) {
    FileRef ref;
    ref.src          = field.src;
    ref.file_name    = field.file_name;
    ref.content_type = field.content_type;
    return ref;
}

std::optional<std::string> unsendable_file_ref (const FileRef& file,
std::string_view label,
const FileAccessPolicy& policy) {
    FilePlan plan (policy);
    return plan.check (file, label, false);
}

std::uint64_t body_file_opens () {
    return open_counter ().load (std::memory_order_relaxed);
}

std::expected<std::shared_ptr<const ApprovedFile>, std::string>
ApprovedFile::open (const fs::path& canonical) {
    open_counter ().fetch_add (1, std::memory_order_relaxed);
    auto opened = platform::open_regular_file (canonical);
    if (!opened) {
        return std::unexpected (opened.error ().message ());
    }
    return std::make_shared<const ApprovedFile> (*opened);
}

ApprovedFile::ApprovedFile (platform::OpenedFile opened)
: file_ (opened.file), size_ (opened.size) {
}

ApprovedFile::~ApprovedFile () {
    platform::close_file (file_);
}

std::expected<std::size_t, std::error_code>
ApprovedFile::read_at (std::uint64_t offset, std::span<char> buffer) const {
    return platform::read_file_at (file_, offset, buffer);
}

FilePlan::FilePlan (FileAccessPolicy policy) : policy_ (std::move (policy)) {
}

std::size_t FilePlan::kept_files () const {
    const std::shared_lock lock (mutex_);
    return kept_.size ();
}

std::optional<std::string>
FilePlan::check (const FileRef& file, std::string_view label, bool needs_bytes) {
    const std::unique_lock lock (mutex_);
    return check_locked (file, label, needs_bytes);
}

const FilePlan::Checked* FilePlan::checked (const std::string& src, bool needs_bytes) const {
    const auto found = by_src_.find (src);
    if (found == by_src_.end () || !found->second.serves (needs_bytes)) {
        return nullptr;
    }
    return &found->second;
}

std::expected<fs::path, std::string>
FilePlan::approve (const FileRef& file, std::string_view label) const {
    std::error_code ec;
    const fs::file_status status = fs::status (fs::path (file.src), ec);
    if (ec || !fs::exists (status)) {
        return std::unexpected (unreadable_message (file, label, ec ? ec.value () : ENOENT));
    }
    // Decided before the file is opened: a path the policy does not allow is
    // never read at all.
    auto canonical = policy_.approved_path (file.src);
    if (!canonical) {
        return std::unexpected (untrusted_message (file, label));
    }
    if (!fs::is_regular_file (status)) {
        return std::unexpected (std::string (label) + " '" + file.src +
        "' is not a regular file - a directory, device or pipe cannot be sent");
    }
    return std::move (*canonical);
}

std::optional<std::string>
FilePlan::check_locked (const FileRef& file, std::string_view label, bool needs_bytes) {
    if (auto refusal = refuse_shape (file, label)) {
        return refusal;
    }
    if (checked (file.src, needs_bytes) != nullptr) {
        return std::nullopt;
    }
    auto opened = needs_bytes ? read_body_file (file, label) : open_approved (file, label);
    if (!opened) {
        return std::move (opened.error ());
    }
    return std::nullopt;
}

FilePlan::Opened FilePlan::open_approved (const FileRef& file, std::string_view label) {
    auto canonical = approve (file, label);
    if (!canonical) {
        return std::unexpected (std::move (canonical.error ()));
    }
    std::string key = canonical->string ();
    std::shared_ptr<const ApprovedFile> opened;
    if (const auto kept = kept_.find (key); kept != kept_.end ()) {
        opened = kept->second;
    } else {
        auto fresh = ApprovedFile::open (*canonical);
        if (!fresh) {
            return std::unexpected (unreadable_message (file, label, fresh.error ()));
        }
        opened = std::move (*fresh);
    }
    by_src_[file.src].canonical = std::move (key);
    return opened;
}

FilePlan::Opened
FilePlan::reopen (const FileRef& file, std::string_view label, const Checked& planned) const {
    if (const auto kept = kept_.find (planned.canonical); kept != kept_.end ()) {
        return kept->second;
    }
    // Approved, not kept: a path a data row bound. Opened for this request
    // alone, through the rule again, so the run holds nothing per row.
    auto canonical = approve (file, label);
    if (!canonical) {
        return std::unexpected (std::move (canonical.error ()));
    }
    auto opened = ApprovedFile::open (*canonical);
    if (!opened) {
        return std::unexpected (unreadable_message (file, label, opened.error ()));
    }
    return opened;
}

void FilePlan::keep (const Checked& planned,
const std::shared_ptr<const ApprovedFile>& opened) {
    kept_.emplace (planned.canonical, opened);
}

FilePlan::Opened FilePlan::read_body_file (const FileRef& file, std::string_view label) {
    auto opened = open_approved (file, label);
    if (!opened) {
        return opened;
    }
    auto contents = read_contents (**opened);
    if (!contents) {
        return std::unexpected (unreadable_message (file, label, contents.error ()));
    }
    Checked& entry     = by_src_[file.src];
    entry.inline_bytes = std::move (contents->inline_bytes);
    entry.sha256       = std::move (contents->sha256);
    entry.size         = (*opened)->size ();
    entry.read         = true;
    return opened;
}

std::optional<std::string> FilePlan::prepare_body_file (FileRef& file, OpenFiles open_files) {
    if (auto refusal = refuse_shape (file, BODY_FILE_LABEL)) {
        return refusal;
    }
    const Checked* planned = checked (file.src, true);
    if (planned != nullptr &&
    (planned->inline_bytes || open_files == OpenFiles::PerRequest ||
    kept_.contains (planned->canonical))) {
        return fill_body_file (file);
    }
    auto opened = read_body_file (file, BODY_FILE_LABEL);
    if (!opened) {
        return std::move (opened.error ());
    }
    const Checked& entry = by_src_.at (file.src);
    file.inline_bytes    = entry.inline_bytes;
    file.sha256          = entry.sha256;
    file.size            = entry.size;
    // Read inline, the bytes are what every transfer sends and the file is
    // done with; streamed, every transfer reads the file this read approved.
    file.approved = entry.inline_bytes ? nullptr : std::move (*opened);
    if (file.approved && open_files == OpenFiles::KeptByPlan) {
        keep (entry, file.approved);
    }
    return std::nullopt;
}

std::optional<std::string> FilePlan::prepare_part (FormField& field, OpenFiles open_files) {
    const FileRef ref       = file_ref_of (field);
    const std::string label = form_part_label (field);
    if (auto refusal = refuse_shape (ref, label)) {
        return refusal;
    }
    const Checked* planned = checked (field.src, false);
    if (planned != nullptr &&
    (open_files == OpenFiles::PerRequest || kept_.contains (planned->canonical))) {
        return fill_part (field);
    }
    auto opened = open_approved (ref, label);
    if (!opened) {
        return std::move (opened.error ());
    }
    if (open_files == OpenFiles::KeptByPlan) {
        keep (by_src_.at (field.src), *opened);
    }
    field.approved = std::move (*opened);
    return std::nullopt;
}

std::optional<std::string> FilePlan::fill_body_file (FileRef& file) const {
    if (auto refusal = refuse_shape (file, BODY_FILE_LABEL)) {
        return refusal;
    }
    const Checked* planned = checked (file.src, true);
    if (planned == nullptr) {
        return not_planned_message (file.src, BODY_FILE_LABEL);
    }
    std::shared_ptr<const ApprovedFile> approved;
    if (!planned->inline_bytes) {
        auto opened = reopen (file, BODY_FILE_LABEL, *planned);
        if (!opened) {
            return std::move (opened.error ());
        }
        approved = std::move (*opened);
    }
    file.inline_bytes = planned->inline_bytes;
    file.sha256       = planned->sha256;
    file.size         = planned->size;
    file.approved     = std::move (approved);
    return std::nullopt;
}

std::optional<std::string> FilePlan::fill_part (FormField& field) const {
    const FileRef ref       = file_ref_of (field);
    const std::string label = form_part_label (field);
    if (auto refusal = refuse_shape (ref, label)) {
        return refusal;
    }
    const Checked* planned = checked (field.src, false);
    if (planned == nullptr) {
        return not_planned_message (field.src, label);
    }
    auto opened = reopen (ref, label, *planned);
    if (!opened) {
        return std::move (opened.error ());
    }
    field.approved = std::move (*opened);
    return std::nullopt;
}

std::optional<std::string> FilePlan::prepare (Request& request, OpenFiles open_files) {
    const std::unique_lock lock (mutex_);
    Body& body = request.body;
    if (body.mode == BodyMode::Binary) {
        return prepare_body_file (body.file, open_files);
    }
    if (!has_file_parts (body)) {
        return std::nullopt;
    }
    for (auto& field : body.fields) {
        if (!field.enabled || field.type != FormFieldType::File) {
            continue;
        }
        if (auto refusal = prepare_part (field, open_files)) {
            return refusal;
        }
    }
    return std::nullopt;
}

std::optional<std::string> FilePlan::fill (Request& request) const {
    const std::shared_lock lock (mutex_);
    Body& body = request.body;
    if (body.mode == BodyMode::Binary) {
        return fill_body_file (body.file);
    }
    if (!has_file_parts (body)) {
        return std::nullopt;
    }
    for (auto& field : body.fields) {
        if (!field.enabled || field.type != FormFieldType::File) {
            continue;
        }
        if (auto refusal = fill_part (field)) {
            return refusal;
        }
    }
    return std::nullopt;
}

} // namespace vayu::http
