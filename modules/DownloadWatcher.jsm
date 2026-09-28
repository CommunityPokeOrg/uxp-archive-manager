/* DownloadWatcher — UXP download-completion integration.
 *
 * Registers with the platform download manager so that a *completed*
 * .zip/.rar/.7z/.tar/.tar.gz/.tar.xz download opens (or focuses) the
 * Archive Manager window with that file already loaded. Every "should we
 * open?" rule lives in the pure DownloadFilter.jsm module; this file is
 * only the XPCOM plumbing.
 *
 * Platform notes (UXP — Pale Moon, Basilisk, Interlink, ...):
 *  - There are no WebExtension APIs (no browser.*, no downloads.*); the
 *    supported hook is the classic XPCOM download manager
 *    @mozilla.org/download-manager;1 (nsIDownloadManager). Registering an
 *    nsIDownloadProgressListener delivers onDownloadStateChange for every
 *    state transition of every download.
 *  - UXP apps that adopted jsdownloads (Downloads.jsm, e.g. later Pale
 *    Moon / Interlink) additionally get a DownloadList view so completion
 *    is caught through that backend too. The path-keyed deduper in
 *    DownloadFilter collapses any double notification on platforms where
 *    a download surfaces through both.
 *  - Only the FINISHED/succeeded state ever dispatches: in-progress,
 *    failed, canceled and paused downloads are ignored, as are files
 *    that are non-archives, missing, empty or unreadable on disk.
 */
"use strict";

var EXPORTED_SYMBOLS = ["DownloadWatcher"];

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://archive-manager/DownloadFilter.jsm");

/* Preference: extensions.archive-manager.autoOpen (bool, default true).
 * Read at dispatch time so toggling it applies to the very next download. */
const PREF_AUTO_OPEN = "extensions.archive-manager.autoOpen";

const MANAGER_CHROME =
  "chrome://archive-manager/content/archive-manager.xul";
const MANAGER_TYPE = "ArchiveManager"; // <window windowtype=...>
const MANAGER_FEATURES =
  "chrome,centerscreen,resizable=yes,width=760,height=480";
const DEDUP_TTL_MS = 30000;

