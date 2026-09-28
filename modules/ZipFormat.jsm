/* ZIP reader — pure JavaScript, no XPCOM.
 *
 * Parses the End Of Central Directory record, the central directory, and
 * local file headers. Extraction supports stored (0) and deflate (8) via the
 * pure-JS Inflate module; other methods are listed but rejected with a
 * descriptive error. Traditional PKWARE/AES-encrypted entries are listed
 * (flag bit 0) but cannot be decrypted — see README.
 *
 * Basic ZIP64 is supported: when a central-directory size/offset field is
 * 0xFFFFFFFF the corresponding values are read from the ZIP64 extra field.
 * Multi-disk archives and the ZIP64 EOCD are not handled (documented).
 */
"use strict";

var EXPORTED_SYMBOLS = ["ZipFormat"];

var ZipFormat = (function () {
  var BytesRef = null;
  var InflateRef = null;

  // Late-bound so the module loads standalone; the caller (or test harness)
  // wires dependencies via init().
  function init(bytes, inflate) { BytesRef = bytes; InflateRef = inflate; }

  var EOCD_SIG = 0x06054b50;
  var CDIR_SIG = 0x02014b50;
  var LOC_SIG  = 0x04034b50;

  var METHOD_NAMES = {
    0: "stored", 8: "deflate", 9: "deflate64", 10: "dcl-implode",
    12: "bzip2", 14: "lzma", 93: "zstd", 95: "xz", 96: "jpeg",
    97: "wavpack", 98: "ppmd", 99: "aes"
  };

  function dosDate(date, time) {
    var day = date & 0x1f, month = (date >> 5) & 0x0f, year = ((date >> 9) & 0x7f) + 1980;
    var sec = (time & 0x1f) * 2, min = (time >> 5) & 0x3f, hour = (time >> 11) & 0x1f;
    return new Date(year, month - 1, day, hour, min, sec);
  }

  /* Locate the EOCD record by scanning backwards through the last 64 KiB. */
  function findEocd(buf) {
    var min = Math.max(0, buf.length - (0xffff + 22));
    for (var i = buf.length - 22; i >= min; i--) {
      if (BytesRef.u32(buf, i) === EOCD_SIG) return i;
    }
    throw new Error("ZIP: end of central directory not found");
  }

  function parse(buf) {
    if (buf.length < 22) throw new Error("ZIP: file too small");
    var eocd = findEocd(buf);
    var entries = [];
    var disk = BytesRef.u16(buf, eocd + 4);
    var cdDisk = BytesRef.u16(buf, eocd + 6);
    if (disk !== 0 || cdDisk !== 0)
      throw new Error("ZIP: multi-disk archives are not supported");
    var count = BytesRef.u16(buf, eocd + 10);
    var cdOffset = BytesRef.u32(buf, eocd + 16);
    var commentLen = BytesRef.u16(buf, eocd + 20);
    var comment = commentLen ? BytesRef.text(buf, eocd + 22, commentLen, true) : "";

    var pos = cdOffset;
    for (var i = 0; i < count; i++) {
      if (BytesRef.u32(buf, pos) !== CDIR_SIG)
        throw new Error("ZIP: bad central directory header at entry " + i);
      var flags = BytesRef.u16(buf, pos + 8);
      var method = BytesRef.u16(buf, pos + 10);
      var mtime = BytesRef.u16(buf, pos + 12);
      var mdate = BytesRef.u16(buf, pos + 14);
      var crc = BytesRef.u32(buf, pos + 16);
      var packed = BytesRef.u32(buf, pos + 20);
      var size = BytesRef.u32(buf, pos + 24);
      var nameLen = BytesRef.u16(buf, pos + 28);
      var extraLen = BytesRef.u16(buf, pos + 30);
      var cmtLen = BytesRef.u16(buf, pos + 32);
      var extAttr = BytesRef.u32(buf, pos + 38);
      var localOffset = BytesRef.u32(buf, pos + 42);
      var nameStart = pos + 46;
      var isUtf8 = (flags & 0x0800) !== 0;
      var name = BytesRef.text(buf, nameStart, nameLen, isUtf8);

      var extra = buf.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
      // ZIP64 extra field (0x0001): fills in any 0xFFFFFFFF placeholders in
      // the order size, packed, offset, disk.
      if (size === 0xffffffff || packed === 0xffffffff || localOffset === 0xffffffff) {
        var vals = readZip64(extra, [size, packed, localOffset]);
        size = vals[0]; packed = vals[1]; localOffset = vals[2];
      }

      var isDir = name.charAt(name.length - 1) === "/" ||
                  ((extAttr >>> 16) & 0x4000) !== 0;

      entries.push({
        index: i,
        name: name,
        type: isDir ? "dir" : "file",
        size: size,
        packedSize: packed,
        crc32: crc,
        method: method,
        methodName: METHOD_NAMES[method] || ("method-" + method),
        encrypted: (flags & 0x0001) !== 0,
        mtime: dosDate(mdate, mtime),
        localOffset: localOffset
      });
      pos = nameStart + nameLen + extraLen + cmtLen;
    }
    return { format: "zip", entries: entries, comment: comment };
  }

  function readZip64(extra, placeholders) {
    var out = placeholders.slice();
    for (var p = 0; p + 4 <= extra.length;) {
      var id = extra[p] | (extra[p + 1] << 8);
      var len = extra[p + 2] | (extra[p + 3] << 8);
      var body = p + 4;
      if (id === 0x0001) {
        var slot = 0;
        for (var v = 0; v < 3 && body + 8 <= p + 4 + len; v++) {
          if (placeholders[v] === 0xffffffff) {
            var lo = BytesRef.u32(extra, body);
            var hi = BytesRef.u32(extra, body + 4);
            // Entries beyond 4 GiB keep their true value as a JS double.
            out[v] = hi * 0x100000000 + lo;
          }
          body += 8;
          slot++;
        }
        break;
      }
      p = body + len;
    }
    return out;
  }

  /* Slice out the compressed payload for an entry (past its local header). */
  function payload(buf, entry) {
    var pos = entry.localOffset;
    if (BytesRef.u32(buf, pos) !== LOC_SIG)
      throw new Error("ZIP: bad local header for " + entry.name);
    var nameLen = BytesRef.u16(buf, pos + 26);
    var extraLen = BytesRef.u16(buf, pos + 28);
    var start = pos + 30 + nameLen + extraLen;
    return buf.subarray(start, start + entry.packedSize);
  }

  /* Decompress one entry. Returns a Uint8Array, verifying size and CRC-32. */
  function decompress(buf, entry) {
    if (entry.encrypted)
      throw new Error("entry is encrypted; encrypted ZIP is not supported");
    var data = payload(buf, entry);
    var out;
    if (entry.method === 0) out = data;
    else if (entry.method === 8) out = InflateRef.inflate(data, entry.size);
    else throw new Error("unsupported compression method: " + entry.methodName);
    if (out.length !== entry.size)
      throw new Error("size mismatch for " + entry.name);
    if (BytesRef.crc32(out) !== entry.crc32)
      throw new Error("CRC-32 mismatch for " + entry.name);
    return out;
  }

  return { init: init, parse: parse, decompress: decompress, payload: payload };
})();
