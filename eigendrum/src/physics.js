export const MODEL_CONSTANTS = Object.freeze({
  diskBesselRoot: 2.404825557695773,
  contactCutoffRatio: 3.0,
  maximumVoices: 6,
  targetPeak: 0.86,
  outputGain: 0.82,
  terminalFadeSeconds: 0.045,
});

export const UNIT_AREA_DISK_LAMBDA1 = Math.PI * MODEL_CONSTANTS.diskBesselRoot ** 2;

export function modalFrequencies(eigenvalues, referencePitch) {
  return Float64Array.from(eigenvalues, (lambda) => (
    referencePitch * Math.sqrt(Math.max(lambda, 0) / UNIT_AREA_DISK_LAMBDA1)
  ));
}

export function rayleighDecayRates(frequencies, decaySeconds, brightnessPercent, referencePitch) {
  const brightness = Math.max(0, Math.min(1, brightnessPercent / 100));
  const alpha = 2 / Math.max(0.1, decaySeconds);
  const anchorOmega = 2 * Math.PI * Math.max(1, MODEL_CONSTANTS.contactCutoffRatio * referencePitch);
  const highFrequencyStrength = (1 - brightness) ** 2;
  const beta = highFrequencyStrength * alpha / (anchorOmega * anchorOmega);
  return Float64Array.from(frequencies, (frequency) => {
    const omega = 2 * Math.PI * frequency;
    return 0.5 * (alpha + beta * omega * omega);
  });
}

export function contactRolloff(frequency, referencePitch) {
  const cutoff = MODEL_CONSTANTS.contactCutoffRatio * referencePitch;
  const ratio = frequency / Math.max(cutoff, 1e-12);
  return 1 / Math.sqrt(1 + ratio ** 4);
}

export function buildStrikeState({
  mesh,
  solution,
  point,
  referencePitch,
  decaySeconds,
  brightnessPercent,
  malletPercent,
  startTime,
}) {
  const frequencies = modalFrequencies(solution.eigenvalues, referencePitch);
  const decayRates = rayleighDecayRates(frequencies, decaySeconds, brightnessPercent, referencePitch);
  const sigma = Math.max(0.01, malletPercent / 100);
  const gaussian = new Float64Array(mesh.points.length);
  let gaussianMass = 0;
  for (let i = 0; i < mesh.points.length; i += 1) {
    const dx = mesh.points[i][0] - point[0];
    const dy = mesh.points[i][1] - point[1];
    const value = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    gaussian[i] = value;
    gaussianMass += solution.nodalWeights[i] * value;
  }
  const amplitudes = new Float64Array(solution.modes.length);
  for (let mode = 0; mode < solution.modes.length; mode += 1) {
    const phi = solution.modes[mode];
    let projection = 0;
    let modalMass = 0;
    for (let i = 0; i < phi.length; i += 1) {
      const weight = solution.nodalWeights[i];
      projection += weight * gaussian[i] * phi[i];
      modalMass += weight * phi[i] * phi[i];
    }
    const frequency = frequencies[mode];
    const omega = 2 * Math.PI * Math.max(frequency, 1e-9);
    amplitudes[mode] = (projection / Math.max(modalMass, 1e-20))
      * contactRolloff(frequency, referencePitch)
      / omega;
  }
  let peakAmplitude = 0;
  for (const value of amplitudes) peakAmplitude = Math.max(peakAmplitude, Math.abs(value));
  if (peakAmplitude > 0) {
    const scale = 1 / peakAmplitude;
    for (let i = 0; i < amplitudes.length; i += 1) amplitudes[i] *= scale;
  }
  const energy = Float64Array.from(amplitudes, (value) => value * value);
  const duration = Math.min(14, Math.max(1.2, 5.5 * decaySeconds));
  return Object.freeze({
    id: `${startTime.toFixed(6)}-${Math.random().toString(36).slice(2)}`,
    point: Object.freeze([point[0], point[1]]),
    startTime,
    amplitudes,
    frequencies,
    decayRates,
    energy,
    duration,
    gaussianMass,
  });
}

export function modalCoefficient(strike, mode, elapsedSeconds) {
  if (elapsedSeconds < 0 || elapsedSeconds > strike.duration) return 0;
  const envelope = Math.exp(-strike.decayRates[mode] * elapsedSeconds);
  return strike.amplitudes[mode]
    * envelope
    * Math.sin(2 * Math.PI * strike.frequencies[mode] * elapsedSeconds);
}

export function evaluateStrikeAtNodes(strike, solution, elapsedSeconds, out = null) {
  const values = out ?? new Float64Array(solution.modes[0].length);
  values.fill(0);
  if (elapsedSeconds < 0 || elapsedSeconds > strike.duration) return values;
  for (let mode = 0; mode < solution.modes.length; mode += 1) {
    const coefficient = modalCoefficient(strike, mode, elapsedSeconds);
    if (Math.abs(coefficient) < 1e-14) continue;
    const phi = solution.modes[mode];
    for (let i = 0; i < values.length; i += 1) values[i] += coefficient * phi[i];
  }
  return values;
}

export function evaluateActiveField(strikes, solution, nowSeconds, out = null) {
  const values = out ?? new Float64Array(solution.modes[0].length);
  values.fill(0);
  const scratch = new Float64Array(values.length);
  for (const strike of strikes) {
    evaluateStrikeAtNodes(strike, solution, nowSeconds - strike.startTime, scratch);
    for (let i = 0; i < values.length; i += 1) values[i] += scratch[i];
  }
  return values;
}

export function evaluateAudioSample(strike, elapsedSeconds) {
  if (elapsedSeconds < 0 || elapsedSeconds > strike.duration) return 0;
  let sample = 0;
  for (let mode = 0; mode < strike.amplitudes.length; mode += 1) {
    sample += modalCoefficient(strike, mode, elapsedSeconds);
  }
  return sample;
}

export function normalizedModalEnergies(strike) {
  const maximum = Math.max(...strike.energy, 1e-30);
  return Float64Array.from(strike.energy, (value) => value / maximum);
}
