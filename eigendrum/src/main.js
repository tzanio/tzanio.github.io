import { PALETTES } from './palettes.js';
import {
  PRESETS,
  isSimplePolygon,
  normalizeUnitArea,
  pointInPolygon,
  prepareDrawnPolygon,
  presetPolygon,
} from './geometry.js';
import { SolverClient } from './solver-client.js';
import { TopViewRenderer, renderModeThumbnail } from './renderer2d.js';
import {
  buildStrikeState,
  evaluateActiveField,
  modalFrequencies,
  normalizedModalEnergies,
} from './physics.js';
import { ModalAudioEngine } from './audio.js';
import { exportGlvisVibration } from './glvis-export.js';

const DRAW_CLOSE_DISTANCE = 0.10;
const $ = (selector) => document.querySelector(selector);
const elements = {
  backendBadge: $('#backend-badge'),
  shapeGrid: $('#shape-grid'),
  drawButton: $('#draw-button'),
  drawHelp: $('#draw-help'),
  drawingOverlay: $('#drawing-overlay'),
  topCanvas: $('#top-view'),
  dofTarget: $('#dof-target'),
  dofTargetOutput: $('#dof-target-output'),
  modeCount: $('#mode-count'),
  modeCountOutput: $('#mode-count-output'),
  pitch: $('#pitch'),
  pitchOutput: $('#pitch-output'),
  decay: $('#decay'),
  decayOutput: $('#decay-output'),
  brightness: $('#brightness'),
  brightnessOutput: $('#brightness-output'),
  mallet: $('#mallet'),
  malletOutput: $('#mallet-output'),
  palette: $('#palette-select'),
  meshToggle: $('#mesh-toggle'),
  nodalToggle: $('#nodal-toggle'),
  displayGain: $('#display-gain'),
  displayGainOutput: $('#display-gain-output'),
  autoContrast: $('#auto-contrast'),
  glvisCycles: $('#glvis-cycles'),
  glvisFps: $('#glvis-fps'),
  exportGlvis: $('#export-glvis'),
  shapeTitle: $('#shape-title'),
  solveStatus: $('#solve-status'),
  modeStrip: $('#mode-strip'),
  modeCaption: $('#mode-caption'),
  readoutDofs: $('#readout-dofs'),
  readoutElements: $('#readout-elements'),
  readoutResidual: $('#readout-residual'),
  readoutTime: $('#readout-time'),
};

for (const [name, element] of Object.entries(elements)) {
  if (!element) throw new Error(`Required interface element is missing: ${name}`);
}

const topView = new TopViewRenderer(elements.topCanvas);
const audio = new ModalAudioEngine();

const state = {
  shapeId: 'circle',
  polygon: presetPolygon('circle'),
  mesh: null,
  solution: null,
  selectedMode: 0,
  strikes: [],
  lastStrike: null,
  drawing: false,
  drawingPoints: [],
  pointerDown: false,
  pointerStart: null,
  solving: false,
  palette: PALETTES[0].id,
  lastField: null,
  fieldBuffer: null,
  lastPhysicalRange: 1,
  lastStrikePoint: null,
  regenerateTimer: null,
};

