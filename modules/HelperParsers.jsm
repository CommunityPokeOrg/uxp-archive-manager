/* Parsers for external helper tool output — pure JavaScript, no XPCOM.
 *
 * parseUnrarLt() parses `unrar lt` technical listings (RAR3 and RAR5).
 * parse7zSlt() parses `7z l -slt` technical listings.
 * Both return the common entry shape used by the other modules.
 */
"use strict";

var EXPORTED_SYMBOLS = ["HelperParsers"];

var HelperParsers = {

  /* `unrar lt` output: repeating blocks, each starting with a "Name:" line,
   * followed by fields like Size:, Packed size:, Attributes:, mtime:. */
  parseUnrarLt: function parseUnrarLt(text) {
    var entries = [];
    var cur = null;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*([^:]+):\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      var key = m[1].trim();
      var val = m[2].trim();
      if (key === "Name") {
        if (cur) entries.push(cur);
        cur = { name: val };
      } else if (cur) {
        if (key === "Size") cur.size = parseInt(val, 10) || 0;
        else if (key === "Packed size") cur.packedSize = parseInt(val, 10) || 0;
        else if (key === "Attributes") cur.attrs = val;
        else if (key === "mtime") cur.mtime = val;
      }
    }
    if (cur) entries.push(cur);

    var out = [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      var attrs = e.attrs || "";
      var isDir = attrs.charAt(0) === "d" || /D/.test(attrs) ||
                  /[\\/]$/.test(e.name);
      var name = e.name.replace(/\\/g, "/");
      if (/[\\/]$/.test(e.name)) name = name.replace(/\/+$/, "");
      out.push({
        index: j,
        name: name,
        type: isDir ? "dir" : "file",
        size: e.size || 0,
        packedSize: e.packedSize || 0,
        methodName: "rar",
        mtime: e.mtime || null
      });
    }
    return out;
  },

  /* `7za l -slt` output: a "--" header block, then per-entry property
   * blocks ("Key = value") separated by blank lines, after the "----------"
   * separator. Directories carry "Attributes = D..." or a trailing '/'. */
  parse7zSlt: function parse7zSlt(text) {
    var lines = text.split(/\r?\n/);
    var sep = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^-{5,}\s*$/.test(lines[i])) { sep = i; break; }
    }
    if (sep === -1) return [];

    var entries = [];
    var cur = null;
    var flush = function () {
      if (cur && cur.name !== undefined && cur.name !== "") entries.push(cur);
      cur = null;
    };
    for (var j = sep + 1; j < lines.length; j++) {
      var line = lines[j];
      if (/^\s*$/.test(line)) { flush(); continue; }
      var m = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (!cur) cur = {};
      var key = m[1].trim();
      var val = m[2].trim();
      if (key === "Path") cur.name = val;
      else if (key === "Size") cur.size = parseInt(val, 10) || 0;
      else if (key === "Packed Size") cur.packedSize = parseInt(val, 10) || 0;
      else if (key === "Attributes") cur.attrs = val;
      else if (key === "Method") cur.method = val;
      else if (key === "Modified") cur.mtime = val;
      else if (key === "Encrypted" && val === "+") cur.encrypted = true;
    }
    flush();

    var out = [];
    for (var k = 0; k < entries.length; k++) {
      var e = entries[k];
      var isDir = (e.attrs || "").charAt(0) === "D" || /[\\/]$/.test(e.name);
      var name = e.name.replace(/\\/g, "/").replace(/\/+$/, "");
      out.push({
        index: k,
        name: name,
        type: isDir ? "dir" : "file",
        size: e.size || 0,
        packedSize: e.packedSize || 0,
        methodName: e.method || "7z",
        encrypted: !!e.encrypted,
        mtime: e.mtime || null
      });
    }
    return out;
  }
};
