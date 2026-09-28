/* Raw DEFLATE (RFC 1951) decompressor in pure JavaScript.
 *
 * Port of the design of puff.c (Mark Adler's minimal inflate reference) to
 * JS operating on Uint8Array. No XPCOM, no DOM — the module is loaded by the
 * extension as a JSM and by the test harness as plain script.
 *
 * inflate(input, expectedSize) -> Uint8Array
 *   expectedSize, when known (ZIP central directory stores it), is used to
 *   preallocate the output buffer; the decompressor still grows if needed.
 */
"use strict";

var EXPORTED_SYMBOLS = ["Inflate"];

var Inflate = (function () {

  var MAXBITS = 15;
  var MAXLCODES = 286;
  var MAXDCODES = 30;
  var MAXCODES = MAXLCODES + MAXDCODES;
  var FIXLCODES = 288;

  var LENBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LENEXT  = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
                 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DISTBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                  8193, 12289, 16385, 24577];
  var DISTEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function State(input) {
    this.inbuf = input;
    this.incnt = 0;          // bytes consumed from inbuf
    this.bitbuf = 0;
    this.bitcnt = 0;
    this.out = null;         // Uint8Array
    this.outlen = 0;
    this.err = 0;            // 0 ok, <0 error
  }

  function bits(s, need) {
    var val = s.bitbuf;
    while (s.bitcnt < need) {
      if (s.incnt >= s.inbuf.length) {
        s.err = -1; // out of input
        return 0;
      }
      val |= s.inbuf[s.incnt++] << s.bitcnt;
      s.bitcnt += 8;
    }
    s.bitbuf = val >>> need;
    s.bitcnt -= need;
    return val & ((1 << need) - 1);
  }

  function reserve(s, need) {
    if (s.out === null || s.out.length < need) {
      var cap = s.out === null ? 1 << 15 : s.out.length;
      while (cap < need) cap <<= 1;
      var next = new Uint8Array(cap);
      if (s.out !== null) next.set(s.out.subarray(0, s.outlen));
      s.out = next;
    }
  }

  function decode(s, h) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len <= MAXBITS; len++) {
      code |= bits(s, 1);
      if (s.err) return -1;
      var count = h.count[len];
      if (code - count < first)
        return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    s.err = -9; // ran out of codes
    return -1;
  }

  // Build decoding tables from code lengths. Returns 0 on success, a negative
  // error otherwise. If the return value is positive, the code is incomplete
  // (legal only in the single-code cases checked by callers).
  function construct(h, lengths, n) {
    var offs = new Int16Array(MAXBITS + 1);
    for (var len = 0; len <= MAXBITS; len++) h.count[len] = 0;
    for (var sym = 0; sym < n; sym++) h.count[lengths[sym]]++;
    if (h.count[0] === n) return 0; // no codes at all — complete by convention
    var left = 1;
    for (len = 1; len <= MAXBITS; len++) {
      left <<= 1;
      left -= h.count[len];
      if (left < 0) return left; // over-subscribed
    }
    offs[1] = 0;
    for (len = 1; len < MAXBITS; len++)
      offs[len + 1] = offs[len] + h.count[len];
    for (sym = 0; sym < n; sym++)
      if (lengths[sym] !== 0)
        h.symbol[offs[lengths[sym]]++] = sym;
    return left;
  }

  function codes(s, lencode, distcode) {
    for (;;) {
      var symbol = decode(s, lencode);
      if (s.err) return s.err;
      if (symbol < 0) return -10;       // invalid code
      if (symbol < 256) {
        reserve(s, s.outlen + 1);
        s.out[s.outlen++] = symbol;
      } else if (symbol === 256) {
        return 0;                        // end of block
      } else {
        symbol -= 257;
        if (symbol >= 29) return -11;    // invalid length code
        var len = LENBASE[symbol] + bits(s, LENEXT[symbol]);
        if (s.err) return s.err;
        symbol = decode(s, distcode);
        if (s.err) return s.err;
        if (symbol < 0) return -12;      // invalid distance code
        if (symbol >= 30) return -13;
        var dist = DISTBASE[symbol] + bits(s, DISTEXT[symbol]);
        if (s.err) return s.err;
        if (dist > s.outlen) return -14; // distance too far back
        reserve(s, s.outlen + len);
        // Byte-by-byte copy handles overlapping windows (dist < len).
        for (var i = 0; i < len; i++)
          s.out[s.outlen] = s.out[s.outlen - dist], s.outlen++;
      }
    }
  }

  function stored(s) {
    // Discard partial bits to reach a byte boundary.
    s.bitbuf = 0;
    s.bitcnt = 0;
    if (s.incnt + 4 > s.inbuf.length) return -2;
    var len = s.inbuf[s.incnt] | (s.inbuf[s.incnt + 1] << 8);
    var nlen = s.inbuf[s.incnt + 2] | (s.inbuf[s.incnt + 3] << 8);
    s.incnt += 4;
    if (len !== ((~nlen) & 0xffff)) return -3;
    if (s.incnt + len > s.inbuf.length) return -2;
    reserve(s, s.outlen + len);
    s.out.set(s.inbuf.subarray(s.incnt, s.incnt + len), s.outlen);
    s.outlen += len;
    s.incnt += len;
    return 0;
  }

  function fixedTables() {
    var lengths = new Int16Array(FIXLCODES);
    var lencode = { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(FIXLCODES) };
    var distcode = { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(MAXDCODES) };
    var sym;
    for (sym = 0; sym < 144; sym++) lengths[sym] = 8;
    for (; sym < 256; sym++) lengths[sym] = 9;
    for (; sym < 280; sym++) lengths[sym] = 7;
    for (; sym < FIXLCODES; sym++) lengths[sym] = 8;
    construct(lencode, lengths, FIXLCODES);
    var dl = new Int16Array(MAXDCODES);
    for (sym = 0; sym < MAXDCODES; sym++) dl[sym] = 5;
    construct(distcode, dl, MAXDCODES);
    return { lencode: lencode, distcode: distcode };
  }

  var _fixed = null;

  function dynamic(s) {
    var nlen = bits(s, 5) + 257;
    var ndist = bits(s, 5) + 1;
    var ncode = bits(s, 4) + 4;
    if (s.err) return s.err;
    if (nlen > MAXLCODES || ndist > MAXDCODES) return -4;
    var lengths = new Int16Array(MAXCODES);
    var clen = new Int16Array(19);
    for (var i = 0; i < ncode; i++) clen[ORDER[i]] = bits(s, 3);
    if (s.err) return s.err;
    var lencode = { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(19) };
    var err = construct(lencode, clen, 19);
    if (err !== 0) return -5; // code-length code must be complete
    var n = 0;
    while (n < nlen + ndist) {
      var symbol = decode(s, lencode);
      if (s.err) return s.err;
      if (symbol < 0) return -6;
      if (symbol < 16) {
        lengths[n++] = symbol;
      } else {
        var rep, fill;
        if (symbol === 16) {
          if (n === 0) return -7; // no previous length to repeat
          fill = lengths[n - 1];
          rep = 3 + bits(s, 2);
        } else if (symbol === 17) {
          fill = 0;
          rep = 3 + bits(s, 3);
        } else { // 18
          fill = 0;
          rep = 11 + bits(s, 7);
        }
        if (s.err) return s.err;
        if (n + rep > nlen + ndist) return -8;
        while (rep-- > 0) lengths[n++] = fill;
      }
    }
    if (lengths[256] === 0) return -9; // missing end-of-block code
    var out = {
      lencode: { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(nlen) },
      distcode: { count: new Int16Array(MAXBITS + 1), symbol: new Int16Array(ndist) }
    };
    err = construct(out.lencode, lengths, nlen);
    // Incomplete literal/length codes are only allowed when they consist of
    // a single code (they can then never be decoded, which is fine).
    if (err !== 0 && (err < 0 || nlen !== out.lencode.count[0] + out.lencode.count[1]))
      return -10;
    err = construct(out.distcode, lengths.subarray(nlen), ndist);
    if (err !== 0 && (err < 0 || ndist !== out.distcode.count[0] + out.distcode.count[1]))
      return -11;
    var rc = codes(s, out.lencode, out.distcode);
    return rc;
  }

  function inflate(input, expectedSize) {
    var s = new State(input);
    if (expectedSize > 0) reserve(s, expectedSize);
    var last, type, err = 0;
    do {
      last = bits(s, 1);
      type = bits(s, 2);
      if (s.err) { err = s.err; break; }
      if (type === 0) err = stored(s);
      else if (type === 1) {
        if (!_fixed) _fixed = fixedTables();
        err = codes(s, _fixed.lencode, _fixed.distcode);
      } else if (type === 2) err = dynamic(s);
      else err = -15; // reserved block type
      if (err) break;
    } while (!last);
    if (err) throw new Error("Inflate failed (code " + err + ")");
    return s.out.subarray(0, s.outlen);
  }

  return { inflate: inflate, MAXBITS: MAXBITS };
})();
