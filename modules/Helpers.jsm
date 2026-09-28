/* External helper-process integration — chrome code only.
 *
 * UXP has no usable stdout-capture API for nsIProcess, so runCapture() runs
 * the helper through a POSIX shell (/bin/sh -c '... > out') or cmd.exe /c on
 * Windows, redirecting output to a temp file that is then read back.
 * Helpers are discovered on PATH plus a few well-known locations.
 *
 * Every spawn is synchronous (nsIProcess.run with blocking=true): the UI
 * stays responsive-looking by running extraction after the confirmation
 * dialog; the README documents this limitation.
 */
"use strict";

var EXPORTED_SYMBOLS = ["Helpers"];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://archive-manager/XpcomIO.jsm");

function localFile(path) {
  var f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  return f;
}

function env(name) {
  var e = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
  return e.exists(name) ? e.get(name) : "";
}

function isWindows() {
  return /^WIN/.test(Cc["@mozilla.org/xre/app-info;1"]
                     .getService(Ci.nsIXULRuntime).OS);
}

function findExecutable(names, extraDirs) {
  var dirs = [];
  var path = env("PATH");
  if (path) {
    var sep = isWindows() ? ";" : ":";
    dirs = dirs.concat(path.split(sep));
  }
  if (extraDirs) dirs = dirs.concat(extraDirs);
  var exts = isWindows() ? [".exe", ""] : [""];
  for (var i = 0; i < dirs.length; i++) {
    for (var j = 0; j < names.length; j++) {
      for (var k = 0; k < exts.length; k++) {
        try {
          var f = localFile(dirs[i]);
          f.append(names[j] + exts[k]);
          if (f.exists() && f.isFile() && f.isExecutable()) return f.path;
        } catch (e) {}
      }
    }
  }
  return null;
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

var Helpers = {

  /* Locate a helper binary for a logical tool id, or null. */
  find: function find(tool) {
    switch (tool) {
      case "unrar":
        return findExecutable(["unrar", "rar"],
          ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin",
           "C:\\Program Files\\WinRAR", "C:\\Program Files (x86)\\WinRAR"]);
      case "7za":
        return findExecutable(["7za", "7zr", "7z"],
          ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/usr/lib/p7zip",
           "C:\\Program Files\\7-Zip", "C:\\Program Files (x86)\\7-Zip"]);
      case "xz":
        return findExecutable(["xz"],
          ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]);
      case "tar":
        return findExecutable(["bsdtar", "tar", "gtar"],
          ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]);
    }
    return null;
  },

  /* Which helper binaries are present: {unrar, 7za, xz, tar} -> path|null. */
  detect: function detect() {
    return {
      unrar: Helpers.find("unrar"),
      "7za": Helpers.find("7za"),
      xz: Helpers.find("xz"),
      tar: Helpers.find("tar")
    };
  },

  /* Run a process, synchronously. args is a plain string array. */
  run: function run(exePath, args) {
    var p = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    p.init(localFile(exePath));
    p.run(true, args, args.length);
    return p.exitValue;
  },

  /* Run a helper and capture its stdout text via a temp redirect file. */
  runCapture: function runCapture(exePath, args) {
    var out = FileUtils.getFile("TmpD",
      ["am-cap-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".txt"]);
    out.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    try {
      var rc;
      if (isWindows()) {
        var quoted = ["\"" + exePath + "\""]
          .concat(args.map(function (a) { return "\"" + a + "\""; })).join(" ");
        rc = Helpers.run(env("COMSPEC") || "C:\\Windows\\System32\\cmd.exe",
          ["/c", quoted + " > \"" + out.path + "\""]);
      } else {
        var cmd2 = [shQuote(exePath)].concat(args.map(shQuote)).join(" ") +
                   " > " + shQuote(out.path);
        rc = Helpers.run("/bin/sh", ["-c", cmd2]);
      }
      var text = "";
      try { text = XpcomIO.readFile(out); } catch (e) { text = new Uint8Array(0); }
      var s = "";
      for (var i = 0; i < text.length; i++) s += String.fromCharCode(text[i]);
      return { exitCode: rc, stdout: s };
    } finally {
      try { out.remove(false); } catch (e) {}
    }
  },

  /* Listing commands per backend. */
  listWith: function listWith(tool, exePath, archivePath) {
    if (tool === "unrar")
      return Helpers.runCapture(exePath,
        ["lt", "-c-", "-p-", "--", archivePath]);
    if (tool === "7za")
      return Helpers.runCapture(exePath,
        ["l", "-slt", "-p-", "--", archivePath]);
    throw new Error("no listing support for helper " + tool);
  },

  /* Extract the whole archive into a staging directory. */
  extractTo: function extractTo(tool, exePath, archivePath, stagingDir) {
    if (tool === "unrar")
      return Helpers.run(exePath,
        ["x", "-o+", "-inul", "-c-", "-p-", "--", archivePath, stagingDir + "/"]);
    if (tool === "7za")
      return Helpers.run(exePath,
        ["x", "-y", "-p-", "-o" + stagingDir, "--", archivePath]);
    if (tool === "tar")
      return Helpers.run(exePath, ["-xf", archivePath, "-C", stagingDir]);
    throw new Error("no extract support for helper " + tool);
  }
};