function maxAbs(values) {
  if (!values) return 0;
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

function updateExportAvailability() {
  elements.exportGlvis.disabled = state.solving || !state.mesh || !state.solution || !state.lastStrike;
}

function setBusy(busy, message = '') {
  state.solving = busy;
  if (busy) delete document.documentElement.dataset.ready;
  elements.drawButton.disabled = busy;
  elements.solveStatus.classList.remove('is-error');
  if (message) elements.solveStatus.textContent = message;
  updateExportAvailability();
}

function showError(error) {
  state.solving = false;
  elements.solveStatus.textContent = error instanceof Error ? error.message : String(error);
  elements.solveStatus.classList.add('is-error');
  elements.drawButton.disabled = false;
  updateExportAvailability();
}

function updateModeEnergies(strike) {
  const bars = [...elements.modeStrip.querySelectorAll('.mode-energy i')];
  const energies = strike ? normalizedModalEnergies(strike) : null;
  bars.forEach((bar, index) => {
    bar.style.width = energies ? `${Math.sqrt(energies[index]) * 100}%` : '0%';
  });
}

function clearResponses({ clearHistory = true } = {}) {
  state.strikes = [];
  state.lastStrikePoint = null;
  if (clearHistory) state.lastStrike = null;
  audio.stopAll();
  updateModeEnergies(null);
  updateExportAvailability();
}

function clearVisualizationForDrawing() {
  clearResponses();
  state.mesh = null;
  state.solution = null;
  state.lastField = null;
  state.fieldBuffer = null;
  elements.modeStrip.replaceChildren();
  elements.readoutDofs.textContent = '—';
  elements.readoutElements.textContent = '—';
  elements.readoutResidual.textContent = '—';
  elements.readoutTime.textContent = '—';
  topView.setDrawing(true, state.drawingPoints, false);
}

const solver = new SolverClient({
  onMesh(mesh) {
    state.mesh = mesh;
    state.solution = null;
    state.selectedMode = 0;
    topView.setDrawing(false);
    topView.setMesh(mesh);
    elements.readoutElements.textContent = mesh.triangles.length.toLocaleString();
    elements.solveStatus.textContent = 'Mesh ready; assembling operators…';
    solver.solve(mesh, Number(elements.modeCount.value));
  },
  onSolution(solution, mfemError) {
    state.solution = solution;
    state.fieldBuffer = new Float64Array(state.mesh.points.length);
    state.selectedMode = Math.min(state.selectedMode, solution.modes.length - 1);
    state.solving = false;
    elements.backendBadge.textContent = solution.backendLabel;
    elements.backendBadge.title = mfemError
      ? `MFEM-WASM was unavailable, so the independently implemented P1 reference solver was used. ${mfemError}`
      : 'The finite-element operators and eigensolve were computed by MFEM in WebAssembly.';
    elements.solveStatus.textContent = `Solved ${solution.modes.length} modes`;
    elements.drawButton.disabled = false;
    elements.readoutDofs.textContent = solution.interiorDofs.toLocaleString();
    elements.readoutElements.textContent = state.mesh.triangles.length.toLocaleString();
    elements.readoutResidual.textContent = Math.max(...solution.residuals).toExponential(1);
    elements.readoutTime.textContent = `${(solution.solveMilliseconds / 1000).toFixed(2)} s`;
    renderModeCards();
    renderIdleNow();
    updateExportAvailability();
    document.documentElement.dataset.ready = 'true';
    window.dispatchEvent(new CustomEvent('eigendrum-ready', { detail: { solution, mesh: state.mesh } }));
  },
  onProgress(progress) {
    if (progress.phase === 'mfem-assembly') {
      elements.solveStatus.textContent = 'MFEM assembly…';
    } else if (progress.phase === 'eigensolve') {
      const residual = Number.isFinite(progress.residual) ? ` · residual ${progress.residual.toExponential(1)}` : '';
      elements.solveStatus.textContent = `Eigensolve iteration ${progress.iteration}${residual}`;
    }
  },
  onError(error) {
    showError(error);
  },
});

function beginShapeSolve(polygon, label, shapeId = 'custom') {
  clearResponses();
  state.drawing = false;
  state.drawingPoints = [];
  state.shapeId = shapeId;
  state.polygon = normalizeUnitArea(polygon);
  state.mesh = null;
  state.solution = null;
  state.lastField = null;
  state.fieldBuffer = null;
  topView.setDrawing(false);
  topView.clearMesh();
  elements.modeStrip.replaceChildren();
  elements.shapeTitle.textContent = label;
  elements.drawingOverlay.hidden = true;
  elements.drawHelp.hidden = true;
  setBusy(true, 'Generating quality triangular mesh…');
  solver.generate(state.polygon, Number(elements.dofTarget.value));
}

function restartCurrentSolve() {
  if (!state.mesh || state.drawing) return;
  clearResponses();
  state.solution = null;
  state.selectedMode = 0;
  setBusy(true, 'Recomputing spectrum…');
  solver.nextGeneration();
  solver.solve(state.mesh, Number(elements.modeCount.value));
}

function selectPreset(id) {
  const preset = PRESETS[id];
  if (!preset) return;
  for (const button of elements.shapeGrid.querySelectorAll('.shape-button')) {
    button.classList.toggle('is-active', button.dataset.shape === id);
  }
  beginShapeSolve(presetPolygon(id), preset.label, id);
}

function enterDrawingMode() {
  if (state.solving) solver.nextGeneration();
  state.solving = false;
  state.drawing = true;
  state.drawingPoints = [];
  for (const button of elements.shapeGrid.querySelectorAll('.shape-button')) button.classList.remove('is-active');
  elements.shapeTitle.textContent = 'Draw a membrane';
  elements.drawHelp.hidden = false;
  elements.drawingOverlay.hidden = false;
  elements.solveStatus.classList.remove('is-error');
  elements.solveStatus.textContent = 'Visualization cleared; draw a closed outline.';
  clearVisualizationForDrawing();
}

function cancelDrawing() {
  if (!state.drawing) return;
  state.drawing = false;
  state.drawingPoints = [];
  topView.setDrawing(false);
  const id = PRESETS[state.shapeId] ? state.shapeId : 'circle';
  selectPreset(id);
}

function drawingEndpointsNearby(points = state.drawingPoints) {
  if (points.length < 8) return false;
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first[0] - last[0], first[1] - last[1]) <= DRAW_CLOSE_DISTANCE;
}

