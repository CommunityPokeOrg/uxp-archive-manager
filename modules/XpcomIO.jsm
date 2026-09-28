/* XPCOM file I/O helpers — chrome code only (not used by the test harness).
 *
 * Reading uses nsIFileInputStream + nsIBinaryInputStream; writing uses
 * OS.File.writeAtomic so a failed extraction never leaves a torn file.
 */
"use strict";

var EXPORTED_SYMBOLS = ["XpcomIO"];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

var XpcomIO = {

  readFile: function readFile(pathOrFile) {
    var file = XpcomIO.file(pathOrFile);
    var fis = Cc["@mozilla.org/network/file-input-stream;1"]
                .createInstance(Ci.nsIFileInputStream);
    fis.init(file, 0x01, 0, 0); // PR_RDONLY
    var bis = Cc["@mozilla.org/binaryinputstream;1"]
                .createInstance(Ci.nsIBinaryInputStream);
    try {
      bis.setInputStream(fis);
      var avail = bis.available();
      var arr = bis.readByteArray(avail);
      return new Uint8Array(arr);
    } finally {
      bis.close();
      fis.close();
    }
  },

  file: function file(path) {
    if (path instanceof Ci.nsIFile) return path;
    var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    return f;
  },

  /* Write bytes to path inside a POSIX-safe root. parentPath uses the
   * platform separator; relPath is the sanitized '/'-joined relative path. */
  writeEntry: function writeEntry(rootPath, relPath, data) {
    var target = XpcomIO.join(rootPath, relPath);
    var parent = target.parent;
    if (!parent.exists()) XpcomIO.mkdirs(parent);
    // Atomic write via temp file + rename.
    var buf = data;
    if (typeof OS !== "undefined" && OS.File && OS.File.writeAtomic) {
      OS.File.writeAtomic(target.path, buf, { tmpPath: target.path + ".amtmp" });
    } else {
      var fos = Cc["@mozilla.org/network/file-output-stream;1"]
                  .createInstance(Ci.nsIFileOutputStream);
      fos.init(target, 0x02 | 0x08 | 0x20, 0o644, 0); // WRONLY|CREATE|TRUNCATE
      fos.write(buf.buffer, buf.length);
      fos.close();
    }
    return target;
  },

  join: function join(rootPath, relPath) {
    var f = XpcomIO.file(rootPath);
    var parts = relPath.split("/");
    for (var i = 0; i < parts.length; i++) f.append(parts[i]);
    return f;
  },

  mkdirs: function mkdirs(fileOrPath) {
    var f = XpcomIO.file(fileOrPath);
    if (!f.exists()) f.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  },

  ensureDirPath: function ensureDirPath(rootPath, relDirPath) {
    var f = XpcomIO.join(rootPath, relDirPath);
    if (!f.exists()) XpcomIO.mkdirs(f);
    return f;
  },

  exists: function exists(rootPath, relPath) {
    return XpcomIO.join(rootPath, relPath).exists();
  },

  /* A fresh empty staging directory under the OS temp dir. */
  makeStagingDir: function makeStagingDir() {
    var dir = Cc["@mozilla.org/file/directory_service;1"]
                .getService(Ci.nsIProperties)
                .get("TmpD", Ci.nsIFile);
    dir.append("archive-manager-" + Date.now() + "-" +
               Math.floor(Math.random() * 0x100000));
    dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    return dir;
  },

  /* Recursively enumerate files/dirs under a directory (post-order walk so
   * children precede their parents). */
  walk: function walk(dirFile) {
    var out = [];
    var it = dirFile.directoryEntries;
    while (it.hasMoreElements()) {
      var e = it.getNext().QueryInterface(Ci.nsIFile);
      if (e.isDirectory()) {
        var sub = XpcomIO.walk(e);
        for (var i = 0; i < sub.length; i++) out.push(sub[i]);
        out.push({ file: e, isDir: true });
      } else {
        out.push({ file: e, isDir: false });
      }
    }
    return out;
  },

  removeRecursive: function removeRecursive(fileOrPath) {
    var f = XpcomIO.file(fileOrPath);
    if (f.exists()) f.remove(true);
  },

  defaultDestFor: function defaultDestFor(archivePath) {
    // "foo.tar.xz" -> sibling directory "foo"
    var name = archivePath.replace(/[\\/]+$/, "");
    var slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    var dir = slash >= 0 ? name.slice(0, slash) : ".";
    var base = slash >= 0 ? name.slice(slash + 1) : name;
    base = base.replace(/\.(tar\.(xz|gz|bz2|zst)|tgz|txz|tbz2|zip|rar|7z|tar)$/i, "");
    if (!base) base = "extracted";
    var sep = dir.indexOf("\\") !== -1 ? "\\" : "/";
    return dir + sep + base;
  }
};
