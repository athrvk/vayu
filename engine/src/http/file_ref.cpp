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

std::atomic<std::uint64_t>& open_counter () {
    static std::atomic<std::uint64_t> opens{ 0 };
    return opens;
}

using FileHandle = std::unique_ptr<std::FILE, int (*) (std::FILE*)>;

FileHandle open_counted (const std::string& path) {
    open_counter ().fetch_add (1, std::memory_order_relaxed);
    return { std::fopen (path.c_str (), "rb"), &std::fclose };
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

/// The bytes of an inline-sized file, or its hash and size streamed, off one
/// open handle. `false` when a read failed; `errno` then says why.
bool read_contents (std::FILE* handle,
std::shared_ptr<const std::string>& bytes_out,
std::string& sha_out,
std::uint64_t& size_out) {
    constexpr std::size_t CHUNK = std::size_t{ 64 } * 1024;
    std::string chunk (CHUNK, '\0');
    std::string whole;
    vayu::utils::Sha256Stream hash;
    std::uint64_t total = 0;
    bool inline_ok      = true;
    while (std::feof (handle) == 0) {
        const std::size_t got = std::fread (chunk.data (), 1, chunk.size (), handle);
        if (std::ferror (handle) != 0) {
            return false;
        }
        const std::string_view piece (chunk.data (), got);
        hash.update (piece);
        total += got;
        if (inline_ok && whole.size () + got <= INLINE_FILE_LIMIT) {
            whole.append (piece);
        } else if (inline_ok) {
            inline_ok = false;
            whole.clear ();
            whole.shrink_to_fit ();
        }
    }
    const auto digest = hash.finish ();
    // Assigned in place rather than move-assigned from a temporary: GCC 13 at
    // -O3 reports the inlined small-string move as an out-of-bounds memcpy
    // (-Warray-bounds), a false positive that fails the -Werror release build.
    const std::string hex = vayu::utils::hex_encode (vayu::utils::byte_view (digest));
    sha_out.assign (hex);
    size_out = total;
    if (inline_ok) {
        bytes_out = std::make_shared<const std::string> (std::move (whole));
    }
    return true;
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
    return file.inline_bytes != nullptr || !file.sha256.empty ();
}

std::optional<std::string> unplanned_file_ref (const Body& body) {
    if (body.mode == BodyMode::Binary) {
        if (is_prepared (body.file)) {
            return std::nullopt;
        }
        return unplanned_message (body.file.src, "Body file");
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

FileHandle open_body_file (const FileRef& file) {
    return open_counted (file.src);
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

std::optional<std::size_t>
ApprovedFile::read_at (std::uint64_t offset, std::span<char> buffer) const {
    const auto got = platform::read_file_at (file_, offset, buffer);
    if (!got) {
        return std::nullopt;
    }
    return *got;
}

FilePlan::FilePlan (FileAccessPolicy policy) : policy_ (std::move (policy)) {
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

std::optional<std::string>
FilePlan::check_locked (const FileRef& file, std::string_view label, bool needs_bytes) {
    if (auto refusal = refuse_shape (file, label)) {
        return refusal;
    }
    if (checked (file.src, needs_bytes) != nullptr) {
        return std::nullopt;
    }

    std::error_code ec;
    const fs::file_status status = fs::status (fs::path (file.src), ec);
    if (ec || !fs::exists (status)) {
        return unreadable_message (file, label, ec ? ec.value () : ENOENT);
    }
    // Decided before the file is opened: a path the policy does not allow is
    // never read at all.
    const auto canonical = policy_.approved_path (file.src);
    if (!canonical) {
        return untrusted_message (file, label);
    }
    if (!fs::is_regular_file (status)) {
        return std::string (label) + " '" + file.src +
        "' is not a regular file - a directory, device or pipe cannot be sent";
    }
    return needs_bytes ? read_body_file (file, label) :
                         open_part_file (file, label, *canonical);
}

std::optional<std::string>
FilePlan::read_body_file (const FileRef& file, std::string_view label) {
    const FileHandle handle = open_counted (file.src);
    if (!handle) {
        return unreadable_message (file, label, errno);
    }
    std::shared_ptr<const std::string> bytes;
    std::string sha256;
    std::uint64_t size = 0;
    if (!read_contents (handle.get (), bytes, sha256, size)) {
        return unreadable_message (file, label, errno);
    }
    Checked& entry     = by_src_[file.src];
    entry.inline_bytes = std::move (bytes);
    entry.sha256       = std::move (sha256);
    entry.size         = size;
    entry.read         = true;
    return std::nullopt;
}

std::optional<std::string> FilePlan::open_part_file (const FileRef& file,
std::string_view label,
const fs::path& canonical) {
    auto approved = ApprovedFile::open (canonical);
    if (!approved) {
        return unreadable_message (file, label, approved.error ());
    }
    by_src_[file.src].approved = std::move (*approved);
    return std::nullopt;
}

std::optional<std::string> FilePlan::fill_body_file (FileRef& file) const {
    if (auto refusal = refuse_shape (file, "Body file")) {
        return refusal;
    }
    const Checked* planned = checked (file.src, true);
    if (planned == nullptr) {
        return not_planned_message (file.src, "Body file");
    }
    file.inline_bytes = planned->inline_bytes;
    file.sha256       = planned->sha256;
    file.size         = planned->size;
    return std::nullopt;
}

std::optional<std::string> FilePlan::fill_part (FormField& field) const {
    const std::string label = form_part_label (field);
    if (auto refusal = refuse_shape (file_ref_of (field), label)) {
        return refusal;
    }
    const Checked* planned = checked (field.src, false);
    if (planned == nullptr) {
        return not_planned_message (field.src, label);
    }
    field.approved = planned->approved;
    return std::nullopt;
}

std::optional<std::string> FilePlan::prepare (Request& request) {
    const std::unique_lock lock (mutex_);
    Body& body = request.body;
    if (body.mode == BodyMode::Binary) {
        if (auto refusal = check_locked (body.file, "Body file", true)) {
            return refusal;
        }
        return fill_body_file (body.file);
    }
    if (!has_file_parts (body)) {
        return std::nullopt;
    }
    for (auto& field : body.fields) {
        if (!field.enabled || field.type != FormFieldType::File) {
            continue;
        }
        if (auto refusal =
            check_locked (file_ref_of (field), form_part_label (field), false)) {
            return refusal;
        }
        if (auto refusal = fill_part (field)) {
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