var DownloadWatcher = {

  _dedup: null,
  _dmListener: null, // nsIDownloadProgressListener
  _dlList: null,     // jsdownloads DownloadList
  _dlView: null,
  errors: [],        // non-fatal install/open errors, for diagnostics

  install: function install() {
    if (this._dedup) return; // already installed
    this._dedup = DownloadFilter.createDeduper(DEDUP_TTL_MS);
    var self = this;

    /* Primary: classic download manager (present on every UXP app). */
    try {
      var dm = Cc["@mozilla.org/download-manager;1"]
                 .getService(Ci.nsIDownloadManager);
      this._dmListener = {
        onDownloadStateChange: function (state, download) {
          self._onLegacyDownload(download);
        },
        onStateChange: function () {},
        onProgressChange: function () {},
        onLocationChange: function () {},
        onSecurityChange: function () {},
        QueryInterface: function (iid) {
          if (iid.equals(Ci.nsIDownloadProgressListener) ||
              iid.equals(Ci.nsISupports))
            return this;
          throw Components.results.NS_ERROR_NO_INTERFACE;
        }
      };
      dm.addListener(this._dmListener);
    } catch (e) {
      this.errors.push("nsIDownloadManager listener unavailable: " + e);
    }

    /* Secondary: jsdownloads view (UXP apps that ship Downloads.jsm).
     * Absence is not an error — the legacy listener covers it. */
    try {
      Cu.import("resource://gre/modules/Downloads.jsm");
      this._dlView = {
        onDownloadAdded: function () {},
        onDownloadChanged: function (download) {
          if (download && download.succeeded)
            self._handle(DownloadFilter.DOWNLOAD_FINISHED,
                         download.target && download.target.path);
        },
        onDownloadRemoved: function () {}
      };
      var view = this._dlView;
      Downloads.getList(Downloads.ALL)
        .then(function (list) {
          self._dlList = list;
          return list.addView(view);
        })
        .then(null, function (e) {
          self.errors.push("DownloadList view registration: " + e);
        });
    } catch (e2) { /* jsdownloads absent on this application */ }
  },

  uninstall: function uninstall() {
    try {
      if (this._dmListener) {
        Cc["@mozilla.org/download-manager;1"]
          .getService(Ci.nsIDownloadManager)
          .removeListener(this._dmListener);
      }
    } catch (e) {}
    this._dmListener = null;
    if (this._dlList && this._dlView) {
      try { this._dlList.removeView(this._dlView); } catch (e2) {}
    }
    this._dlList = null;
    this._dlView = null;
    this._dedup = null;
  },

  /* nsIDownload path: only finished downloads, with a readable targetFile. */
  _onLegacyDownload: function _onLegacyDownload(download) {
    if (!download) return;
    var state;
    try { state = download.state; } catch (e) { return; }
    if (state !== Ci.nsIDownloadManager.DOWNLOAD_FINISHED) return;
    var f = null;
    try { f = download.targetFile; } catch (e2) { f = null; }
    this._handle(DownloadFilter.DOWNLOAD_FINISHED, f ? f.path : null);
  },

  /* Build the decision info and dispatch through the pure filter. */
  _handle: function _handle(state, path) {
    var info = {
      state: state,
      path: path,
      exists: false,
      size: 0,
      autoOpen: this._autoOpenEnabled()
    };
    /* Only stat the file when everything else can pass — finished, enabled,
     * and an archive-looking name — so ordinary downloads cost nothing. */
    if (info.autoOpen && state === DownloadFilter.DOWNLOAD_FINISHED &&
        typeof path === "string" && path &&
        DownloadFilter.isSupportedArchive(path)) {
      var fi = this._fileInfo(path);
      info.exists = fi.exists;
      info.size = fi.size;
    }
    var d = DownloadFilter.decide(info, this._dedup);
    if (d.open) this._openManager(path);
  },

  _autoOpenEnabled: function _autoOpenEnabled() {
    try { return Services.prefs.getBoolPref(PREF_AUTO_OPEN); }
    catch (e) { return true; } // unset pref => auto-open enabled
  },

  _fileInfo: function _fileInfo(path) {
    try {
      var f = new FileUtils.File(path);
      if (!f.exists() || !f.isFile()) return { exists: false, size: 0 };
      return { exists: true, size: f.fileSize };
    } catch (e) {
      return { exists: false, size: 0 };
    }
  },

  /* Focus an already-open manager window and load the file, or open a new
   * one with the path as a window argument. Never touches the archive
   * itself — loading goes through the same ArchiveService.open() the
   * manual flow uses, so all safety checks are unchanged. */
  _openManager: function _openManager(path) {
    try {
      var wm = Services.wm;
      var existing = wm.getMostRecentWindow(MANAGER_TYPE);
      if (existing && existing.ArchiveManagerUI &&
          typeof existing.ArchiveManagerUI.loadArchive === "function") {
        try { existing.focus(); } catch (e) {}
        existing.ArchiveManagerUI.loadArchive(path);
        return;
      }

      var parent = wm.getMostRecentWindow("navigator:browser");
      if (parent && parent.openDialog) {
        parent.openDialog(MANAGER_CHROME, "archive-manager",
                          MANAGER_FEATURES, { archivePath: path });
        return;
      }

      /* No browser window to parent the dialog on (e.g. downloads
       * completing after the last window closed): use the window watcher
       * with an nsISupportsString argument instead. */
      var ww = Cc["@mozilla.org/embedcomp/window-watcher;1"]
                 .getService(Ci.nsIWindowWatcher);
      var arg = Cc["@mozilla.org/supports-string;1"]
                  .createInstance(Ci.nsISupportsString);
      arg.data = path;
      var arr = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
      arr.appendElement(arg, false);
      ww.openWindow(null, MANAGER_CHROME, "archive-manager",
                    MANAGER_FEATURES, arr);
    } catch (e) {
      this.errors.push("open manager: " + e);
    }
  }
};
