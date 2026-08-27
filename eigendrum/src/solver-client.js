export class SolverClient {
  constructor(handlers = {}) {
    this.worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    this.handlers = handlers;
    this.generation = 0;
    this.worker.addEventListener('message', (event) => {
      const message = event.data;
      if (message.generation !== this.generation) return;
      if (message.type === 'mesh') this.handlers.onMesh?.(message.mesh);
      else if (message.type === 'solution') this.handlers.onSolution?.(message.solution, message.mfemError);
      else if (message.type === 'progress') this.handlers.onProgress?.(message.progress);
      else if (message.type === 'error') this.handlers.onError?.(new Error(message.message));
    });
    this.worker.addEventListener('error', (event) => {
      const detail = event.message || 'The finite-element worker could not be loaded.';
      this.handlers.onError?.(new Error(detail));
    });
    this.worker.addEventListener('messageerror', () => {
      this.handlers.onError?.(new Error('The finite-element worker returned an unreadable message.'));
    });
  }

  nextGeneration() {
    const previous = this.generation;
    this.generation += 1;
    if (previous > 0) this.worker.postMessage({ type: 'cancel', generation: previous });
    return this.generation;
  }

  generate(polygon, targetInterior) {
    const generation = this.nextGeneration();
    this.worker.postMessage({ type: 'generate', generation, polygon, targetInterior });
    return generation;
  }

  solve(mesh, modeCount) {
    this.worker.postMessage({ type: 'solve', generation: this.generation, mesh, modeCount });
  }

  terminate() {
    this.worker.terminate();
  }
}
