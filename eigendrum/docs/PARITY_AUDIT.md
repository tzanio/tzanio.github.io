# Eigendrum–MFEM parity audit

## Scope

This audit covers the default conforming P1-triangle path. It compares the physical model, finite-element operators, generalized eigenproblem, modal normalization, strike projection, pitch conversion, damping, and synthesis law with the original Eigendrum implementation audited in the preceding revisions.

Exact audio samples need not be bit-identical because meshes, floating-point operation order, bases selected inside nearly degenerate eigenspaces, browser sample rates, and the final Web Audio output processor can differ. The claim is mathematical-model parity, not binary-output identity.

## Physics and PDE

Both applications use an ideal homogeneous membrane with fixed boundary. After nondimensionalizing the tension-to-areal-density ratio to one,

\[
 u_{tt}-\Delta u=F,
 \qquad u|_{\partial\Omega}=0.
\]

The free-vibration modes solve

\[
 -\Delta\phi_k=\lambda_k\phi_k\quad\text{in }\Omega,
 \qquad
 \phi_k=0\quad\text{on }\partial\Omega.
\]

Every preset and accepted drawing is translated and uniformly scaled to unit area. This is necessary because Laplace eigenvalues scale as inverse length squared.

## Spatial discretization

| Item | Original Eigendrum model | MFEM edition |
|---|---|---|
| Cells | Conforming first-order triangles | Conforming first-order triangles |
| Space | Continuous piecewise-linear \(H^1_0\) | `H1_FECollection(1,2)` and `FiniteElementSpace` |
| Stiffness | \(K_{ij}=\int_\Omega\nabla N_i\cdot\nabla N_j\,dx\) | `DiffusionIntegrator` |
| Mass | Consistent \(M_{ij}=\int_\Omega N_iN_j\,dx\) | `MassIntegrator` |
| Boundary data | Boundary nodal unknowns eliminated | Essential true DOFs eliminated |
| Eigenproblem | \(Kq_k=\lambda_kMq_k\) | Same |
| Normalization | Mass normalization | \(q_i^TMq_j=\delta_{ij}\) |

There is no quadrilateral, 3D-browser-surface, or AMR path in v3.2. Removing those optional extensions does not change the PDE or the default P1 formulation.

When the compiled MFEM module is absent, the browser labels and uses an independent reference backend. It assembles the same element stiffness and consistent mass matrices and is not represented as MFEM.

## Eigensolver

The browser-compatible implementation uses block inverse iteration with:

1. inverse applications of the SPD Dirichlet stiffness matrix;
2. repeated \(M\)-orthogonalization;
3. Rayleigh–Ritz extraction;
4. sorting by increasing Ritz value;
5. explicit generalized residual checks
   \[
   r_k=\frac{\|Kq_k-\lambda_kMq_k\|_2}
   {\|Kq_k\|_2+\lambda_k\|Mq_k\|_2}.
   \]

IC(0)-preconditioned conjugate gradients provide the inverse applications. The subspace is oversampled to stabilize repeated and tightly clustered eigenvalues.

## Pitch normalization

The reference pitch is tied to the unit-area disk rather than retuning each shape to the same fundamental. If \(j_{0,1}\) is the first positive zero of \(J_0\),

\[
 \lambda_{\mathrm{disk},1}=\pi j_{0,1}^2,
 \qquad
 f_k=f_{\mathrm{ref}}
 \sqrt{\frac{\lambda_k}{\lambda_{\mathrm{disk},1}}}.
\]

Consequently, changing the domain changes its fundamental frequency.

## Strike projection

A finite-width Gaussian mallet centered at \(x_s\) is

\[
 g(x;x_s,\sigma)=
 \exp\!\left(-\frac{|x-x_s|^2}{2\sigma^2}\right).
\]

It is projected using P1 nodal-area weights. For mode \(k\),

\[
 p_k=
 \frac{\sum_i w_i g(x_i)q_{k,i}}
      {\sum_i w_i q_{k,i}^2}.
\]

The velocity-impulse response contributes a \(1/\omega_k\) factor. The finite-contact rolloff uses the audited original cutoff convention

\[
 f_c=3f_{\mathrm{ref}}.
\]

A strike stores one immutable set of modal amplitudes, frequencies, decay rates, and start time. The renderer, GLVis exporter, and pre-limiter audio synthesis all use that same state.

## Damping and time response

Rayleigh damping gives

\[
 \gamma_k=\frac12\left(\alpha+\beta\omega_k^2\right).
\]

The low-frequency lifetime is controlled by the decay setting; brightness controls the stiffness-proportional component. The physical P1 response is

\[
 u_h(x,t)=
 \sum_k a_k e^{-\gamma_k(t-t_s)}
 \sin\!\bigl(2\pi f_k(t-t_s)\bigr)\phi_k(x).
\]

`evaluateActiveField` evaluates this field at every FE node. `evaluateAudioSample` sums the identical modal coefficients and time factors. The final audio output stage applies global peak normalization, a smooth limiter, a terminal fade, and the browser compressor. Those audio-only protections do not select different modes or change the pre-limiter modal law.

## Display amplification

Browser displacement gain changes only the symmetric scalar-to-color range:

\[
 R_{\mathrm{display}}=R_{\mathrm{physical}}/G,
 \qquad 1\le G\le64.
\]

The P1 solution, strike amplitudes, sound, and GLVis frame values remain unscaled. Per-frame auto contrast changes only the visual range used for that frame.

## Time-dependent GLVis export

The export samples the same `evaluateStrikeAtNodes` response at recorded physical times. The sampling interval is chosen to resolve the highest exported modal frequency, with a target of at least 12 samples per fastest modal period. Playback FPS is separate from physical sample rate, so the provided Python streamer shows the vibration in slow motion rather than aliasing audible frequencies.

The ZIP contains:

- the conforming MFEM v1.0 triangular mesh;
- one `H1_2D_P1` grid function per sample;
- exact sample times and modal metadata;
- a GLVis command script for frame stepping;
- a timed socket player using only the Python standard library.

The display-gain setting is exported only as a suggested fixed color range and repeated GLVis z-stretch key command. It is never applied to the grid-function values.

## Regression protections

The release tests lock the following invariants:

- unit-area domains;
- exact square and proper five-point-star presets;
- conforming triangle-only meshes;
- 400 initial interior P1 DOFs and 10 eigenmodes;
- small generalized eigenpair residuals;
- disk-spectrum consistency and low-mode degeneracy;
- contact cutoff ratio 3.0;
- identical visible and audible modal time laws;
- no mutation of stored eigenvectors during a strike;
- restoration of the selected idle mode after a response expires;
- exact GLVis frame equality with the browser modal evaluator;
- sufficient temporal sampling of the highest exported frequency.
