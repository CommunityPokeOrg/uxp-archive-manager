/* ArchiveService — orchestrator wiring the pure parsers, js-ctypes bindings
 * and external helpers behind one reader interface.
 *
 * open(path)  -> session {format, entries, meta, archivePath}
 * extract(session, wanted|null, destDir, opts) -> {written, skipped, failed}
 * deleteArchive(session) -> permanent deletion, only after UI confirmation
 *
 * Backend selection:
 *   .zip            pure JS (parse + stored + pure-JS deflate)
 *   .tar / .tar.gz  pure JS (tar parser; gzip via pure-JS inflate)
 *   .tar.xz         pure JS tar over liblzma via js-ctypes; fallbacks:
 *                   xz helper (stdout redirect), 7za staging, tar -xJ staging
 *   .rar            unrar subprocess (staging extract); fallback: 7za
 *   .7z             7za/7zr subprocess (staging extract); fallback: libarchive? (none)
 *
 * Extraction for helper formats goes to a staging dir first; every staged
 * path is then sanitized by SafePath before it is relocated into the real
 * destination, so helper output can never escape the extraction root.
 */
"use strict";

var EXPORTED_SYMBOLS = ["ArchiveService"];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://archive-manager/Bytes.jsm");
Cu.import("resource://archive-manager/Inflate.jsm");
Cu.import("resource://archive-manager/SafePath.jsm");
Cu.import("resource://archive-manager/ZipFormat.jsm");
Cu.import("resource://archive-manager/TarFormat.jsm");
Cu.import("resource://archive-manager/GzipFormat.jsm");
Cu.import("resource://archive-manager/HelperParsers.jsm");
Cu.import("resource://archive-manager/XpcomIO.jsm");
Cu.import("resource://archive-manager/Helpers.jsm");
Cu.import("resource://archive-manager/CtypesNative.jsm");

ZipFormat.init(Bytes, Inflate);
TarFormat.init(Bytes);
GzipFormat.init(Bytes, Inflate);

function magic(buf, str, off) {
  off = off || 0;
  if (buf.length < off + str.length) return false;
  for (var i = 0; i < str.length; i++)
    if (buf[off + i] !== str.charCodeAt(i)) return false;
  return true;
}

