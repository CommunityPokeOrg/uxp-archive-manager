/* js-ctypes bindings for native libraries — chrome code only.
 *
 * lzmaDecode(): liblzma's one-shot lzma_stream_buffer_decode(), which needs
 * no struct layout definitions and so is robust across liblzma versions.
 * The output buffer grows geometrically on LZMA_BUF_ERROR.
 *
 * createLink(): POSIX symlink()/link() via libc, used only for link targets
 * that have already passed SafePath.checkLinkTarget().
 *
 * Every entry point degrades gracefully: availability() reports which
 * libraries resolved so ArchiveService can pick a different backend.
 */
"use strict";

var EXPORTED_SYMBOLS = ["CtypesNative"];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/ctypes.jsm");

var LZMA_BUF_ERROR = 10;
var LZMA_OK = 0;
var LZMA_CONCATENATED = 0x08;

var _lzma = null;
var _lzmaTried = false;
var _libc = null;
var _libcTried = false;

function tryOpen(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    try { return ctypes.open(candidates[i]); } catch (e) {}
  }
  return null;
}

var CtypesNative = {

  availability: function availability() {
    return {
      lzma: CtypesNative._lzmaLib() !== null,
      links: CtypesNative._libcLib() !== null
    };
  },

  _lzmaLib: function () {
    if (!_lzmaTried) {
      _lzmaTried = true;
      var lib = tryOpen(["liblzma.so.5", "liblzma.so", "liblzma.dylib",
                         "liblzma.5.dylib", "liblzma.dll", "lzma.dll"]);
      if (lib) {
        try {
          _lzma = {
            lib: lib,
            decode: lib.declare(
              "lzma_stream_buffer_decode", ctypes.default_abi,
              ctypes.int,                    // lzma_ret
              ctypes.uint64_t.ptr,           // memlimit
              ctypes.uint32_t,               // flags
              ctypes.voidptr_t,              // allocator
              ctypes.unsigned_char.ptr,      // in
              ctypes.size_t.ptr,             // in_pos
              ctypes.size_t,                 // in_size
              ctypes.unsigned_char.ptr,      // out
              ctypes.size_t.ptr,             // out_pos
              ctypes.size_t                  // out_size
            )
          };
        } catch (e) {
          try { lib.close(); } catch (e2) {}
          _lzma = null;
        }
      }
    }
    return _lzma;
  },

  /* Decode a complete .xz stream. Returns Uint8Array or throws. */
  lzmaDecode: function lzmaDecode(input, hintSize) {
    var lz = CtypesNative._lzmaLib();
    if (!lz) throw new Error("liblzma not available via js-ctypes");

    var inBuf = ctypes.unsigned_char.array(input.length)(input);
    var inPos = new ctypes.size_t(0);
    var memlimit = ctypes.uint64_t("0xFFFFFFFFFFFFFFFF");

    var cap = Math.max(hintSize || 0, 1 << 20);
    var MAX = 1 << 32; // 4 GiB ceiling; larger files need the helper path
    for (;;) {
      var outBuf = ctypes.unsigned_char.array(cap)();
      var outPos = new ctypes.size_t(0);
      var ret = lz.decode(memlimit.address(), LZMA_CONCATENATED, null,
                          inBuf, inPos.address(), input.length,
                          outBuf, outPos.address(), cap);
      if (ret === LZMA_OK) {
        var n = Number(outPos.value || outPos);
        var out = new Uint8Array(n);
        var view = ctypes.cast(outBuf, ctypes.unsigned_char.array(n).ptr).contents;
        out.set(view);
        return out;
      }
      if (ret === LZMA_BUF_ERROR && cap < MAX) {
        cap = Math.min(cap * 4, MAX);
        inPos = new ctypes.size_t(0);
        continue;
      }
      throw new Error("liblzma decode failed (ret " + ret + ")");
    }
  },

  _libcLib: function () {
    if (!_libcTried) {
      _libcTried = true;
      var lib = tryOpen(["libc.so.6", "libc.so", "libc.dylib",
                         "/usr/lib/libSystem.B.dylib"]);
      if (lib) _libc = lib;
    }
    return _libc;
  },

  /* Create a symlink or hardlink. Returns true when the platform supports
   * it; throws when the libc call itself fails. Only ever called with an
   * already-validated in-root target. */
  createLink: function createLink(kind, target, linkPath) {
    var lib = CtypesNative._libcLib();
    if (!lib) return false;
    var fnName = kind === "hardlink" ? "link" : "symlink";
    var fn;
    try {
      fn = lib.declare(fnName, ctypes.default_abi, ctypes.int,
                       ctypes.char.ptr, ctypes.char.ptr);
    } catch (e) {
      return false;
    }
    var rc = fn(target, linkPath);
    if (rc !== 0) throw new Error(fnName + "() failed for " + linkPath);
    return true;
  }
};
