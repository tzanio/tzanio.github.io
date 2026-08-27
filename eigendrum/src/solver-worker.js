import { generateTriangularMesh } from './mesher.js';
import { solveReferenceP1 } from './fem-reference.js';

let cancelledGeneration = -1;

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelledGeneration = Math.max(cancelledGeneration, message.generation);
    return;
  }
  try {
    if (message.type === 'generate') {
      const mesh = generateTriangularMesh(message.polygon, message.targetInterior);
      if (message.generation <= cancelledGeneration) return;
      self.postMessage({ type: 'mesh', generation: message.generation, mesh });
      return;
    }
    if (message.type === 'solve') {
      let solution;
      let mfemError = null;
      try {
        const { solveWithMfem } = await import('./mfem-backend.js');
        solution = await solveWithMfem(message.mesh, message.modeCount, (progress) => {
          self.postMessage({ type: 'progress', generation: message.generation, progress });
        });
      } catch (error) {
        mfemError = error instanceof Error ? error.message : String(error);
        solution = await solveReferenceP1(message.mesh, message.modeCount, {
          onProgress: (progress) => self.postMessage({ type: 'progress', generation: message.generation, progress }),
        });
      }
      if (message.generation <= cancelledGeneration) return;
      self.postMessage({ type: 'solution', generation: message.generation, solution, mfemError });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      generation: message.generation,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : '',
    });
  }
};