var ArchiveService = {

  /* Detect the archive format from magic bytes plus filename. */
  detectFormat: function detectFormat(buf, path) {
    if (buf.length >= 4 && (Bytes.u32(buf, 0) === 0x04034b50 ||
                            Bytes.u32(buf, 0) === 0x08074b50 ||
                            Bytes.u32(buf, 0) === 0x06054b50 ||
                            (buf[0] === 0x50 && buf[1] === 0x4b)))
      return "zip";
    if (magic(buf, "Rar!")) return "rar";
    if (buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7a &&
        buf[2] === 0xbc && buf[3] === 0xaf && buf[4] === 0x27 && buf[5] === 0x1c)
      return "7z";
    if (buf.length >= 6 && buf[0] === 0xfd && buf[1] === 0x37 &&
        buf[2] === 0x7a && buf[3] === 0x58 && buf[4] === 0x5a && buf[5] === 0x00)
      return "xz";
    if (GzipFormat.isGzip(buf)) return "gzip";
    if (buf.length > 512 && Bytes.ascii(buf, 257, 5) === "ustar") return "tar";
    // Fall back to extension for empty/corner cases.
    if (/\.zipx?$/i.test(path)) return "zip";
    if (/\.rar$/i.test(path)) return "rar";
    if (/\.7z$/i.test(path)) return "7z";
    if (/\.(tar\.xz|txz|xz)$/i.test(path)) return "xz";
    if (/\.(tar\.gz|tgz|gz)$/i.test(path)) return "gzip";
    if (/\.tar$/i.test(path)) return "tar";
    throw new Error("unrecognized archive format");
  },

  /* Open an archive: detect format, parse/probe, return session. */
  open: function open(archivePath) {
    var buf = XpcomIO.readFile(archivePath);
    var format = ArchiveService.detectFormat(buf, archivePath);
    var session = {
      archivePath: archivePath,
      format: format,
      entries: [],
      meta: {}
    };

    var tools = Helpers.detect();

    switch (format) {
      case "zip": {
        var z = ZipFormat.parse(buf);
        session.entries = z.entries;
        session.comment = z.comment;
        session.meta.backend = "built-in parser (pure JS)";
        session.data = buf;
        break;
      }
      case "tar": {
        session.entries = TarFormat.parse(buf).entries;
        session.meta.backend = "built-in parser (pure JS)";
        session.data = buf;
        break;
      }
      case "gzip": {
        var inner = GzipFormat.decompress(buf);
        if (inner.length > 512 && Bytes.ascii(inner, 257, 5) === "ustar") {
          session.format = "tar.gz";
          session.entries = TarFormat.parse(inner).entries;
          session.meta.backend = "built-in parser (pure JS gunzip+tar)";
          session.data = inner;
        } else {
          session.format = "gz";
          var base = archivePath.replace(/[\\/]+$/, "")
                                .replace(/^.*[\\/]/, "").replace(/\.gz$/i, "");
          session.entries = [{ index: 0, name: base, type: "file",
                               size: inner.length, packedSize: buf.length,
                               methodName: "deflate" }];
          session.meta.backend = "built-in parser (pure JS gunzip)";
          session.data = inner;
        }
        break;
      }
      case "xz": {
        // 1) liblzma via js-ctypes, 2) xz helper -> tar bytes,
        // 3) 7za -> staging produces a .tar, 4) system tar -> staging.
        var innerX = null;
        try { innerX = CtypesNative.lzmaDecode(buf, 0); }
        catch (e) { /* fall through to helpers */ }
        if (innerX) {
          session.format = "tar.xz";
          session.entries = TarFormat.parse(innerX).entries;
          session.meta.backend = "liblzma via js-ctypes + built-in tar parser";
          session.data = innerX;
        } else if (tools.xz) {
          var rx = Helpers.runCapture(tools.xz, ["-dc", archivePath]);
          if (rx.exitCode !== 0) throw new Error("xz -dc failed");
          innerX = rx.stdoutBytes || textToBytes(rx.stdout);
          session.format = "tar.xz";
          session.entries = TarFormat.parse(innerX).entries;
          session.meta.backend = "xz helper + built-in tar parser";
          session.data = innerX;
        } else if (tools["7za"] || tools.tar) {
          // Staging path: listing still needs entry names, so use the
          // generic staged pipeline.
          var tool = tools["7za"] ? "7za" : "tar";
          var exe = tools[tool];
          var sess = ArchiveService._stagedSession(session, tool, exe, archivePath);
          session.entries = sess.entries;
          session.meta.backend = tool + " helper (staged extraction)";
          session.meta.staged = true;
        } else {
          throw new Error("cannot decode .xz: no liblzma, xz, 7za or tar found");
        }
        break;
      }
      case "rar": {
        if (tools.unrar) {
          var r = Helpers.listWith("unrar", tools.unrar, archivePath);
          session.entries = HelperParsers.parseUnrarLt(r.stdout);
          session.meta.backend = "unrar subprocess: " + tools.unrar;
          session.meta.tool = "unrar";
          session.meta.exe = tools.unrar;
        } else if (tools["7za"]) {
          var r7 = Helpers.listWith("7za", tools["7za"], archivePath);
          session.entries = HelperParsers.parse7zSlt(r7.stdout);
          session.meta.backend = "7za subprocess (RAR read): " + tools["7za"];
          session.meta.tool = "7za";
          session.meta.exe = tools["7za"];
        } else {
          throw new Error("RAR support needs the 'unrar' or '7z' tool — see README");
        }
        break;
      }
      case "7z": {
        if (!tools["7za"])
          throw new Error("7z support needs the '7z'/'7za' (p7zip) tool — see README");
        var r8 = Helpers.listWith("7za", tools["7za"], archivePath);
        session.entries = HelperParsers.parse7zSlt(r8.stdout);
        session.meta.backend = "7za subprocess: " + tools["7za"];
        session.meta.tool = "7za";
        session.meta.exe = tools["7za"];
        break;
      }
    }

    // Annotate sanitized names up front so the UI can mark unsafe entries.
    for (var i = 0; i < session.entries.length; i++) {
      var e = session.entries[i];
      try { e.safeName = SafePath.sanitize(e.name); e.unsafe = false; }
      catch (err) { e.safeName = null; e.unsafe = true; }
    }
    return session;
  },

  _stagedSession: function _stagedSession(session, tool, exe, archivePath) {
    // For formats where listing is only possible by extracting (tar.xz via
    // 7za/tar staging), stage first and list the staged tree.
    var staging = XpcomIO.makeStagingDir();
    try {
      var rc = Helpers.extractTo(tool, exe, archivePath, staging.path);
      if (rc !== 0) throw new Error(tool + " extract failed (exit " + rc + ")");
      var found = ArchiveService._listStaging(staging, tool === "7za");
      session.meta._staging = staging; // reuse for extract step
      return { entries: found };
    } catch (e) {
      XpcomIO.removeRecursive(staging);
      throw e;
    }
  },

  /* Turn a staged tree into entries (7za may emit a lone .tar we open). */
  _listStaging: function _listStaging(staging, openInnerTar) {
    var entries = [];
    var walked = XpcomIO.walk(staging);
    for (var i = 0; i < walked.length; i++) {
      var w = walked[i];
      if (w.isDir) continue;
      var rel = w.file.path.slice(staging.path.length + 1).replace(/\\/g, "/");
      if (openInnerTar && walked.length === 1 && /\.tar$/i.test(w.file.leafName)) {
        var inner = XpcomIO.readFile(w.file);
        try {
          var t = TarFormat.parse(inner);
          return t.entries.map(function (e, idx) {
            e._tarFile = w.file.path;
            return e;
          });
        } catch (e2) { /* fall through: treat as plain file */ }
      }
      entries.push({ index: entries.length, name: rel,
                     type: "file", size: w.file.fileSize,
                     packedSize: 0, methodName: "helper" });
    }
    return entries;
  },

  /* Extract entries. wanted === null means all. opts:
   *   confirmOverwrite(relPath) -> bool (required when overwriting allowed)
   *   progress(done, total, name)
   *   limits — SafePath limits override
   * Returns {written:[], skipped:[], failed:[{name,error}]} */
  extract: function extract(session, wanted, destDir, opts) {
    opts = opts || {};
    var chosen = [];
    for (var i = 0; i < session.entries.length; i++) {
      var e = session.entries[i];
      if (wanted !== null && wanted.indexOf(e.index) === -1) continue;
      chosen.push(e);
    }
    SafePath.checkLimits(chosen, opts.limits);

    var result = { written: [], skipped: [], failed: [] };
    if (session.meta.staged || session.meta.tool) {
      ArchiveService._extractStaged(session, chosen, destDir, opts, result);
    } else {
      ArchiveService._extractPure(session, chosen, destDir, opts, result);
    }
    return result;
  },

  _extractPure: function _extractPure(session, chosen, destDir, opts, result) {
    var writtenPaths = {};
    for (var i = 0; i < chosen.length; i++) {
      var e = chosen[i];
      if (opts.progress) opts.progress(i, chosen.length, e.name);
      try {
        var rel = e.safeName || SafePath.sanitize(e.name);
        if (e.type === "dir") {
          XpcomIO.ensureDirPath(destDir, rel);
          continue;
        }
        if (e.type === "symlink" || e.type === "hardlink") {
          // Only in-root links; created via libc when available.
          var resolved = SafePath.checkLinkTarget(rel, e.linkTarget || "");
          if (!CtypesNative.createLink(
                e.type === "hardlink" ? "hardlink" : "symlink",
                resolved,
                XpcomIO.join(destDir, rel).path))
            result.skipped.push(e.name + " (link creation unsupported here)");
          else result.written.push(rel);
          continue;
        }
        if (e.type !== "file") { result.skipped.push(e.name); continue; }

        if (XpcomIO.exists(destDir, rel) && !writtenPaths[rel]) {
          if (!opts.confirmOverwrite || !opts.confirmOverwrite(rel)) {
            result.skipped.push(e.name); continue;
          }
        }
        var data = ArchiveService._entryBytes(session, e);
        XpcomIO.writeEntry(destDir, rel, data);
        writtenPaths[rel] = true;
        result.written.push(rel);
      } catch (err) {
        result.failed.push({ name: e.name, error: String(err) });
      }
    }
  },

  _entryBytes: function _entryBytes(session, e) {
    switch (session.format) {
      case "zip": return ZipFormat.decompress(session.data, e);
      case "tar":
      case "tar.gz":
      case "tar.xz": return TarFormat.payload(session.data, e);
      case "gz": return session.data;
    }
    throw new Error("no byte source for format " + session.format);
  },

  _extractStaged: function _extractStaged(session, chosen, destDir, opts, result) {
    var tool = session.meta.tool;
    var staging = session.meta._staging || null;
    var ownStaging = false;
    if (!staging) {
      staging = XpcomIO.makeStagingDir();
      ownStaging = true;
    }
    try {
      if (ownStaging) {
        if (!tool) throw new Error("internal: staged extract without a tool");
        var rc = Helpers.extractTo(tool, session.meta.exe,
                                   session.archivePath, staging.path);
        if (rc !== 0)
          throw new Error(tool + " extract failed (exit " + rc + ")");
      }
      // Build map relStagedPath -> staged file.
      var walked = XpcomIO.walk(staging);
      var stagedFiles = {};
      var innerTar = null;
      for (var i = 0; i < walked.length; i++) {
        var w = walked[i];
        if (w.isDir) continue;
        var rel = w.file.path.slice(staging.path.length + 1).replace(/\\/g, "/");
        stagedFiles[rel] = w.file;
      }
      // 7za on .tar.xz leaves a single .tar: expand into the tree via tar.
      var keys = Object.keys(stagedFiles);
      if (keys.length === 1 && /\.tar$/i.test(keys[0])) {
        innerTar = stagedFiles[keys[0]];
        var data = XpcomIO.readFile(innerTar);
        var t;
        try { t = TarFormat.parse(data); } catch (e3) { t = null; }
        if (t) {
          // Serve entries straight from the tar bytes (same as pure path).
          var sess2 = { format: "tar", data: data, entries: t.entries };
          ArchiveService._extractPure(sess2, chosen, destDir, opts, result);
          return;
        }
      }

      for (var rel2 in stagedFiles) {
        var f = stagedFiles[rel2];
        if (f.isSymlink && f.isSymlink()) {
          result.skipped.push(rel2 + " (symlink skipped)");
          continue;
        }
        var safe;
        try { safe = SafePath.sanitize(rel2); }
        catch (e4) { result.failed.push({ name: rel2, error: String(e4) }); continue; }
        var wantedEntry = matchChosen(chosen, safe, rel2);
        if (!wantedEntry) continue;
        if (opts.progress) opts.progress(result.written.length, chosen.length, rel2);
        try {
          if (XpcomIO.exists(destDir, safe)) {
            if (!opts.confirmOverwrite || !opts.confirmOverwrite(safe)) {
              result.skipped.push(rel2); continue;
            }
          }
          var bytes = XpcomIO.readFile(f);
          XpcomIO.writeEntry(destDir, safe, bytes);
          result.written.push(safe);
        } catch (err2) {
          result.failed.push({ name: rel2, error: String(err2) });
        }
      }
      // Directories chosen but empty: ensure they exist.
      for (var d = 0; d < chosen.length; d++) {
        if (chosen[d].type === "dir" && chosen[d].safeName) {
          try { XpcomIO.ensureDirPath(destDir, chosen[d].safeName); }
          catch (e5) {}
        }
      }
    } finally {
      XpcomIO.removeRecursive(staging);
      if (session.meta._staging === staging) session.meta._staging = null;
    }

    function matchChosen(list, safe, rel) {
      for (var i = 0; i < list.length; i++) {
        var nm = list[i].name.replace(/\\/g, "/").replace(/\/+$/, "");
        if (nm === rel || nm === safe) return list[i];
      }
      return null;
    }
  },

  /* Permanently delete the source archive. Call ONLY after the user's
   * explicit opt-in checkbox and a separate confirmation dialog. */
  deleteArchive: function deleteArchive(session) {
    var f = XpcomIO.file(session.archivePath);
    if (!f.exists()) return false;
    f.remove(false);
    return !f.exists();
  }
};

function textToBytes(s) {
  var a = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}
