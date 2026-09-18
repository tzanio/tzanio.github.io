# Runtime provenance

- MFEM v4.10, commit d964264cdb9a13e94a201b6c236c7721e0c8765f:
  https://github.com/mfem/mfem/tree/v4.10 (BSD-3-Clause).
  Native i586 Linux static/shared serial libraries and 37 default serial
  example targets built from these unmodified sources. Target names, hashes
  and optional dependency limits are in prebuilt-examples.json.
  The optional MFEM header cache is built with the guest's Alpine GCC 14.2
  (`scripts/build-pch.cjs` and `guest/mfem-pch-build`). Its dependency manifest
  lives at `/usr/local/lib/mfem-pch/dependencies.json` in the guest; the compiler
  wrapper verifies header contents and GCC preprocessing before using it.
  Large native guest files use v86's built-in zstd transport decompression;
  decoded guest bytes are unchanged.
- GLVis browser build, commit 4fbef750b4966a59e68cbda99df5448a7bc5263b:
  https://github.com/GLVis/glvis-js/tree/4fbef750b4966a59e68cbda99df5448a7bc5263b
  (BSD-3-Clause). License, NOTICE and font license in vendor/.
  Web control mappings and attribution are documented in GLVIS-CONTROLS.md.
  Local JavaScript embedding extensions: `glvis.State` accepts optional
  Emscripten module options as its fifth argument, and the native window-title
  import calls an optional `setWindowTitle` callback. Workstation renderers use
  that callback to keep SDL window titles out of the browser tab. Calls without
  the callback retain upstream behavior; the compiled GLVis WASM is unchanged.
- `startup-ex1.json` contains an unchanged native mesh/GridFunction stream
  captured from the default `./ex1` in the bundled MFEM v4.10 guest. The capture
  script is `scripts/build-startup-preview.cjs`; the artifact records its MFEM
  commit, input source/mesh hashes, and stream hash. GLVis displays it as an
  explicitly labeled preview while Linux starts. The new live solve replaces
  it; previews do not count as guest frames or populate recordings/inspection.
- v86 0.5.461: https://www.npmjs.com/package/v86/v/0.5.461
  https://github.com/copy/v86 (BSD-2-Clause). License in vendor/.
- xterm.js 6.0.0: https://www.npmjs.com/package/@xterm/xterm/v/6.0.0
  https://github.com/xtermjs/xterm.js (MIT). License in vendor/.
- Linux kernel image: https://i.copy.sh/buildroot-bzimage68.bin
  Linux 6.8.12, supplied by the v86 project. Build recipes:
  https://github.com/copy/v86/tree/master/tools
  Linux source: https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.8.12.tar.xz
  (GPL-2.0-only, with applicable exceptions).
- SeaBIOS and VGA BIOS: https://github.com/copy/v86/tree/master/bios
  SeaBIOS upstream: https://www.seabios.org/ (LGPL-3.0).
- Alpine minirootfs 3.22.1 x86:
  https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86/alpine-minirootfs-3.22.1-x86.tar.gz
  Additional package versions, licenses, upstream URLs and source recipe commits
  are recorded in packages.json. Packages came from
  https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86/.
  For each package, `o` is its source recipe name and `c` the recipe commit:
  https://gitlab.alpinelinux.org/alpine/aports/-/tree/<c>/main/<o>
  The recipe's APKBUILD lists the corresponding upstream source archive.

SHA256SUMS.json records the exact distributed site assets. The filesystem's
content-addressed blobs contain the above guest software and MFEM checkout.
The site's own JS, HTML, CSS and Python glue are provided under the MIT license
in LICENSE. Third-party software retains its own licenses.
