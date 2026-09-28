# uxp-archive-manager

A classic (bootstrapped / XUL-overlay) extension for **Unified XUL Platform**
browsers — Pale Moon, Basilisk and other UXP applications — that inspects and
extracts archive files: **ZIP, TAR, TAR.GZ, TAR.XZ, RAR and 7z**.

It shows an archive's full listing (names, sizes, packed sizes, compression
method, entry type) *before* anything is extracted, extracts all or selected
entries to a destination folder (default: a folder next to the archive), and
can — only when the user explicitly opts in — delete the source archive after
a successful extraction.

This is **not** a WebExtension. It uses XPCOM, `chrome.manifest`, an
`install.rdf` manifest and a XUL window.

---

## Features

- **Open** any supported archive through *Tools → Archive Manager → Open archive…*
- **Inspect** the entry list in a sortable-by-selection XUL tree before
  extracting: path, uncompressed size, packed size, method, entry type
  (file/dir/symlink/hardlink). Unsafe entries (path traversal, etc.) are
  flagged ⚠ in red and are never extracted.
- **Extract all** or **Extract selected** to a chosen folder.
- **Delete-after-extract** is opt-in only: a checkbox (unchecked by default)
  plus a *separate* confirmation dialog *after* extraction completes. The
  archive is never deleted silently, automatically, or when any entry failed.
- **Safe extraction**: every entry path is sanitized and the archive is
  screened by zip-bomb limits before a single byte is written.

## Install

```sh
make xpi        # builds archive-manager.xpi
```

In the browser: `about:addons` → gear menu → *Install Add-on From File…*.

For development without packaging, create a file named
`archive-manager@communitypoke.org` in the profile's `extensions/` directory
containing the absolute path to this repo checkout.

## Usage

1. **Tools → Archive Manager**
2. **Open archive…** and pick a `.zip` / `.rar` / `.7z` / `.tar` / `.tar.gz` /
   `.tar.xz` file. The toolbar shows the detected format and which backend
   (built-in parser, liblzma, unrar, 7za) handles it.
3. Review the listing. Entries marked "unsafe — skipped" failed path
   sanitization and cannot be extracted.
4. Pick a destination (defaults to a sibling folder named after the archive),
   optionally tick **Delete archive after successful extraction**.
5. **Extract all** or select rows and **Extract selected**. A confirmation
   dialog shows the destination before anything is written. Existing files
   are never overwritten without a per-file overwrite prompt.
6. If deletion was requested, a *second* confirmation explicitly asks before
   the archive is permanently removed.

## What a UXP extension can and cannot do

UXP runs classic XPCOM extensions with full chrome privileges — essentially
everything the browser itself can do. The relevant surface:

| Capability | Mechanism | Used here |
|---|---|---|
| File I/O | `nsIFile` / `nsIFileInputStream` / `nsIBinaryInputStream`, `OS.File` | reading archives, atomic entry writes |
| Process execution | `nsIProcess` (blocking; **no stdout capture**) | unrar / 7za / xz helpers; output captured via shell redirection to a temp file |
| Native libraries | **js-ctypes** | `liblzma` (`lzma_stream_buffer_decode`) for .xz; `libc` `symlink()`/`link()` for in-root link recreation |
| UI | XUL overlay + XUL window, `nsIPromptService`, `nsIFilePicker`, `nsITreeView` | whole UI |
| WebExtension APIs | **absent** — no `browser.*`, no `downloads`, no `runtime` | nothing |

Consequences:

- **No sandbox.** A chrome extension runs with the browser's privileges, which
  is exactly why the extraction path is hardened (see Security model).
- **No async subprocess API.** `nsIProcess.run` blocks. Listings/extractions
  via helpers block the window for the duration; this is acceptable for the
  archive sizes targeted, and documented.
- **No stdout capture.** `nsIProcess` cannot read a child's stdout on UXP, so
  helper output is captured by spawning `/bin/sh -c 'tool … > tmpfile'`
  (or `cmd.exe /c` on Windows) and reading the temp file.
- **No `fetch`/network needed** — the extension is fully offline.

### Privileges requested

`install.rdf` declares a bootstrapped type-2 extension; UXP chrome extensions
implicitly run with full privileges — there is no permission list like
WebExtensions'. The only requirements are `em:bootstrap=true` and the
`chrome.manifest` registrations (`content`, `locale`, `skin`, `resource`
alias, one `overlay`).

## Format support & dependencies

| Format | Listing | Extraction | Implementation | External dependency |
|---|---|---|---|---|
| `.zip` | ✅ | ✅ stored + deflate | pure JS central-directory parser + pure JS DEFLATE decoder (`modules/Inflate.jsm`) | none |
| `.tar` | ✅ | ✅ | pure JS ustar/pax/GNU-longname parser | none |
| `.tar.gz` `.tgz` | ✅ | ✅ | pure JS gzip unwrap + inflate + tar parser | none |
| `.gz` (single file) | ✅ | ✅ | pure JS | none |
| `.tar.xz` `.txz` | ✅ | ✅ | `liblzma` via **js-ctypes** → tar parser; fallbacks: `xz -dc` helper → tar parser, `7za`/`tar` staged extract | liblzma *(built-in on most OSes)*, else `xz`, `7za` or `tar` on PATH |
| `.rar` | ✅ | ✅ | `unrar lt`/`unrar x` subprocess → staged extraction | **unrar** (or `7z` as fallback — note older p7zip builds lack RAR5) |
| `.7z` | ✅ | ✅ | `7za l -slt`/`7za x` subprocess → staged extraction | **7za/7zr/7z** (p7zip or 7-Zip) |

