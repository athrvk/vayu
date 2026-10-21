#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file crypto_js_shim.hpp
 * @brief The `crypto-js` the `require()` shelf hands out (#2578): Vayu's own
 *        code with crypto-js's shape, not the library.
 *
 * It covers what Postman's signing scripts call - the hashers and their HMACs,
 * `enc.Hex` / `Latin1` / `Utf8` / `Base64`, and `lib.WordArray` - and nothing
 * else: no ciphers, no PBKDF2, no progressive `algo.*` hashers, no
 * `WordArray.random`. A missing member reads as `undefined`, the way a
 * crypto-js build without that module does. The hashing itself is native
 * (`utils/digest.hpp`), reached through the `native` object the factory is
 * called with, which no script can name.
 *
 * The source evaluates to that factory. `JS_Eval` reads the byte after the
 * length as a terminator, which a string literal has. MSVC caps one string
 * literal at 16,380 bytes (C2026); split the source into adjacent literals
 * before it grows past that.
 */

#include <string_view>

namespace vayu::runtime::pm_detail {

inline constexpr std::string_view CRYPTO_JS_SHIM = R"js((function (native) {
'use strict';

function describe(value) {
  return value === null ? 'null' : typeof value;
}

function WordArray(words, sigBytes) {
  this.words = words || [];
  this.sigBytes = sigBytes !== undefined ? sigBytes : this.words.length * 4;
}

function fromBytes(bytes) {
  var words = [];
  for (var i = 0; i < bytes.length; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
  }
  return new WordArray(words, bytes.length);
}

function toBytes(wordArray) {
  var bytes = new Uint8Array(wordArray.sigBytes);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return bytes;
}

function wordArrayArgument(value, what) {
  if (value instanceof WordArray) {
    return value;
  }
  throw new TypeError(what + ' takes a WordArray, not ' + describe(value));
}

function stringArgument(value, what) {
  if (typeof value === 'string') {
    return value;
  }
  throw new TypeError(what + ' takes a string, not ' + describe(value));
}

// What a hasher reads: a string as its UTF-8 bytes, which the native side
// encodes, or a WordArray's bytes.
function hashInput(value, what) {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof WordArray) {
    return toBytes(value);
  }
  throw new TypeError(what + ' takes a string or a WordArray, not ' + describe(value));
}

WordArray.create = function (value, sigBytes) {
  if (value instanceof ArrayBuffer) {
    return fromBytes(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return fromBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return new WordArray(value, sigBytes);
};

WordArray.prototype.toString = function (encoder) {
  return (encoder || Hex).stringify(this);
};

WordArray.prototype.concat = function (other) {
  var head = toBytes(this);
  var tail = toBytes(wordArrayArgument(other, 'WordArray.concat'));
  var joined = new Uint8Array(head.length + tail.length);
  joined.set(head);
  joined.set(tail, head.length);
  var result = fromBytes(joined);
  this.words = result.words;
  this.sigBytes = result.sigBytes;
  return this;
};

WordArray.prototype.clone = function () {
  return new WordArray(this.words.slice(0), this.sigBytes);
};

var Hex = {
  stringify: function (wordArray) {
    var bytes = toBytes(wordArrayArgument(wordArray, 'CryptoJS.enc.Hex.stringify'));
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
    }
    return out.join('');
  },
  parse: function (text) {
    stringArgument(text, 'CryptoJS.enc.Hex.parse');
    if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) {
      throw new TypeError('CryptoJS.enc.Hex.parse: ' + JSON.stringify(text) +
        ' is not an even number of hex digits');
    }
    var bytes = new Uint8Array(text.length / 2);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(text.substr(i * 2, 2), 16);
    }
    return fromBytes(bytes);
  }
};

var Latin1 = {
  stringify: function (wordArray) {
    var bytes = toBytes(wordArrayArgument(wordArray, 'CryptoJS.enc.Latin1.stringify'));
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      out.push(String.fromCharCode(bytes[i]));
    }
    return out.join('');
  },
  parse: function (text) {
    stringArgument(text, 'CryptoJS.enc.Latin1.parse');
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return fromBytes(bytes);
  }
};

var Utf8 = {
  stringify: function (wordArray) {
    var latin1 = Latin1.stringify(wordArrayArgument(wordArray, 'CryptoJS.enc.Utf8.stringify'));
    try {
      return decodeURIComponent(escape(latin1));
    } catch (e) {
      throw new Error('Malformed UTF-8 data');
    }
  },
  parse: function (text) {
    return Latin1.parse(unescape(encodeURIComponent(stringArgument(text, 'CryptoJS.enc.Utf8.parse'))));
  }
};

var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

var Base64 = {
  stringify: function (wordArray) {
    var bytes = toBytes(wordArrayArgument(wordArray, 'CryptoJS.enc.Base64.stringify'));
    var out = [];
    for (var i = 0; i < bytes.length; i += 3) {
      var triple = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      for (var j = 0; j < 4; j++) {
        // A sextet that starts past the last byte is padding.
        out.push(i * 8 + j * 6 < bytes.length * 8 ?
          BASE64.charAt((triple >>> (18 - 6 * j)) & 0x3f) : '=');
      }
    }
    return out.join('');
  },
  // Stops at the first '=', as crypto-js does, and skips whitespace, as atob
  // does; any other character outside the alphabet is refused.
  parse: function (text) {
    var digits = stringArgument(text, 'CryptoJS.enc.Base64.parse').replace(/\s+/g, '');
    var padding = digits.indexOf('=');
    if (padding !== -1) {
      digits = digits.slice(0, padding);
    }
    var bytes = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < digits.length; i++) {
      var value = BASE64.indexOf(digits.charAt(i));
      if (value === -1) {
        throw new TypeError('CryptoJS.enc.Base64.parse: ' +
          JSON.stringify(digits.charAt(i)) + ' is not a base64 digit');
      }
      buffer = ((buffer << 6) | value) & 0xffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >>> bits) & 0xff);
      }
    }
    return fromBytes(bytes);
  }
};

var CryptoJS = {
  lib: { WordArray: WordArray },
  enc: { Hex: Hex, Latin1: Latin1, Utf8: Utf8, Base64: Base64 }
};

['MD5', 'SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512'].forEach(function (name) {
  CryptoJS[name] = function (message) {
    return fromBytes(native.digest(name, hashInput(message, 'CryptoJS.' + name)));
  };
  CryptoJS['Hmac' + name] = function (message, key) {
    var what = 'CryptoJS.Hmac' + name;
    return fromBytes(native.hmac(name, hashInput(key, what + ' key'),
      hashInput(message, what + ' message')));
  };
});

return CryptoJS;
}))js";

} // namespace vayu::runtime::pm_detail
