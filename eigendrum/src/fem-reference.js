function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function norm2(a) {
  return Math.sqrt(Math.max(0, dot(a, a)));
}

function addToRow(rows, i, j, value) {
  if (Math.abs(value) < 1e-30) return;
  rows[i].set(j, (rows[i].get(j) ?? 0) + value);
}

function mapsToCsr(rows) {
  const n = rows.length;
  const rowPtr = new Int32Array(n + 1);
  let nnz = 0;
  for (let i = 0; i < n; i += 1) {
    rowPtr[i] = nnz;
    nnz += rows[i].size;
  }
  rowPtr[n] = nnz;
  const colIdx = new Int32Array(nnz);
  const values = new Float64Array(nnz);
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const entries = [...rows[i].entries()].sort((a, b) => a[0] - b[0]);
    for (const [column, value] of entries) {
      colIdx[cursor] = column;
      values[cursor] = value;
      cursor += 1;
    }
  }
  return { n, rowPtr, colIdx, values, nnz };
}

export function csrMatVec(matrix, x, out = new Float64Array(matrix.n)) {
  const { n, rowPtr, colIdx, values } = matrix;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p += 1) sum += values[p] * x[colIdx[p]];
    out[i] = sum;
  }
  return out;
}

function csrDiagonal(matrix) {
  const diagonal = new Float64Array(matrix.n);
  for (let i = 0; i < matrix.n; i += 1) {
    for (let p = matrix.rowPtr[i]; p < matrix.rowPtr[i + 1]; p += 1) {
      if (matrix.colIdx[p] === i) {
        diagonal[i] = matrix.values[p];
        break;
      }
    }
  }
  return diagonal;
}

function triangleLocalMatrices(points, triangle) {
  const [i, j, k] = triangle;
  const a = points[i];
  const b = points[j];
  const c = points[k];
  const twiceArea = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = 0.5 * Math.abs(twiceArea);
  if (!(area > 1e-16)) throw new Error('Degenerate triangle encountered during finite-element assembly.');
  const gradients = [
    [(b[1] - c[1]) / twiceArea, (c[0] - b[0]) / twiceArea],
    [(c[1] - a[1]) / twiceArea, (a[0] - c[0]) / twiceArea],
    [(a[1] - b[1]) / twiceArea, (b[0] - a[0]) / twiceArea],
  ];
  const stiffness = Array.from({ length: 3 }, () => new Float64Array(3));
  const mass = Array.from({ length: 3 }, () => new Float64Array(3));
  for (let r = 0; r < 3; r += 1) {
    for (let s = 0; s < 3; s += 1) {
      stiffness[r][s] = area * (gradients[r][0] * gradients[s][0] + gradients[r][1] * gradients[s][1]);
      mass[r][s] = area * (r === s ? 1 / 6 : 1 / 12);
    }
  }
  return { area, stiffness, mass };
}

export function assembleP1(mesh) {
  const nodeCount = mesh.points.length;
  const nodeToFree = new Int32Array(nodeCount).fill(-1);
  const freeToNode = [];
  for (let i = 0; i < nodeCount; i += 1) {
    if (!mesh.boundary[i]) {
      nodeToFree[i] = freeToNode.length;
      freeToNode.push(i);
    }
  }
  const n = freeToNode.length;
  if (n < 4) throw new Error('The mesh has too few interior degrees of freedom.');
  const stiffnessRows = Array.from({ length: n }, () => new Map());
  const massRows = Array.from({ length: n }, () => new Map());
  const nodalWeights = new Float64Array(nodeCount);
  let area = 0;
  for (const triangle of mesh.triangles) {
    const local = triangleLocalMatrices(mesh.points, triangle);
    area += local.area;
    for (let r = 0; r < 3; r += 1) {
      nodalWeights[triangle[r]] += local.area / 3;
      const row = nodeToFree[triangle[r]];
      if (row < 0) continue;
      for (let s = 0; s < 3; s += 1) {
        const column = nodeToFree[triangle[s]];
        if (column < 0) continue;
        addToRow(stiffnessRows, row, column, local.stiffness[r][s]);
        addToRow(massRows, row, column, local.mass[r][s]);
      }
    }
  }
  const stiffness = mapsToCsr(stiffnessRows);
  const mass = mapsToCsr(massRows);
  return {
    stiffness,
    mass,
    nodalWeights,
    nodeToFree,
    freeToNode: Int32Array.from(freeToNode),
    area,
  };
}