Install helpers so they're on `PATH`; common locations
(`/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `C:\Program Files\7-Zip`,
`C:\Program Files\WinRAR`) are also probed.

### RAR3 vs RAR5

Coverage follows the installed `unrar`: `unrar` ≥ 5 reads both RAR3 and RAR5;
older `unrar` and some `7za` builds read RAR3 only. The backend used is shown
in the window toolbar.

### Known limitations

- **Encrypted archives are not supported** (ZIP Crypto/AES, RAR, 7z
  encryption). Encrypted entries are listed with an `encrypted` flag and
  extraction fails with a clear error.
- ZIP compression methods beyond stored/deflate (bzip2, LZMA, ZSTD, PPMd,
  Deflate64) are listed but rejected on extraction.
- Multi-disk/spanned ZIPs and the ZIP64 EOCD locator are rejected; the ZIP64
  extra field *is* read for >4 GiB size/offset fields.
- TAR device nodes, fifos and sparse files are listed but never materialized.
- Symlinks/hardlinks are recreated only on POSIX via `libc` and only when the
  target stays inside the extraction root; otherwise skipped.
- Helper-based extraction runs synchronously (nsIProcess blocks).

## Security model — safe extraction

Every entry, from every backend, passes `SafePath.sanitize()` *before* a file
path is formed. Rejected outright:

- `..` path components (after `\` → `/` normalization and Unicode NFC)
- absolute paths (`/…`, `\\server\…` UNC)
- drive letters (`C:\…`, `c:/…`)
- NUL and control characters
- Windows device names (`CON`, `NUL`, `AUX`, `COM1–9`, `LPT1–9`)
- trailing dots/spaces per component (Windows silently strips them →
  collision/oracle attacks)
- names that normalize to the extraction root itself

Additional guards:

- **Symlinks/hardlinks**: `SafePath.checkLinkTarget()` resolves the target
  relative to the link's parent inside the extraction root; anything escaping
  is rejected. Links are never created on platforms without `libc`.
- **Zip-bomb limits** (`SafePath.limits`): 100k entry cap, 2 GiB per file,
  4 GiB total, 100:1 compressed→uncompressed ratio cap — configurable per call.
- **Staged helper extraction**: unrar/7za/tar never write to the real
  destination. They extract to a private temp dir; every staged path is then
  sanitized and moved into place. Staged symlinks are skipped.
- **Overwrite consent**: existing files prompt per file; declining skips that
  entry.
- **Atomic writes**: `OS.File.writeAtomic` writes to a temp name and renames.
- **Delete-after-extract**: off by default, requires the checkbox *and* a
  post-extraction confirmation, and is refused when any entry failed.

## Architecture

```
chrome/content/archive-manager.xul/js   XUL window + tree view + consent flow
chrome/content/overlay.xul              Tools-menu entry
modules/
  ArchiveService.jsm   orchestrator: detect → open → extract → (confirm) delete
  SafePath.jsm         *pure* path sanitizer + link/zip-bomb checks
  ZipFormat.jsm        *pure* ZIP parser/decompressor
  TarFormat.jsm        *pure* ustar/pax/GNU tar parser
  GzipFormat.jsm       *pure* RFC 1952 unwrap
  Inflate.jsm          *pure* DEFLATE decoder (puff.c design)
  Bytes.jsm            *pure* byte utils, CRC-32, CP437/UTF-8 decoding
  HelperParsers.jsm    *pure* `unrar lt` / `7z l -slt` output parsers
  CtypesNative.jsm     js-ctypes: liblzma decode, libc symlink/link
  Helpers.jsm          nsIProcess helpers: discovery, run, stdout capture
  XpcomIO.jsm          nsIFile/OS.File read-write helpers
```

The *pure* modules take `Uint8Array` in / `Uint8Array` out and use no XPCOM,
DOM or `Components` — which is what makes them unit-testable outside the
browser.

## Tests

```sh
python3 tests/gen_fixtures.py   # regenerate tests/fixtures.js (already checked in)
node tests/run_tests.js         # or: xpcshell tests/run_tests.js
```

`run_tests.js` loads each JSM as a plain script — the same source the
extension imports — and covers:

- `SafePath` traversal/drive/UNC/device/control-char rejections, link targets,
  zip-bomb limits
- `Inflate` against stored / fixed-Huffman / dynamic-Huffman / large vectors
  generated with zlib
- `ZipFormat` listing, deflate + stored extraction, CRC verification, and a
  **zip-slip fixture** (5 hostile names, all rejected)
- `TarFormat` ustar, pax long names, symlink/hardlink records, escaping links
- `GzipFormat` unwrap
- `HelperParsers` against captured `unrar lt` and `7z l -slt` output
