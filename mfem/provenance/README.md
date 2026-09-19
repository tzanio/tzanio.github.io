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
  commit, input source/mesh hashes, and stream hash. GLVis displays it as the
  initial saved result, with camera and appearance controls active during boot.
  Startup does not launch a new solve. Native inspection is available after
  Linux is ready; a later user-initiated live stream replaces the saved scene.
  The saved scene creates no synthetic streams, live frames or recordings.
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
- GDB 15.2-r0 and musl debug symbols 1.2.5-r12 come from those Alpine packages.
  `debugger-packages.json` records their archive hashes and package metadata;
  `scripts/install-debugger.py` verifies each APK's indexed control hash and
  payload hash before installation. The separate native MFEM debug tree is
  built from the same release checkout with `MFEM_DEBUG=YES`, `-Og`, `-g` and
  frame pointers. It supports tested postmortem core inspection with matching
  source and symbols. The bundled v86 does not implement trap-flag single
  stepping; these artifacts do not imply full live-debugger support.

## Optional browser compiler

`browser-compiler.json` records the experimental Clang/LLD compiler artifacts
under `vendor/browser-compiler/`, their exact byte lengths and SHA-256 hashes.
They load only when the browser compiler is requested, independently of Linux
and GLVis startup. The compiler emits `i586-alpine-linux-musl` ELF files, which
execute in the existing Linux guest.

- Clang/LLVM 23.1.0 is supplied by the prebuilt
  [WasmBolt compiler](https://anutosh21.github.io/WasmBolt/). The WasmBolt source
  checkout recorded for this integration is
  [`93ff85609101b7a01e03ebd8e96acc3bafd72056`](https://github.com/Anutosh21/WasmBolt/tree/93ff85609101b7a01e03ebd8e96acc3bafd72056).
  `Compiler.mjs`, `Compiler.wasm` and `Compiler.data` are copied unchanged;
  the data archive retains its upstream resource table. WasmBolt application
  code is MIT-licensed (`LICENSE.WasmBolt`); LLVM components retain their own
  Apache-2.0 WITH LLVM-exception license (`LICENSE.llvm`).
- The separately supplied LLD 8, memory filesystem and JavaScript helpers come
  from [binji/wasm-clang](https://github.com/binji/wasm-clang/tree/648c4a89997a351eef75cdaec3ef5b89d4937dec),
  recorded checkout `648c4a89997a351eef75cdaec3ef5b89d4937dec`. Its bundled
  `LICENSE` and `LICENSE.llvm` are preserved.
- WasmBolt links Graphviz; its build environment selects the Graphviz 15 series.
  `LICENSE.Graphviz` contains the unchanged EPL-2.0 text from the official
  [Graphviz 15.0.0 license](https://gitlab.com/graphviz/graphviz/-/raw/15.0.0/LICENSE).
  This notice does not assert which Graphviz patch version was used to compile
  the downloaded WasmBolt binary.
- `alpine-sdk.json.gz` is assembled by `scripts/prepare-browser-compiler.py`
  from this image's Alpine headers, C startup objects and runtime libraries.
  Package identities, source recipes and licenses are in `packages.json`.
  Startup-object debug sections are decompressed for LLD 8 compatibility;
  source headers and library contents retain their package licenses.

The source checkout commits document the repositories available during
integration, not a verified reproducible build of the downloaded compiler.
The artifact hashes identify the exact binaries used and tested:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Compiler.data` | 61,766,536 | `20afb2efda2134204a4ec069a2165aa600160597c88cf992c7768b502a637bde` |
| `Compiler.mjs` | 713,773 | `f1de65da5c54ad9fc0820de54875f3b65cd3cf2c003cdd163a7f0455566ac1c6` |
| `Compiler.wasm` | 89,410,263 | `6ec69d28a63e03d0f6953357206cbba13da27af05e1db336b48808780e04ddd0` |
| `lld` | 19,490,094 | `36419ed202011765222098d7701218378b67f634d50f0a4625059ae2c9860f48` |
| `memfs` | 345,442 | `2c72ee42bd9430029dda8c6bafc9f37143f6fe88d5f1ea950a70259ab748bcfe` |
| `shared.js` | 23,973 | `4de0be862bda1a7571c1f0632abe3c62c47a56e734cc6b703155805a4b160b1c` |
| `alpine-sdk.json.gz` | 5,728,635 | `81a6738aba0fa69868f26e4311dc7e9874f068cf81ebdda4ef151596b0adc5d0` |

## Distributed files

SHA256SUMS.json records the exact distributed site assets. The filesystem's
content-addressed blobs contain the above guest software and MFEM checkout.
The site's own JS, HTML, CSS and Python glue are provided under the MIT license
in LICENSE. Third-party software retains its own licenses.
