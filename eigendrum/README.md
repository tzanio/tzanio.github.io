# EigenDrum — MFEM edition v3.2

A no-build browser instrument for computing, hearing, and visualizing the eigenmodes of a fixed-boundary membrane. The intended numerical backend is MFEM 4.9 compiled to WebAssembly. When that optional module is absent, the interface explicitly labels and uses an independently implemented P1 reference backend with the same finite-element operators and modal model.

## Run without npm

No package manager or build step is required.

```bash
unzip mfem-eigendrum-v3.2-static-no-npm.zip
cd mfem-eigendrum-v3.2-static
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000/
```

Do not open `index.html` through a `file://` URL. The solver is a JavaScript module worker and therefore needs an HTTP origin.

## Revision v3.2

- removed the embedded 3D view and all related code;
- removed the AMR controls and refinement path;
- retained only conforming first-order triangular elements;
- set the initial discretization to 400 interior P1 DOFs and 10 eigenmodes;
- added a 1×–64× signed-displacement color-gain control and optional per-frame automatic contrast;
- retained the GLVis-inspired palette selector and opt-in smoothed nodal lines;
- made a near-closed freehand stroke close automatically and apply two closed-curve smoothing passes;
- retained the pre-drawing clear operation, so a new outline is never drawn over the old solution;
- retained the post-strike restoration fix: transient rendering uses a separate field buffer and the selected eigenmode is restored after the response ends;
- replaced the former single-field GLVis download with a time-dependent vibration package.

## PDE and finite-element formulation

The membrane has unit area and fixed boundary:

\[
 u_{tt}-\Delta u=F \quad\text{in }\Omega,
 \qquad u=0 \quad\text{on }\partial\Omega.
\]

The normal modes satisfy

\[
 -\Delta\phi_k=\lambda_k\phi_k,
 \qquad \phi_k|_{\partial\Omega}=0.
\]

The P1 finite-element operators are

\[
 K_{ij}=\int_\Omega \nabla N_i\cdot\nabla N_j\,dx,
 \qquad
 M_{ij}=\int_\Omega N_iN_j\,dx,
\]

with the generalized eigenproblem

\[
 Kq_k=\lambda_kMq_k.
\]

The MFEM kernel uses `H1_FECollection(1,2)`, `FiniteElementSpace`, `DiffusionIntegrator`, `MassIntegrator`, and essential true-DOF elimination. The fallback backend independently assembles the same triangle matrices and reports generalized residuals.

The visible vibration and the pre-limiter audio signal use the same modal state:

\[
 u_h(x,t)=\sum_k a_k e^{-\gamma_k(t-t_s)}
 \sin\!\bigl(2\pi f_k(t-t_s)\bigr)\phi_k(x).
\]

See [the parity audit](docs/PARITY_AUDIT.md) for the strike projection, pitch reference, contact filter, damping, and comparison scope.

## Visualization controls

- **Displacement color gain** narrows the symmetric color range by 1×–64×. It does not alter the finite-element values or sound.
- **Auto-range each frame** uses the instantaneous displacement maximum, which is useful late in a decaying response.
- **Palette** selects among GLVis-inspired and perceptual color maps.
- **Nodal lines** are disabled initially. When enabled, zero-level segments are connected into polylines and smoothed before drawing.
- **Mesh edges** displays the actual P1 triangle edges.

## Drawing a domain

Choose **Draw your own shape**. The current mesh, field, spectrum, and active response are cleared immediately. Click or drag a simple outline.

- Releasing near the first point automatically closes and smooths the curve.
- Press **Enter** to finish a non-near-closed outline.
- Press **Escape** to cancel.
- Self-intersecting curves are rejected.

The accepted outline is normalized to unit area before meshing.

## Time-dependent GLVis export

Strike the membrane, then choose **Export last vibration**. The downloaded ZIP contains:

- an MFEM v1.0 triangular mesh;
- one `H1_2D_P1` grid function per physical-time sample;
- `metadata.json` and `frames.csv` with exact sample times;
- `eigendrum.glvs` for manual frame stepping;
- `play_glvis.py`, a standard-library timed socket streamer;
- `run_glvis.sh` as a convenience launcher.

The sampled field is the unscaled modal displacement used by the browser response. Display gain is recorded only as a suggested GLVis color range and z-stretch; it is not multiplied into the exported solution.

After extracting the vibration ZIP, either run:

```bash
python3 play_glvis.py --launch
```

or start GLVis separately and stream into it:

```bash
glvis
python3 play_glvis.py
```

For manual stepping:

```bash
glvis -run eigendrum.glvs
```

Then press Space to advance the braced frames. The automatic player deliberately replays physical time in slow motion: audible modes require a much higher physical sampling rate than a normal display frame rate.

## Optional MFEM WebAssembly build

The static package runs without npm and without a compiler. To replace the labeled reference backend with genuine MFEM in the browser, activate an Emscripten environment and run from the source package:

```bash
./scripts/build-mfem-wasm.sh
python3 -m http.server 8000
```

The build emits:

```text
mfem/mfem_drum.js
mfem/mfem_drum.wasm
```

The worker then selects the MFEM module automatically. No precompiled MFEM-WASM binary is included in this release; see `MFEM_WASM_STATUS.txt`.

## Verification

The v3.2 release gate includes:

- geometry, mesh-conformity, mesh-quality, eigensolver-residual, disk-spectrum, and modal-identity tests;
- exact 400-DOF and 10-mode browser startup checks;
- display-gain raster comparison;
- multi-mode strike and stored-eigenvector immutability checks;
- post-strike field-restoration checks;
- GLVis ZIP integrity, temporal-resolution, exact-frame, and Python syntax checks;
- drawing clear, near-endpoint auto-close, smoothing, and re-solve checks;
- no-3D/no-AMR runtime scans;
- narrow-screen overflow checks.

See [QA_REPORT.md](QA_REPORT.md) and the machine-readable records under `qa/`.