function buildIc0(matrix) {
  const n = matrix.n;
  const lowerColumns = Array.from({ length: n }, () => []);
  const lowerValues = Array.from({ length: n }, () => []);
  const diagonal = new Float64Array(n);
  const sourceDiagonal = csrDiagonal(matrix);
  const scale = Math.max(...sourceDiagonal);
  const shift = Math.max(1e-14, scale * 1e-12);

  for (let i = 0; i < n; i += 1) {
    const rowEntries = [];
    for (let p = matrix.rowPtr[i]; p < matrix.rowPtr[i + 1]; p += 1) {
      const j = matrix.colIdx[p];
      if (j < i) rowEntries.push([j, matrix.values[p]]);
    }
    rowEntries.sort((a, b) => a[0] - b[0]);
    const iCols = lowerColumns[i];
    const iVals = lowerValues[i];
    for (const [j, aij] of rowEntries) {
      const jCols = lowerColumns[j];
      const jVals = lowerValues[j];
      let left = 0;
      let right = 0;
      let correction = 0;
      while (left < iCols.length && right < jCols.length) {
        const ci = iCols[left];
        const cj = jCols[right];
        if (ci === cj) {
          correction += iVals[left] * jVals[right];
          left += 1;
          right += 1;
        } else if (ci < cj) left += 1;
        else right += 1;
      }
      const value = (aij - correction) / Math.max(diagonal[j], Math.sqrt(shift));
      iCols.push(j);
      iVals.push(value);
    }
    let diagonalValue = sourceDiagonal[i];
    for (const value of iVals) diagonalValue -= value * value;
    diagonal[i] = Math.sqrt(Math.max(diagonalValue, shift));
  }

  const upperRows = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    for (let p = 0; p < lowerColumns[i].length; p += 1) {
      upperRows[lowerColumns[i][p]].push([i, lowerValues[i][p]]);
    }
  }
  return { lowerColumns, lowerValues, diagonal, upperRows };
}

function applyIc0(preconditioner, rhs, out = new Float64Array(rhs.length)) {
  const n = rhs.length;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let value = rhs[i];
    const columns = preconditioner.lowerColumns[i];
    const entries = preconditioner.lowerValues[i];
    for (let p = 0; p < columns.length; p += 1) value -= entries[p] * y[columns[p]];
    y[i] = value / preconditioner.diagonal[i];
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    let value = y[i];
    for (const [row, entry] of preconditioner.upperRows[i]) value -= entry * out[row];
    out[i] = value / preconditioner.diagonal[i];
  }
  return out;
}

function pcg(matrix, rhs, preconditioner, tolerance = 1e-9, maxIterations = 240, initial = null) {
  const n = matrix.n;
  const x = initial ? Float64Array.from(initial) : new Float64Array(n);
  const ax = csrMatVec(matrix, x);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax[i];
  const rhsNorm = Math.max(norm2(rhs), 1e-30);
  if (norm2(r) / rhsNorm <= tolerance) return { x, iterations: 0, relativeResidual: norm2(r) / rhsNorm };
  let z = applyIc0(preconditioner, r);
  const p = Float64Array.from(z);
  let rz = dot(r, z);
  let relativeResidual = norm2(r) / rhsNorm;
  let iteration = 0;
  for (; iteration < maxIterations; iteration += 1) {
    const ap = csrMatVec(matrix, p);
    const denominator = dot(p, ap);
    if (!(denominator > 1e-30)) break;
    const alpha = rz / denominator;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    relativeResidual = norm2(r) / rhsNorm;
    if (relativeResidual <= tolerance) {
      iteration += 1;
      break;
    }
    z = applyIc0(preconditioner, r, z);
    const nextRz = dot(r, z);
    const beta = nextRz / Math.max(Math.abs(rz), 1e-300);
    for (let i = 0; i < n; i += 1) p[i] = z[i] + beta * p[i];
    rz = nextRz;
  }
  return { x, iterations: iteration, relativeResidual };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mOrthonormalize(vectors, mass) {
  const result = [];
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = Float64Array.from(vectors[index]);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const basis of result) {
        const mb = csrMatVec(mass, basis);
        const coefficient = dot(vector, mb);
        for (let i = 0; i < vector.length; i += 1) vector[i] -= coefficient * basis[i];
      }
    }
    const mv = csrMatVec(mass, vector);
    const length = Math.sqrt(Math.max(dot(vector, mv), 0));
    if (!(length > 1e-12)) continue;
    for (let i = 0; i < vector.length; i += 1) vector[i] /= length;
    result.push(vector);
  }
  return result;
}

function jacobiSymmetric(matrix, tolerance = 1e-13, maxSweeps = 120) {
  const n = matrix.length;
  const a = matrix.map((row) => Float64Array.from(row));
  const v = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n);
    row[i] = 1;
    return row;
  });
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let p = 0;
    let q = 1;
    let largest = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const value = Math.abs(a[i][j]);
        if (value > largest) {
          largest = value;
          p = i;
          q = j;
        }
      }
    }
    if (largest < tolerance) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const app = c * c * a[p][p] - 2 * s * c * a[p][q] + s * s * a[q][q];
    const aqq = s * s * a[p][p] + 2 * s * c * a[p][q] + c * c * a[q][q];
    for (let k = 0; k < n; k += 1) {
      if (k === p || k === q) continue;
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = a[p][k] = c * akp - s * akq;
      a[k][q] = a[q][k] = s * akp + c * akq;
    }
    a[p][p] = app;
    a[q][q] = aqq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < n; k += 1) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: Float64Array.from(order, (i) => a[i][i]),
    vectors: order.map((column) => Float64Array.from({ length: n }, (_, row) => v[row][column])),
  };
}

