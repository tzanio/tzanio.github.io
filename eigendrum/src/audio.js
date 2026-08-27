import { evaluateAudioSample, MODEL_CONSTANTS } from './physics.js';

export class ModalAudioEngine {
  constructor() {
    this.context = null;
    this.master = null;
    this.compressor = null;
    this.sources = new Map();
  }

  async ensureContext() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio is not available in this browser.');
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.gain.value = MODEL_CONSTANTS.outputGain;
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -5;
      this.compressor.knee.value = 8;
      this.compressor.ratio.value = 7;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.16;
      this.master.connect(this.compressor).connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context;
  }

  async playStrike(strike) {
    const context = await this.ensureContext();
    const sampleRate = context.sampleRate;
    const sampleCount = Math.ceil(strike.duration * sampleRate);
    const buffer = context.createBuffer(1, sampleCount, sampleRate);
    const channel = buffer.getChannelData(0);
    let absolutePeak = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const t = i / sampleRate;
      const raw = evaluateAudioSample(strike, t);
      channel[i] = raw;
      absolutePeak = Math.max(absolutePeak, Math.abs(raw));
    }
    const normalization = absolutePeak > 1e-12 ? MODEL_CONSTANTS.targetPeak / absolutePeak : 1;
    const fadeSamples = Math.min(sampleCount, Math.ceil(MODEL_CONSTANTS.terminalFadeSeconds * sampleRate));
    for (let i = 0; i < sampleCount; i += 1) {
      let fade = 1;
      if (i >= sampleCount - fadeSamples) fade = (sampleCount - i - 1) / Math.max(1, fadeSamples - 1);
      channel[i] = Math.tanh(1.18 * channel[i] * normalization) * fade;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    source.addEventListener('ended', () => this.sources.delete(strike.id), { once: true });
    source.start();
    this.sources.set(strike.id, source);
    while (this.sources.size > MODEL_CONSTANTS.maximumVoices) {
      const oldest = this.sources.entries().next().value;
      if (!oldest) break;
      oldest[1].stop();
      this.sources.delete(oldest[0]);
    }
  }

  stopAll() {
    for (const source of this.sources.values()) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
  }
}