function finishDrawing({ requireNearby = false } = {}) {
  if (!state.drawing) return false;
  if (state.drawingPoints.length < 8) {
    if (!requireNearby) showError(new Error('Draw a longer closed outline before finishing.'));
    return false;
  }
  const prepared = prepareDrawnPolygon(state.drawingPoints, {
    closeDistance: DRAW_CLOSE_DISTANCE,
    minimumSpacing: 0.010,
    smoothingPasses: 2,
    maxPoints: 240,
  });
  if (requireNearby && !prepared.autoClosed) return false;
  const points = prepared.polygon;
  if (points.length < 3 || !isSimplePolygon(points)) {
    showError(new Error('The drawn outline must be a simple, non-self-intersecting closed curve.'));
    return false;
  }
  for (const button of elements.shapeGrid.querySelectorAll('.shape-button')) button.classList.remove('is-active');
  beginShapeSolve(points, 'Your unit-area membrane', 'custom');
  return true;
}

function currentIdleField() {
  if (!state.solution) return null;
  return state.solution.modes[state.selectedMode];
}

function responseRange() {
  if (!state.solution || state.strikes.length === 0) return 1;
  let bound = 0;
  for (const strike of state.strikes) {
    for (let mode = 0; mode < state.solution.modes.length; mode += 1) {
      bound += Math.abs(strike.amplitudes[mode]) * maxAbs(state.solution.modes[mode]);
    }
  }
  return Math.max(bound, 1e-10);
}

function displayRange(values, physicalRange) {
  const base = elements.autoContrast.checked ? maxAbs(values) : physicalRange;
  const gain = Math.max(1, Number(elements.displayGain.value));
  return Math.max(base / gain, 1e-12);
}

function renderCurrentField() {
  if (!state.lastField) return;
  topView.render(
    state.lastField,
    displayRange(state.lastField, state.lastPhysicalRange),
    state.lastStrikePoint,
  );
}

function renderIdleNow() {
  const values = currentIdleField();
  if (!values) return;
  const range = Math.max(maxAbs(values), 1e-12);
  state.lastField = values;
  state.lastPhysicalRange = range;
  topView.render(values, displayRange(values, range), null);
}

