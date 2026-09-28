/* Archive Manager main-window controller. XPCOM chrome code — talks to
 * ArchiveService for all archive work; the service never deletes or writes
 * anything without this controller having collected explicit consent.
 */
"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://archive-manager/ArchiveService.jsm");
Cu.import("resource://archive-manager/XpcomIO.jsm");

var ArchiveManagerUI = {

  session: null,
  entries: [],
  prompts: null,

  init: function init() {
    this.prompts = Cc["@mozilla.org/embedcomp/prompt-service;1"]
                     .getService(Ci.nsIPromptService);
    document.getElementById("am-tree").view = this._makeView();

    /* Auto-open path: when the window was opened by DownloadWatcher with a
     * file argument, load it once the window is fully constructed. */
    var initial = this._initialArchivePath();
    if (initial) {
      var self = this;
      window.setTimeout(function () { self.loadArchive(initial); }, 0);
    }
  },

  /* The download watcher passes the target file either as a wrapped object
   * {archivePath} (openDialog), or as an nsISupportsString inside a
   * window.arguments array (nsIWindowWatcher). Accept both, plus a plain
   * string. */
  _initialArchivePath: function _initialArchivePath() {
    var args = window.arguments;
    if (!args || !args.length) return null;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      try {
        if (typeof a === "string" && a) return a;
        if (!a || typeof a !== "object") continue;
        if (typeof a.archivePath === "string" && a.archivePath)
          return a.archivePath;
        if (typeof a.data === "string" && a.data) return a.data; // nsISupportsString
        if (a.wrappedJSObject) {
          var w = a.wrappedJSObject;
          if (typeof w === "string" && w) return w;
          if (w && typeof w.archivePath === "string" && w.archivePath)
            return w.archivePath;
        }
      } catch (e) {}
    }
    return null;
  },

  setStatus: function setStatus(msg) {
    document.getElementById("am-status").value = msg;
  },

  /* ---- archive open ---- */

  openArchive: function openArchive() {
    var fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window, "Select archive", Ci.nsIFilePicker.modeOpen);
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.appendFilter("Archives", "*.zip;*.rar;*.7z;*.tar;*.tar.gz;*.tgz;*.tar.xz;*.txz;*.gz;*.xz");
    if (fp.show() !== Ci.nsIFilePicker.returnOK) return;
    this.loadArchive(fp.file.path);
  },

  loadArchive: function loadArchive(path) {
    this.setStatus("Reading " + path + "…");
    try {
      this.session = ArchiveService.open(path);
    } catch (e) {
      this.session = null;
      this.entries = [];
      document.getElementById("am-tree").view = this._makeView();
      this.prompts.alert(window, "Archive Manager",
        "Could not open archive:\n" + e.message);
      this.setStatus("Open failed");
      return;
    }
    this.entries = this.session.entries;
    document.getElementById("am-archive-label").value = this.session.archivePath;
    document.getElementById("am-backend").value =
      this.session.format + " — " + this.session.meta.backend;
    document.getElementById("am-dest").value =
      XpcomIO.defaultDestFor(this.session.archivePath);
    document.getElementById("am-extract-all").disabled = false;
    document.getElementById("am-extract-sel").disabled = false;
    document.getElementById("am-tree").view = this._makeView();
    var unsafe = this.entries.filter(function (e) { return e.unsafe; }).length;
    this.setStatus(this.entries.length + " entries" +
      (unsafe ? " — " + unsafe + " unsafe entries will be skipped" : ""));
  },

  pickDest: function pickDest() {
    var fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window, "Select destination folder", Ci.nsIFilePicker.modeGetFolder);
    if (fp.show() === Ci.nsIFilePicker.returnOK)
      document.getElementById("am-dest").value = fp.file.path;
  },

  /* ---- extraction with layered confirmations ---- */

  extract: function extract(all) {
    if (!this.session) return;
    var dest = document.getElementById("am-dest").value;
    if (!dest) {
      this.prompts.alert(window, "Archive Manager", "Pick a destination folder.");
      return;
    }

    var wanted = null;
    if (!all) {
      wanted = [];
      var view = document.getElementById("am-tree").view;
      var sel = view.selection;
      var count = {};
      for (var i = 0; i < sel.getRangeCount(); i++) {
        var min = {}, max = {};
        sel.getRangeAt(i, min, max);
        for (var r = min.value; r <= max.value; r++)
          wanted.push(this.entries[r].index);
      }
      if (wanted.length === 0) {
        this.prompts.alert(window, "Archive Manager", "No entries selected.");
        return;
      }
    }

    var n = wanted ? wanted.length : this.entries.length;
    // Confirmation #1: extraction itself, with destination shown.
    if (!this.prompts.confirm(window, "Extract archive",
          "Extract " + n + " entr" + (n === 1 ? "y" : "ies") + " to:\n" + dest))
      return;

    var meter = document.getElementById("am-progress");
    meter.collapsed = false;
    var self = this;
    var result;
    try {
      result = ArchiveService.extract(this.session, wanted, dest, {
        progress: function (done, total, name) {
          meter.value = total ? Math.round(100 * done / total) : 0;
          self.setStatus("Extracting " + name);
        },
        confirmOverwrite: function (rel) {
          return self.prompts.confirm(window, "Overwrite file?",
            "File already exists:\n" + dest + "/" + rel + "\n\nOverwrite it?");
        }
      });
    } catch (e) {
      meter.collapsed = true;
      this.prompts.alert(window, "Archive Manager", "Extraction failed:\n" + e.message);
      this.setStatus("Extraction failed");
      return;
    }
    meter.collapsed = true;

    var msg = "Extraction finished.\n" +
              result.written.length + " written, " +
              result.skipped.length + " skipped, " +
              result.failed.length + " failed.";
    if (result.failed.length) {
      msg += "\n\nFirst failure: " + result.failed[0].name +
             " — " + result.failed[0].error;
    }
    this.setStatus(msg.replace(/\n/g, " "));

    // Confirmation #2: archive deletion — only when the user explicitly
    // opted in via the checkbox, and only after a second explicit confirm.
    var deleteRequested = document.getElementById("am-delete").checked;
    if (deleteRequested && result.failed.length === 0) {
      if (this.prompts.confirm(window, "Delete archive?",
            "Delete the source archive permanently?\n" +
            this.session.archivePath +
            "\n\nThis cannot be undone.")) {
        try {
          if (ArchiveService.deleteArchive(this.session))
            msg += "\nArchive deleted.";
          else
            msg += "\nArchive could not be deleted.";
        } catch (e2) {
          msg += "\nArchive delete failed: " + e2.message;
        }
      } else {
        msg += "\nArchive kept.";
      }
    } else if (deleteRequested && result.failed.length) {
      msg += "\nArchive kept because some entries failed.";
    }
    this.prompts.alert(window, "Archive Manager", msg);
    this.setStatus("Done");
  },

  /* ---- flat tree view ---- */

  _makeView: function _makeView() {
    var self = this;
    return {
      treeBox: null,
      selection: null,
      get rowCount() { return self.entries.length; },
      setTree: function (tb) { this.treeBox = tb; },
      getCellText: function (row, col) {
        var e = self.entries[row];
        if (!e) return "";
        switch (col.id || col) {
          case "am-col-name":   return e.unsafe ? "⚠ " + e.name : e.name;
          case "am-col-size":   return e.type === "file" ? String(e.size) : "";
          case "am-col-packed": return e.type === "file" ? String(e.packedSize) : "";
          case "am-col-method": return e.methodName || "";
          case "am-col-type":
            return e.unsafe ? "unsafe — skipped" :
              (e.type === "symlink" ? "symlink → " + e.linkTarget :
               e.type === "hardlink" ? "hardlink → " + e.linkTarget : e.type);
        }
        return "";
      },
      isContainer: function () { return false; },
      isContainerOpen: function () { return false; },
      isContainerEmpty: function () { return false; },
      isSeparator: function () { return false; },
      isSorted: function () { return false; },
      getLevel: function () { return 0; },
      getImageSrc: function () { return null; },
      getRowProperties: function () { return ""; },
      getCellProperties: function (row, col) {
        return self.entries[row] && self.entries[row].unsafe ? "unsafe" : "";
      },
      getColumnProperties: function () { return ""; },
      cycleHeader: function () {},
      cycleCell: function () {},
      performAction: function () {},
      performActionOnRow: function () {},
      performActionOnCell: function () {},
      getParentIndex: function () { return -1; },
      hasNextSibling: function () { return false; },
      canDrop: function () { return false; },
      drop: function () {}
    };
  }
};
