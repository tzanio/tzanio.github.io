let modulePromise = null;

async function createModule() {
  const moduleDirectory = new URL('../mfem/', import.meta.url);
  const url = new URL('mfem_drum.js', moduleDirectory);
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!response.ok) throw new Error('MFEM WebAssembly module is not installed.');
  const imported = await import(/* @vite-ignore */ url.href);
  const factory = imported.default ?? imported.createMfemDrumModule;
  if (typeof factory !== 'function') throw new Error('Invalid MFEM WebAssembly module factory.');
  return factory({ locateFile: (file) => new URL(file, moduleDirectory).href });
}

export async function loadMfemModule() {
  if (!modulePromise) modulePromise = createModule();
  return modulePromise;
}

function copyToHeap(module, typedArray, heap, bytesPerElement) {
  const pointer = module._malloc(typedArray.length * bytesPerElement);
  heap.set(typedArray, pointer / bytesPerElement);
  return pointer;
}

export async function solveWithMfem(mesh, requestedModes, onProgress = null) {
  const module = await loadMfemModule();
  onProgress?.({ phase: 'mfem-assembly', iteration: 0, residual: null });
  const coordinates = new Float64Array(mesh.points.length * 2);
  for (let i = 0; i < mesh.points.length; i += 1) {
    coordinates[2 * i] = mesh.points[i][0];
    coordinates[2 * i + 1] = mesh.points[i][1];
  }
  const triangles = new Int32Array(mesh.triangles.length * 3);
  for (let i = 0; i < mesh.triangles.length; i += 1) {
    triangles[3 * i] = mesh.triangles[i][0];
    triangles[3 * i + 1] = mesh.triangles[i][1];
    triangles[3 * i + 2] = mesh.triangles[i][2];
  }
  const boundaryEdges = new Int32Array(mesh.boundaryEdges.length * 2);
  for (let i = 0; i < mesh.boundaryEdges.length; i += 1) {
    boundaryEdges[2 * i] = mesh.boundaryEdges[i][0];
    boundaryEdges[2 * i + 1] = mesh.boundaryEdges[i][1];
  }
  const pCoordinates = copyToHeap(module, coordinates, module.HEAPF64, 8);
  const pTriangles = copyToHeap(module, triangles, module.HEAP32, 4);
  const pBoundary = copyToHeap(module, boundaryEdges, module.HEAP32, 4);
  let handle = 0;
  try {
    handle = module._mfem_drum_solve(
      mesh.points.length,
      pCoordinates,
      mesh.triangles.length,
      pTriangles,
      mesh.boundaryEdges.length,
      pBoundary,
      requestedModes,
    );
    if (!handle) {
      const messagePointer = module._mfem_drum_last_error();
      const message = messagePointer ? module.UTF8ToString(messagePointer) : 'Unknown MFEM solver failure.';
      throw new Error(message);
    }
    const nodeCount = module._mfem_drum_result_nodes(handle);
    const modeCount = module._mfem_drum_result_modes(handle);
    const eigenvaluesPointer = module._mfem_drum_result_eigenvalues(handle);
    const residualsPointer = module._mfem_drum_result_residuals(handle);
    const weightsPointer = module._mfem_drum_result_weights(handle);
    const vectorsPointer = module._mfem_drum_result_vectors(handle);
    const eigenvalues = Float64Array.from(module.HEAPF64.subarray(eigenvaluesPointer / 8, eigenvaluesPointer / 8 + modeCount));
    const residuals = Float64Array.from(module.HEAPF64.subarray(residualsPointer / 8, residualsPointer / 8 + modeCount));
    const nodalWeights = Float64Array.from(module.HEAPF64.subarray(weightsPointer / 8, weightsPointer / 8 + nodeCount));
    const packedModes = module.HEAPF64.subarray(vectorsPointer / 8, vectorsPointer / 8 + nodeCount * modeCount);
    const modes = Array.from({ length: modeCount }, (_, mode) => (
      Float64Array.from(packedModes.subarray(mode * nodeCount, (mode + 1) * nodeCount))
    ));
    return {
      backend: 'mfem-wasm',
      backendLabel: `MFEM ${module._mfem_drum_version_major()}.${module._mfem_drum_version_minor()} · WebAssembly`,
      eigenvalues,
      residuals,
      nodalWeights,
      modes,
      area: module._mfem_drum_result_area(handle),
      interiorDofs: module._mfem_drum_result_dofs(handle),
      matrixNnz: module._mfem_drum_result_nnz(handle),
      outerIterations: module._mfem_drum_result_outer_iterations(handle),
      linearIterations: module._mfem_drum_result_linear_iterations(handle),
      solveMilliseconds: module._mfem_drum_result_milliseconds(handle),
    };
  } finally {
    if (handle) module._mfem_drum_result_free(handle);
    module._free(pCoordinates);
    module._free(pTriangles);
    module._free(pBoundary);
  }
}
