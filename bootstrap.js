/* Archive Manager — bootstrapped extension entry point.
 *
 * Chrome registration is declarative via chrome.manifest (content, locale,
 * skin, resource alias and the browser.xul overlay). startup() additionally
 * installs DownloadWatcher, which observes the platform download manager
 * and opens the Archive Manager when a supported archive finishes
 * downloading. No WebExtension APIs are used or required.
 */
"use strict";

const { utils: Cu } = Components;

Cu.import("resource://archive-manager/DownloadWatcher.jsm");

function startup(data, reason) {
  DownloadWatcher.install();
}

function shutdown(data, reason) {
  DownloadWatcher.uninstall();
}

function install(data, reason) {}
function uninstall(data, reason) {}