function rayleighRitz(vectors, stiffness, mass) {
  const basis = mOrthonormalize(vectors, mass);
  const k = basis.length;
  const projected = Array.from({ length: k }, () => new Float64Array(k));
  const av = basis.map((vector) => csrMatVec(stiffness, vector));
  for (let i = 0; i < k; i += 1) {
    for (let j = i; j < k; j += 1) {
      const value = dot(basis[i], av[j]);
      projected[i][j] = projected[j][i] = value;
    }
  }
  const eig = jacobiSymmetric(projected);
  const rotated = eig.vectors.map((coefficients) => {
    const vector = new Float64Array(stiffness.n);
    for (let j = 0; j < k; j += 1) {
      const coefficient = coefficients[j];
      for (let i = 0; i < vector.length; i += 1) vector[i] += coefficient * basis[j][i];
    }
    return vector;
  });
  return { values: eig.values, vectors: mOrthonormalize(rotated, mass) };
}

function eigenResidual(stiffness, mass, vector, eigenvalue) {
  const av = csrMatVec(stiffness, vector);
  const mv = csrMatVec(mass, vector);
  const residual = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) residual[i] = av[i] - eigenvalue * mv[i];
  return norm2(residual) / Math.max(norm2(av) + Math.abs(eigenvalue) * norm2(mv), 1e-30);
}

function initialSubspace(mesh, assembly, count) {
  const random = seededRandom(0x4d46454d);
  const vectors = [];
  for (let mode = 0; mode < count; mode += 1) {
    const vector = new Float64Array(assembly.freeToNode.length);
    for (let i = 0; i < vector.length; i += 1) {
      const [x, y] = mesh.points[assembly.freeToNode[i]];
      vector[i] = Math.sin((mode + 1) * 1.731 * x + 0.37 * mode)
        + Math.cos((mode + 2) * 1.219 * y - 0.21 * mode)
        + 0.18 * (random() - 0.5);
    }
    vectors.push(vector);
  }
  return vectors;
}

export async function solveReferenceP1(mesh, requestedModes, options = {}) {
  const started = performance.now();
  const assembly = assembleP1(mesh);
  const n = assembly.stiffness.n;
  const modeCount = Math.max(1, Math.min(requestedModes, n));
  const blockSize = Math.min(n, modeCount + Math.min(4, Math.max(2, Math.floor(modeCount / 3))));
  const preconditioner = buildIc0(assembly.stiffness);
  let vectors = mOrthonormalize(initialSubspace(mesh, assembly, blockSize), assembly.mass);
  let ritz = rayleighRitz(vectors, assembly.stiffness, assembly.mass);
  let residuals = [];
  let linearIterations = 0;
  let outerIteration = 0;
  const tolerance = n > 3500 ? 3e-6 : 3e-8;
  const maximumOuter = n > 3500 ? 40 : 64;
  for (; outerIteration < maximumOuter; outerIteration += 1) {
    const next = [];
    for (let j = 0; j < ritz.vectors.length; j += 1) {
      const rhs = csrMatVec(assembly.mass, ritz.vectors[j]);
      const solve = pcg(
        assembly.stiffness,
        rhs,
        preconditioner,
        n > 3500 ? 2e-7 : 2e-9,
        Math.min(420, Math.max(100, Math.ceil(5 * Math.sqrt(n)))),
      );
      linearIterations += solve.iterations;
      next.push(solve.x);
    }
    ritz = rayleighRitz(next, assembly.stiffness, assembly.mass);
    residuals = Array.from({ length: Math.min(modeCount, ritz.vectors.length) }, (_, i) => (
      eigenResidual(assembly.stiffness, assembly.mass, ritz.vectors[i], ritz.values[i])
    ));
    options.onProgress?.({
      phase: 'eigensolve',
      iteration: outerIteration + 1,
      residual: Math.max(...residuals),
    });
    if (Math.max(...residuals) < tolerance && outerIteration >= 5) break;
    if (outerIteration % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const eigenvalues = Float64Array.from(ritz.values.slice(0, modeCount));
  const modes = [];
  for (let mode = 0; mode < modeCount; mode += 1) {
    const full = new Float64Array(mesh.points.length);
    for (let i = 0; i < assembly.freeToNode.length; i += 1) full[assembly.freeToNode[i]] = ritz.vectors[mode][i];
    modes.push(full);
  }
  residuals = modes.map((_, i) => eigenResidual(
    assembly.stiffness,
    assembly.mass,
    ritz.vectors[i],
    eigenvalues[i],
  ));
  return {
    backend: 'reference-p1',
    backendLabel: 'Reference P1 FEM · MFEM-matched',
    eigenvalues,
    modes,
    residuals: Float64Array.from(residuals),
    nodalWeights: assembly.nodalWeights,
    area: assembly.area,
    interiorDofs: n,
    matrixNnz: assembly.stiffness.nnz + assembly.mass.nnz,
    outerIterations: Math.min(outerIteration + 1, maximumOuter),
    linearIterations,
    solveMilliseconds: performance.now() - started,
  };
}

export const _test = {
  dot,
  jacobiSymmetric,
  eigenResidual,
  buildIc0,
  pcg,
};
