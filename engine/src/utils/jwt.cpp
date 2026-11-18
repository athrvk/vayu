/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/jwt.hpp"

#include <nlohmann/json.hpp>
#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/crypto.h>
#include <openssl/ecdsa.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <utility>
#include <vector>

#include "vayu/utils/encoding.hpp"
#include "vayu/utils/sodium_init.hpp"

namespace vayu::utils {

namespace {

enum class Algorithm : std::uint8_t { Rs256, Es256 };

constexpr int MIN_RSA_BITS           = 2048;
constexpr std::size_t PEM_LINE_WIDTH = 64;
// An ES256 signature is r and s, each a 32-byte big-endian integer (RFC 7518
// section 3.4).
constexpr std::size_t ES256_COORDINATE_BYTES = 32;

constexpr std::string_view BEGIN_MARK        = "-----BEGIN ";
constexpr std::string_view END_MARK          = "-----END ";
constexpr std::string_view DASHES            = "-----";
constexpr std::string_view PRIVATE_KEY_LABEL = "PRIVATE KEY";

/// Frees through `OPENSSL_cleanse` first, so every buffer holding key text is
/// zeroed whichever way it grew, was moved or was dropped.
template <typename T> struct CleansingAllocator {
    using value_type = T;

    CleansingAllocator () = default;
    template <typename U>
    // NOLINTNEXTLINE(google-explicit-constructor,hicpp-explicit-conversions)
    CleansingAllocator (const CleansingAllocator<U>& /*other*/) noexcept {
    }

    [[nodiscard]] T* allocate (std::size_t count) {
        return std::allocator<T>{}.allocate (count);
    }
    void deallocate (T* pointer, std::size_t count) noexcept {
        OPENSSL_cleanse (pointer, count * sizeof (T));
        std::allocator<T>{}.deallocate (pointer, count);
    }

    friend bool operator== (const CleansingAllocator& /*a*/,
    const CleansingAllocator& /*b*/) noexcept {
        return true;
    }
};

using SecretString =
std::basic_string<char, std::char_traits<char>, CleansingAllocator<char>>;

struct BioFree {
    void operator() (BIO* bio) const noexcept {
        BIO_free (bio);
    }
};
struct KeyFree {
    void operator() (EVP_PKEY* key) const noexcept {
        EVP_PKEY_free (key);
    }
};
struct DigestContextFree {
    void operator() (EVP_MD_CTX* context) const noexcept {
        EVP_MD_CTX_free (context);
    }
};
struct SignatureFree {
    void operator() (ECDSA_SIG* signature) const noexcept {
        ECDSA_SIG_free (signature);
    }
};

using KeyPtr = std::unique_ptr<EVP_PKEY, KeyFree>;

std::unexpected<SignError> refuse (std::string message) {
    return std::unexpected (SignError{ std::move (message) });
}

std::optional<Algorithm> algorithm_named (std::string_view name) {
    if (name == "RS256") {
        return Algorithm::Rs256;
    }
    if (name == "ES256") {
        return Algorithm::Es256;
    }
    return std::nullopt;
}

std::string_view algorithm_name (Algorithm algorithm) {
    return algorithm == Algorithm::Rs256 ? "RS256" : "ES256";
}

// ---- PEM normalisation ----------------------------------------------------

bool is_blank (char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

/// @p pem with the two characters `\n` read as a line break, which is what a
/// key pasted into a single-line field or a JSON string arrives as.
SecretString unescape_newlines (std::string_view pem) {
    SecretString text;
    text.reserve (pem.size ());
    for (std::size_t i = 0; i < pem.size (); ++i) {
        if (pem[i] == '\\' && i + 1 < pem.size () && pem[i + 1] == 'n') {
            text.push_back ('\n');
            ++i;
            continue;
        }
        text.push_back (pem[i]);
    }
    return text;
}

struct KeyBlock {
    std::string_view label;
    std::string_view body;
};

/// The first armored block whose label ends `PRIVATE KEY`. An `openssl ecparam
/// -genkey` paste leads with an `EC PARAMETERS` block, which is skipped.
std::optional<KeyBlock> find_private_key_block (std::string_view text) {
    std::size_t from = 0;
    while (true) {
        const auto begin = text.find (BEGIN_MARK, from);
        if (begin == std::string_view::npos) {
            return std::nullopt;
        }
        const auto label_at  = begin + BEGIN_MARK.size ();
        const auto label_end = text.find (DASHES, label_at);
        if (label_end == std::string_view::npos) {
            return std::nullopt;
        }
        const auto body_at = label_end + DASHES.size ();
        const auto end     = text.find (END_MARK, body_at);
        if (end == std::string_view::npos) {
            return std::nullopt;
        }
        const auto label = text.substr (label_at, label_end - label_at);
        if (label.ends_with (PRIVATE_KEY_LABEL)) {
            return KeyBlock{ label, text.substr (body_at, end - body_at) };
        }
        from = end;
    }
}

/// Both encrypted forms: PKCS#8 names it in the label, the traditional one in
/// a `Proc-Type` header inside the body. The second must be caught before the
/// body is rejoined, which would run its headers into the base64.
bool is_encrypted (const KeyBlock& block) {
    return block.label.contains ("ENCRYPTED") || block.body.contains ("Proc-Type:");
}

void append_wrapped (SecretString& out, std::string_view body) {
    std::size_t column = 0;
    for (const char c : body) {
        if (is_blank (c)) {
            continue;
        }
        if (column == PEM_LINE_WIDTH) {
            out.push_back ('\n');
            column = 0;
        }
        out.push_back (c);
        ++column;
    }
    out.push_back ('\n');
}

/// The one private-key block of @p pem with its armor on lines of its own and
/// its body wrapped at 64 columns, the shape OpenSSL's reader insists on.
std::expected<SecretString, SignError> normalise_pem (std::string_view pem) {
    const SecretString text = unescape_newlines (pem);
    const auto block        = find_private_key_block (text);
    if (!block) {
        return refuse ("not a PEM private key");
    }
    if (is_encrypted (*block)) {
        return refuse ("private key is encrypted");
    }
    SecretString out;
    // The body plus a newline per line, and the two armor lines.
    out.reserve (text.size () + (text.size () / PEM_LINE_WIDTH) +
    BEGIN_MARK.size () + END_MARK.size () + 16);
    out.append (BEGIN_MARK).append (block->label).append (DASHES).push_back ('\n');
    append_wrapped (out, block->body);
    out.append (END_MARK).append (block->label).append (DASHES).push_back ('\n');
    return out;
}

// ---- Key loading ----------------------------------------------------------

/// A callback that answers "no passphrase". OpenSSL's default one prompts on
/// the terminal, which a route handler would then wait at.
int no_passphrase (char* /*buffer*/, int /*size*/, int /*rwflag*/, void* /*user*/) {
    return -1;
}

std::expected<KeyPtr, SignError> read_private_key (const SecretString& pem) {
    if (!std::in_range<int> (pem.size ())) {
        return refuse ("not a PEM private key");
    }
    const std::unique_ptr<BIO, BioFree> bio (
    BIO_new_mem_buf (pem.data (), static_cast<int> (pem.size ())));
    if (!bio) {
        return refuse ("could not read the private key");
    }
    KeyPtr key (PEM_read_bio_PrivateKey (bio.get (), nullptr, &no_passphrase, nullptr));
    // A failed read leaves its reasons on this thread's error queue, where an
    // unrelated TLS call on the same worker would find them.
    ERR_clear_error ();
    if (!key) {
        return refuse ("not a PEM private key");
    }
    return key;
}

bool is_p256 (const EVP_PKEY* key) {
    std::array<char, 32> name{};
    std::size_t length = 0;
    if (EVP_PKEY_get_group_name (key, name.data (), name.size (), &length) != 1) {
        ERR_clear_error ();
        return false;
    }
    const std::string_view curve (name.data (), length);
    return curve == "prime256v1" || curve == "P-256";
}

std::optional<SignError> check_key_fits (Algorithm algorithm, const EVP_PKEY* key) {
    if (algorithm == Algorithm::Rs256) {
        if (EVP_PKEY_get_base_id (key) != EVP_PKEY_RSA || EVP_PKEY_get_bits (key) < MIN_RSA_BITS) {
            return SignError{ "RS256 needs an RSA key of at least 2048 bits" };
        }
        return std::nullopt;
    }
    if (EVP_PKEY_get_base_id (key) != EVP_PKEY_EC || !is_p256 (key)) {
        return SignError{ "ES256 needs a P-256 key" };
    }
    return std::nullopt;
}

std::expected<KeyPtr, SignError> load_signing_key (Algorithm algorithm, std::string_view pem) {
    const auto normalised = normalise_pem (pem);
    if (!normalised) {
        return std::unexpected (normalised.error ());
    }
    auto key = read_private_key (*normalised);
    if (!key) {
        return key;
    }
    if (auto misfit = check_key_fits (algorithm, key->get ())) {
        return std::unexpected (std::move (*misfit));
    }
    return key;
}

// ---- Signing --------------------------------------------------------------

/// SHA-256 over @p input under @p key; the signature in OpenSSL's own form
/// (PKCS#1 v1.5 for RSA, DER for ECDSA).
std::expected<std::vector<std::uint8_t>, SignError>
digest_sign (Algorithm algorithm, EVP_PKEY* key, std::string_view input) {
    const std::unique_ptr<EVP_MD_CTX, DigestContextFree> context (EVP_MD_CTX_new ());
    EVP_PKEY_CTX* key_context = nullptr;
    if (!context ||
    EVP_DigestSignInit (context.get (), &key_context, EVP_sha256 (), nullptr, key) != 1) {
        ERR_clear_error ();
        return refuse ("could not start signing");
    }
    if (algorithm == Algorithm::Rs256 &&
    EVP_PKEY_CTX_set_rsa_padding (key_context, RSA_PKCS1_PADDING) <= 0) {
        ERR_clear_error ();
        return refuse ("could not start signing");
    }
    const auto* bytes  = detail::sodium_bytes (input);
    std::size_t length = 0;
    if (EVP_DigestSign (context.get (), nullptr, &length, bytes, input.size ()) != 1) {
        ERR_clear_error ();
        return refuse ("signing failed");
    }
    std::vector<std::uint8_t> signature (length);
    if (EVP_DigestSign (
        context.get (), signature.data (), &length, bytes, input.size ()) != 1) {
        ERR_clear_error ();
        return refuse ("signing failed");
    }
    signature.resize (length);
    return signature;
}

/// ECDSA's DER `SEQUENCE { r, s }` as the fixed-width `r || s` JOSE carries.
std::expected<std::vector<std::uint8_t>, SignError> der_to_jose_es256 (
std::span<const std::uint8_t> der) {
    const std::uint8_t* cursor = der.data ();
    const std::unique_ptr<ECDSA_SIG, SignatureFree> parsed (
    d2i_ECDSA_SIG (nullptr, &cursor, static_cast<long> (der.size ())));
    if (!parsed) {
        ERR_clear_error ();
        return refuse ("signing failed");
    }
    const BIGNUM* r = nullptr;
    const BIGNUM* s = nullptr;
    ECDSA_SIG_get0 (parsed.get (), &r, &s);
    std::vector<std::uint8_t> jose (2 * ES256_COORDINATE_BYTES);
    const std::span<std::uint8_t> out (jose);
    // BN_bn2binpad answers -1 for a value that does not fit in the width.
    if (BN_bn2binpad (r, out.first (ES256_COORDINATE_BYTES).data (),
        static_cast<int> (ES256_COORDINATE_BYTES)) < 0 ||
    BN_bn2binpad (s, out.last (ES256_COORDINATE_BYTES).data (),
    static_cast<int> (ES256_COORDINATE_BYTES)) < 0) {
        ERR_clear_error ();
        return refuse ("signing failed");
    }
    return jose;
}

std::expected<std::vector<std::uint8_t>, SignError>
sign (Algorithm algorithm, EVP_PKEY* key, std::string_view input) {
    auto signature = digest_sign (algorithm, key, input);
    if (!signature || algorithm == Algorithm::Rs256) {
        return signature;
    }
    return der_to_jose_es256 (*signature);
}

// ---- Token assembly -------------------------------------------------------

std::expected<std::string, SignError>
header_json (Algorithm algorithm, std::optional<std::string_view> kid) {
    nlohmann::json header = { { "alg", algorithm_name (algorithm) }, { "typ", "JWT" } };
    if (kid && !kid->empty ()) {
        header["kid"] = std::string (*kid);
    }
    try {
        return header.dump ();
    } catch (const nlohmann::json::exception&) {
        // Text that is not UTF-8 is the one thing the dump refuses.
        return refuse ("kid is not valid UTF-8");
    }
}

} // namespace

std::expected<std::string, SignError> sign_jwt (std::string_view alg,
std::string_view pem,
std::optional<std::string_view> kid,
std::string_view claims_json) {
    const auto algorithm = algorithm_named (alg);
    if (!algorithm) {
        return refuse ("unsupported algorithm: use RS256 or ES256");
    }
    const auto header = header_json (*algorithm, kid);
    if (!header) {
        return std::unexpected (header.error ());
    }
    const auto key = load_signing_key (*algorithm, pem);
    if (!key) {
        return std::unexpected (key.error ());
    }
    std::string token = base64url_encode (*header) + '.' + base64url_encode (claims_json);
    const auto signature = sign (*algorithm, key->get (), token);
    if (!signature) {
        return std::unexpected (signature.error ());
    }
    token += '.';
    token += base64url_encode (byte_view (*signature));
    return token;
}

} // namespace vayu::utils