function renderModeCards() {
  elements.modeStrip.replaceChildren();
  if (!state.solution || !state.mesh) return;
  const frequencies = modalFrequencies(state.solution.eigenvalues, Number(elements.pitch.value));
  state.solution.modes.forEach((mode, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mode-card${index === state.selectedMode ? ' is-active' : ''}`;
    button.dataset.mode = String(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === state.selectedMode ? 'true' : 'false');
    const canvas = document.createElement('canvas');
    const meta = document.createElement('div');
    meta.className = 'mode-meta';
    const number = document.createElement('strong');
    number.textContent = `Mode ${index + 1}`;
    const frequency = document.createElement('span');
    frequency.textContent = `${frequencies[index].toFixed(frequencies[index] < 100 ? 1 : 0)} Hz`;
    meta.append(number, frequency);
    const energy = document.createElement('div');
    energy.className = 'mode-energy';
    const bar = document.createElement('i');
    energy.appendChild(bar);
    button.append(canvas, meta, energy);
    button.addEventListener('click', () => {
      state.selectedMode = index;
      for (const card of elements.modeStrip.querySelectorAll('.mode-card')) {
        const active = Number(card.dataset.mode) === index;
        card.classList.toggle('is-active', active);
        card.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (state.strikes.length === 0) renderIdleNow();
      elements.modeCaption.textContent = `Mode ${index + 1}: λ = ${state.solution.eigenvalues[index].toPrecision(6)}, residual ${state.solution.residuals[index].toExponential(1)}.`;
    });
    elements.modeStrip.appendChild(button);
    requestAnimationFrame(() => renderModeThumbnail(canvas, state.mesh, mode, state.palette));
  });
}

function refreshModeThumbnails() {
  if (!state.solution || !state.mesh) return;
  const cards = [...elements.modeStrip.querySelectorAll('.mode-card')];
  cards.forEach((card, index) => {
    const canvas = card.querySelector('canvas');
    renderModeThumbnail(canvas, state.mesh, state.solution.modes[index], state.palette);
  });
}

async function strikeAt(point) {
  if (!state.mesh || !state.solution || state.solving || state.drawing) return;
  if (!pointInPolygon(point, state.polygon)) return;
  const now = performance.now() / 1000;
  const strike = buildStrikeState({
    mesh: state.mesh,
    solution: state.solution,
    point,
    referencePitch: Number(elements.pitch.value),
    decaySeconds: Number(elements.decay.value),
    brightnessPercent: Number(elements.brightness.value),
    malletPercent: Number(elements.mallet.value),
    startTime: now,
  });
  state.strikes.push(strike);
  if (state.strikes.length > 6) state.strikes.shift();
  state.lastStrike = strike;
  state.lastStrikePoint = point;
  updateModeEnergies(strike);
  updateExportAvailability();
  try {
    await audio.playStrike(strike);
  } catch (error) {
    elements.solveStatus.textContent = `Visualization active; audio unavailable: ${error.message}`;
  }
  window.dispatchEvent(new CustomEvent('eigendrum-strike', { detail: strike }));
}

function animationFrame() {
  if (state.solution && state.mesh && !state.drawing) {
    const now = performance.now() / 1000;
    state.strikes = state.strikes.filter((strike) => now - strike.startTime <= strike.duration);
    let values;
    let physicalRange;
    let point = null;
    if (state.strikes.length > 0) {
      if (!state.fieldBuffer || state.fieldBuffer.length !== state.mesh.points.length) {
        state.fieldBuffer = new Float64Array(state.mesh.points.length);
      }
      values = evaluateActiveField(state.strikes, state.solution, now, state.fieldBuffer);
      physicalRange = responseRange();
      point = state.lastStrikePoint;
    } else {
      values = currentIdleField();
      physicalRange = Math.max(maxAbs(values), 1e-12);
      state.lastStrikePoint = null;
    }
    state.lastField = values;
    state.lastPhysicalRange = physicalRange;
    topView.render(values, displayRange(values, physicalRange), point);
  }
  requestAnimationFrame(animationFrame);
}

function pointerDistance(event) {
  if (!state.pointerStart) return Infinity;
  return Math.hypot(event.clientX - state.pointerStart[0], event.clientY - state.pointerStart[1]);
}

elements.topCanvas.addEventListener('pointerdown', (event) => {
  elements.topCanvas.setPointerCapture(event.pointerId);
  state.pointerDown = true;
  state.pointerStart = [event.clientX, event.clientY];
  if (state.drawing) {
    const point = topView.clientToDrawingPoint(event.clientX, event.clientY);
    state.drawingPoints.push(point);
    topView.updateDrawing(state.drawingPoints, drawingEndpointsNearby());
  }
});

elements.topCanvas.addEventListener('pointermove', (event) => {
  if (!state.pointerDown || !state.drawing) return;
  const point = topView.clientToDrawingPoint(event.clientX, event.clientY);
  const previous = state.drawingPoints[state.drawingPoints.length - 1];
  if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 0.010) {
    state.drawingPoints.push(point);
    topView.updateDrawing(state.drawingPoints, drawingEndpointsNearby());
  }
});

elements.topCanvas.addEventListener('pointerup', (event) => {
  const moved = pointerDistance(event);
  state.pointerDown = false;
  if (elements.topCanvas.hasPointerCapture(event.pointerId)) elements.topCanvas.releasePointerCapture(event.pointerId);
  if (state.drawing) {
    if (drawingEndpointsNearby()) finishDrawing({ requireNearby: true });
    else topView.updateDrawing(state.drawingPoints, false);
    return;
  }
  if (moved < 7) {
    const point = topView.clientToWorld(event.clientX, event.clientY);
    if (point) strikeAt(point);
  }
});

elements.topCanvas.addEventListener('pointercancel', (event) => {
  state.pointerDown = false;
  if (elements.topCanvas.hasPointerCapture(event.pointerId)) elements.topCanvas.releasePointerCapture(event.pointerId);
});

window.addEventListener('keydown', (event) => {
  if (!state.drawing) return;
  if (event.key === 'Enter') finishDrawing();
  else if (event.key === 'Escape') cancelDrawing();
});

elements.shapeGrid.addEventListener('click', (event) => {
  const button = event.target.closest('.shape-button');
  if (button) selectPreset(button.dataset.shape);
});
elements.drawButton.addEventListener('click', enterDrawingMode);

elements.dofTarget.addEventListener('input', () => {
  elements.dofTargetOutput.textContent = Number(elements.dofTarget.value).toLocaleString();
  clearTimeout(state.regenerateTimer);
  state.regenerateTimer = setTimeout(() => {
    if (!state.drawing) {
      const label = state.shapeId === 'custom' ? 'Your unit-area membrane' : PRESETS[state.shapeId].label;
      beginShapeSolve(state.polygon, label, state.shapeId);
    }
  }, 420);
});
elements.modeCount.addEventListener('input', () => {
  elements.modeCountOutput.textContent = elements.modeCount.value;
});
elements.modeCount.addEventListener('change', restartCurrentSolve);

for (const palette of PALETTES) {
  const option = document.createElement('option');
  option.value = palette.id;
  option.textContent = palette.name;
  elements.palette.appendChild(option);
}
elements.palette.value = state.palette;
elements.palette.addEventListener('change', () => {
  state.palette = elements.palette.value;
  topView.setOptions({ palette: state.palette });
  refreshModeThumbnails();
  renderCurrentField();
});
elements.meshToggle.addEventListener('change', () => {
  topView.setOptions({ showMesh: elements.meshToggle.checked });
  renderCurrentField();
});
elements.nodalToggle.addEventListener('change', () => {
  topView.setOptions({ showNodal: elements.nodalToggle.checked });
  renderCurrentField();
});
elements.displayGain.addEventListener('input', () => {
  elements.displayGainOutput.textContent = `${elements.displayGain.value}×`;
  renderCurrentField();
});
elements.autoContrast.addEventListener('change', renderCurrentField);

elements.exportGlvis.addEventListener('click', () => {
  if (!state.mesh || !state.solution || !state.lastStrike || state.solving) return;
  elements.exportGlvis.disabled = true;
  elements.solveStatus.classList.remove('is-error');
  elements.solveStatus.textContent = 'Building time-dependent GLVis package…';
  setTimeout(() => {
    try {
      const result = exportGlvisVibration({
        mesh: state.mesh,
        solution: state.solution,
        strike: state.lastStrike,
        basename: `eigendrum-${state.shapeId}`,
        cycles: Number(elements.glvisCycles.value),
        playbackFps: Number(elements.glvisFps.value),
        displayGain: Number(elements.displayGain.value),
      });
      const metadata = result.metadata;
      elements.solveStatus.textContent = `Exported ${metadata.frameCount} GLVis frames · ${metadata.actualFundamentalCycles.toFixed(2)} cycles`;
      document.documentElement.dataset.glvisExportFrames = String(metadata.frameCount);
      window.dispatchEvent(new CustomEvent('eigendrum-glvis-export', { detail: metadata }));
    } catch (error) {
      showError(error);
    } finally {
      updateExportAvailability();
    }
  }, 0);
});

const outputBindings = [
  [elements.pitch, elements.pitchOutput, (value) => `${value} Hz`],
  [elements.decay, elements.decayOutput, (value) => `${Number(value).toFixed(1)} s`],
  [elements.brightness, elements.brightnessOutput, (value) => `${value}%`],
  [elements.mallet, elements.malletOutput, (value) => `${value}%`],
];
for (const [input, output, format] of outputBindings) {
  input.addEventListener('input', () => {
    output.textContent = format(input.value);
    if (input === elements.pitch) renderModeCards();
  });
}

window.__EIGENDRUM__ = {
  state,
  strikeAt,
  enterDrawingMode,
  finishDrawing,
  selectPreset,
  renderIdleNow,
  drawingEndpointsNearby,
};

selectPreset('circle');
requestAnimationFrame(animationFrame);
