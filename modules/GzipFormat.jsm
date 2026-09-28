/* GZIP (RFC 1952) wrapper — pure JavaScript, no XPCOM.
 *
 * Strips the gzip header/footer and inflates the DEFLATE payload via the
 * pure-JS Inflate module, verifying CRC-32 and ISIZE. Used for .tar.gz/.tgz
 * and for single-file .gz streams.
 */
"use strict";

var EXPORTED_SYMBOLS = ["GzipFormat"];

var GzipFormat = (function () {
  var BytesRef = null;
  var InflateRef = null;
  function init(bytes, inflate) { BytesRef = bytes; InflateRef = inflate; }

  function isGzip(buf) {
    return buf.length > 18 && buf[0] === 0x1f && buf[1] === 0x8b;
  }

  function decompress(buf) {
    if (!isGzip(buf)) throw new Error("GZIP: bad magic");
    if (buf[2] !== 8) throw new Error("GZIP: unsupported method " + buf[2]);
    var flg = buf[3];
    var pos = 10;
    if (flg & 0x04) { // FEXTRA
      var xlen = BytesRef.u16(buf, pos);
      pos += 2 + xlen;
    }
    if (flg & 0x08) while (pos < buf.length && buf[pos++] !== 0) {} // FNAME
    if (flg & 0x10) while (pos < buf.length && buf[pos++] !== 0) {} // FCOMMENT
    if (flg & 0x02) pos += 2; // FHCRC
    if (pos >= buf.length - 8) throw new Error("GZIP: truncated header");

    var expected = BytesRef.u32(buf, buf.length - 4); // ISIZE
    var expectedCrc = BytesRef.u32(buf, buf.length - 8);
    var out = InflateRef.inflate(buf.subarray(pos, buf.length - 8), expected);
    if ((out.length & 0xffffffff) !== expected)
      throw new Error("GZIP: ISIZE mismatch");
    if (BytesRef.crc32(out) !== expectedCrc)
      throw new Error("GZIP: CRC-32 mismatch");
    return out;
  }

  return { init: init, isGzip: isGzip, decompress: decompress };
})();
