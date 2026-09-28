/* DownloadFilter — pure decision logic for "open the Archive Manager when a
 * supported archive finishes downloading".
 *
 * No XPCOM, DOM or Components here: this file is loaded as a plain script by
 * tests/run_tests.js under Node/xpcshell exactly like the other pure modules.
 * All browser wiring lives in DownloadWatcher.jsm.
 */
"use strict";

var EXPORTED_SYMBOLS = ["DownloadFilter"];

var DownloadFilter = {

  /* nsIDownloadManager::DOWNLOAD_FINISHED from
   * toolkit/components/downloads/public/nsIDownloadManager.idl.
   * Kept as a plain number so this module stays XPCOM-free; the watcher
   * compares against Ci.nsIDownloadManager.DOWNLOAD_FINISHED, which is the
   * same constant. */
  DOWNLOAD_FINISHED: 1,

  /* Filename suffixes that trigger auto-open — longest first so compound
   * extensions (.tar.gz / .tar.xz) always win over their inner part.
   * .tgz / .txz are accepted as the same tar+gzip / tar+xz formats, matching
   * the file-picker filters of the manual open dialog.
   *
   * Bare .gz and .xz are single-stream compressors, not archives; the
   * extension lists them for manual open but they are deliberately NOT
   * auto-opened (a downloaded .gz is frequently e.g. a web asset, and a
   * false auto-open is far more disruptive than a missed one). */
  SUFFIXES: [
    [".tar.gz", "tar.gz"], [".tar.xz", "tar.xz"],
    [".tgz",    "tar.gz"], [".txz",    "tar.xz"],
    [".zip",    "zip"],    [".rar",    "rar"],
    [".7z",     "7z"],     [".tar",    "tar"]
  ],

  /* Last path component of a path or URL, with query/fragment stripped. */
  leafName: function leafName(path) {
    if (!path) return "";
    var s = String(path);
    var q = s.search(/[?#]/);
    if (q !== -1) s = s.slice(0, q);
    return s.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "");
  },

  /* Map a path/URL to a supported archive kind ("zip", "rar", "7z",
   * "tar", "tar.gz", "tar.xz") or null. Case-insensitive. */
  detectKind: function detectKind(path) {
    var name = DownloadFilter.leafName(path).toLowerCase();
    var suffixes = DownloadFilter.SUFFIXES;
    for (var i = 0; i < suffixes.length; i++) {
      var suf = suffixes[i][0];
      // require a non-empty base name before the extension
      if (name.length > suf.length && name.slice(-suf.length) === suf)
        return suffixes[i][1];
    }
    return null;
  },

  isSupportedArchive: function isSupportedArchive(path) {
    return DownloadFilter.detectKind(path) !== null;
  },

  /* Deduper collapsing duplicate completion notifications for the same
   * file. The legacy nsIDownloadProgressListener can report the same
   * state more than once, jsdownloads views fire onDownloadChanged for
   * every attribute update (including after `succeeded` is already true),
   * and on platforms where both backends exist a single download can
   * arrive through both. The TTL lets a genuine re-download of the same
   * path open again later. */
  createDeduper: function createDeduper(ttlMs, nowFn) {
    ttlMs = (ttlMs == null) ? 30000 : ttlMs;
    nowFn = nowFn || function () { return Date.now(); };
    var seen = {};
    return {
      /* Records the key; returns true if it was already seen within TTL. */
      seen: function (key) {
        var now = nowFn();
        for (var k in seen)
          if (now - seen[k] > ttlMs) delete seen[k];
        if (Object.prototype.hasOwnProperty.call(seen, key)) return true;
        seen[key] = now;
        return false;
      },
      size: function () {
        var n = 0;
        for (var k in seen) n++;
        return n;
      }
    };
  },

  /* Decision pipeline — every "should we open?" rule in one place.
   *
   * info:
   *   state    numeric download state; only DOWNLOAD_FINISHED opens
   *   path     target file path on disk
   *   exists   target file exists on disk
   *   size     target file size in bytes
   *   autoOpen the extensions.archive-manager.autoOpen preference
   * dedup:
   *   optional createDeduper() instance; the path is only marked handled
   *   when the decision is to open, so filtered notifications never
   *   consume the slot.
   *
   * Returns { open: bool, reason: string }. */
  decide: function decide(info, dedup) {
    info = info || {};
    if (!info.autoOpen)
      return { open: false, reason: "disabled" };
    if (info.state !== DownloadFilter.DOWNLOAD_FINISHED)
      return { open: false, reason: "not-finished" };
    var path = (typeof info.path === "string" && info.path) ? info.path : null;
    if (!path)
      return { open: false, reason: "no-path" };
    if (!DownloadFilter.isSupportedArchive(path))
      return { open: false, reason: "not-archive" };
    if (!info.exists || !(info.size > 0))
      return { open: false, reason: "unavailable" };
    if (dedup && dedup.seen(path.toLowerCase()))
      return { open: false, reason: "duplicate" };
    return { open: true, reason: "completed-archive" };
  }
};
