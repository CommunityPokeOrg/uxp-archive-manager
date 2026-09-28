/* Byte-level helpers shared by the archive parsers.
 *
 * Pure JavaScript: no XPCOM, no DOM. Everything operates on Uint8Array so the
 * same module runs inside the extension (JSM), under xpcshell, and under a
 * plain JS engine for the test harness.
 */
"use strict";

var EXPORTED_SYMBOLS = ["Bytes"];

var Bytes = {
  u16: function u16(a, o) {
    return a[o] | (a[o + 1] << 8);
  },

  u32: function u32(a, o) {
    // >>> 0 keeps values >= 2^31 unsigned.
    return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
  },

  /* Octal-or-base256 numeric field used by TAR headers. */
  tarNumber: function tarNumber(a, o, len) {
    if (a[o] & 0x80) {
      // POSIX base-256 (GNU large files). First byte is the marker.
      var n = 0;
      for (var i = 1; i < len; i++) n = n * 256 + a[o + i];
      return n;
    }
    var s = "";
    for (var j = 0; j < len; j++) {
      var c = a[o + j];
      if (c === 0 || c === 0x20) {
        if (s.length) break;
        continue;
      }
      s += String.fromCharCode(c);
    }
    return s.length ? parseInt(s, 8) : 0;
  },

  ascii: function ascii(a, o, len) {
    var s = "";
    for (var i = 0; i < len && a[o + i] !== 0; i++)
      s += String.fromCharCode(a[o + i]);
    return s;
  },

  /* Decode a byte range. isUtf8 selects UTF-8; otherwise CP437 (the legacy
   * ZIP default). UTF-8 goes through TextDecoder when the engine provides it
   * (always true in UXP chrome code); there is a small JS fallback. */
  text: function text(a, o, len, isUtf8) {
    var slice = a.subarray(o, o + len);
    if (isUtf8) {
      if (typeof TextDecoder !== "undefined")
        return new TextDecoder("utf-8").decode(slice);
      return Bytes._utf8js(slice);
    }
    return Bytes.cp437(slice);
  },

  _utf8js: function _utf8js(a) {
    var s = "", i = 0;
    while (i < a.length) {
      var c = a[i++];
      if (c < 0x80) { s += String.fromCharCode(c); continue; }
      var n, cp;
      if ((c & 0xe0) === 0xc0)      { n = 1; cp = c & 0x1f; }
      else if ((c & 0xf0) === 0xe0) { n = 2; cp = c & 0x0f; }
      else                          { n = 3; cp = c & 0x07; }
      while (n-- > 0 && i < a.length) cp = (cp << 6) | (a[i++] & 0x3f);
      s += String.fromCharCode(cp);
    }
    return s;
  },

  /* High half of CP437 (0x80-0xFF). Index 0x00-0x7F maps to ASCII. */
  _cp437hi: [
    0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
    0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
    0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
    0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
    0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
    0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
    0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
    0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
    0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
    0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
    0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
    0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
    0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
    0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0
  ],

  cp437: function cp437(a) {
    var s = "";
    for (var i = 0; i < a.length; i++) {
      var b = a[i];
      s += String.fromCharCode(b < 0x80 ? b : Bytes._cp437hi[b - 0x80]);
    }
    return s;
  },

  /* CRC-32 (IEEE 802.3) over a Uint8Array; used for ZIP integrity checks. */
  crc32: (function () {
    var table = null;
    return function crc32(a, start, end) {
      if (!table) {
        table = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
          var c = n;
          for (var k = 0; k < 8; k++)
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
          table[n] = c >>> 0;
        }
      }
      var crc = 0xffffffff;
      for (var i = (start || 0); i < (end === undefined ? a.length : end); i++)
        crc = table[(crc ^ a[i]) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
  })(),

  concat: function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
};
