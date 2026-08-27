import { evaluateStrikeAtNodes } from './physics.js';

const DEFAULT_SAMPLES_PER_FASTEST_PERIOD = 12;
const DEFAULT_MAX_FRAMES = 420;
const DEFAULT_MAX_SCALAR_VALUES = 1_250_000;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function downloadBlob(filename, blob) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeBasename(name) {
  return String(name || 'eigendrum-vibration')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'eigendrum-vibration';
}

export function mfemMeshText(mesh) {
  const lines = [
    'MFEM mesh v1.0',
    '',
    'dimension',
    '2',
    '',
    'elements',
    String(mesh.triangles.length),
  ];
  for (const [a, b, c] of mesh.triangles) lines.push(`1 2 ${a} ${b} ${c}`);
  lines.push('', 'boundary', String(mesh.boundaryEdges.length));
  for (const [a, b] of mesh.boundaryEdges) lines.push(`1 1 ${a} ${b}`);
  lines.push('', 'vertices', String(mesh.points.length), '2');
  for (const [x, y] of mesh.points) lines.push(`${x.toPrecision(17)} ${y.toPrecision(17)}`);
  lines.push('');
  return lines.join('\n');
}

export function gridFunctionText(values) {
  const lines = [
    'FiniteElementSpace',
    'FiniteElementCollection: H1_2D_P1',
    'VDim: 1',
    'Ordering: 0',
    '',
  ];
  for (const value of values) lines.push(Number(value).toPrecision(17));
  lines.push('');
  return lines.join('\n');
}

function maximumAbsolute(values) {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

export function planVibrationSampling(strike, solution, {
  cycles = 4,
  playbackFps = 30,
  samplesPerFastestPeriod = DEFAULT_SAMPLES_PER_FASTEST_PERIOD,
  maxFrames = DEFAULT_MAX_FRAMES,
  maxScalarValues = DEFAULT_MAX_SCALAR_VALUES,
} = {}) {
  if (!strike || !solution?.modes?.length) throw new Error('A solved modal state and strike are required.');
  const frequencies = Array.from(strike.frequencies).filter((frequency) => Number.isFinite(frequency) && frequency > 0);
  if (frequencies.length === 0) throw new Error('The strike contains no positive modal frequencies.');

  const fundamentalFrequency = Math.min(...frequencies);
  const maximumFrequency = Math.max(...frequencies);
  const requestedCycles = clamp(Number(cycles) || 4, 0.5, 12);
  const frameRate = Math.round(clamp(Number(playbackFps) || 30, 1, 120));
  const samplesPerPeriod = clamp(Number(samplesPerFastestPeriod) || DEFAULT_SAMPLES_PER_FASTEST_PERIOD, 8, 32);
  const desiredPhysicalDuration = Math.min(strike.duration, requestedCycles / fundamentalFrequency);
  const targetPhysicalStep = 1 / (samplesPerPeriod * maximumFrequency);
  const nodeCount = solution.modes[0].length;
  const sizeLimitedFrames = Math.max(24, Math.floor(maxScalarValues / Math.max(1, nodeCount)));
  const frameBudget = Math.max(2, Math.min(Math.round(maxFrames), sizeLimitedFrames));

  let frameCount = Math.max(2, Math.ceil(desiredPhysicalDuration / targetPhysicalStep) + 1);
  let physicalDuration = desiredPhysicalDuration;
  let truncatedBySizeLimit = false;
  if (frameCount > frameBudget) {
    frameCount = frameBudget;
    physicalDuration = Math.min(desiredPhysicalDuration, (frameCount - 1) * targetPhysicalStep);
    truncatedBySizeLimit = physicalDuration + 1e-14 < desiredPhysicalDuration;
  }
  const physicalStepSeconds = physicalDuration / Math.max(1, frameCount - 1);
  const actualSamplesPerFastestPeriod = 1 / Math.max(physicalStepSeconds * maximumFrequency, 1e-30);
  const playbackDurationSeconds = (frameCount - 1) / frameRate;

  return {
    requestedFundamentalCycles: requestedCycles,
    actualFundamentalCycles: physicalDuration * fundamentalFrequency,
    fundamentalFrequencyHz: fundamentalFrequency,
    maximumFrequencyHz: maximumFrequency,
    physicalDurationSeconds: physicalDuration,
    physicalStepSeconds,
    physicalSampleRateHz: 1 / physicalStepSeconds,
    samplesPerFastestPeriod: actualSamplesPerFastestPeriod,
    playbackFps: frameRate,
    playbackDurationSeconds,
    slowMotionFactor: playbackDurationSeconds / Math.max(physicalDuration, 1e-30),
    frameCount,
    frameBudget,
    nodeCount,
    truncatedBySizeLimit,
  };
}

export function sampleVibrationFrames(strike, solution, options = {}) {
  const plan = planVibrationSampling(strike, solution, options);
  const frames = [];
  const times = [];
  let physicalValueRange = 0;
  for (let frame = 0; frame < plan.frameCount; frame += 1) {
    const time = frame * plan.physicalStepSeconds;
    const values = evaluateStrikeAtNodes(strike, solution, time);
    frames.push(values);
    times.push(time);
    physicalValueRange = Math.max(physicalValueRange, maximumAbsolute(values));
  }
  return {
    ...plan,
    frames,
    times,
    physicalValueRange: Math.max(physicalValueRange, 1e-12),
  };
}

function frameName(index) {
  return `frames/frame_${String(index).padStart(4, '0')}.gf`;
}

export function glvisScriptText({ basename, frameCount, times, displayValueRange, zStretchKeys }) {
  const lines = [
    '# EigenDrum time-dependent membrane vibration',
    '# Run: glvis -run eigendrum.glvs',
    '# GLVis pauses between braced blocks. Press Space to advance one physical-time sample.',
    'window 60 60 1000 760',
    `solution ${basename}.mesh ${frameName(0)}`,
    '{',
    "  window_title 'EigenDrum time-dependent vibration'",
    '  view 45 30',
    '  shading smooth',
    '  autoscale off',
    `  valuerange ${(-displayValueRange).toPrecision(17)} ${displayValueRange.toPrecision(17)}`,
    zStretchKeys ? `  keys ${zStretchKeys}` : '',
    `  plot_caption 'EigenDrum vibration: t = ${times[0].toExponential(4)} s'`,
    '}',
  ].filter(Boolean);
  for (let index = 1; index < frameCount; index += 1) {
    lines.push('{');
    lines.push(`  solution ${basename}.mesh ${frameName(index)}`);
    lines.push(`  plot_caption 'EigenDrum vibration: t = ${times[index].toExponential(4)} s'`);
    lines.push('}');
  }
  lines.push('');
  return lines.join('\n');
}

function playerPythonText() {
  return String.raw`#!/usr/bin/env python3
"""Replay an EigenDrum time series through the standard GLVis socket protocol."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time


def connect_with_retry(host: str, port: int, attempts: int = 50) -> socket.socket:
    last_error: OSError | None = None
    for _ in range(attempts):
        try:
            return socket.create_connection((host, port), timeout=2.0)
        except OSError as error:
            last_error = error
            time.sleep(0.12)
    raise RuntimeError(
        f"Could not connect to GLVis at {host}:{port}. Start 'glvis' in another terminal, "
        "or rerun this script with --launch."
    ) from last_error


def send_frame(
    connection: socket.socket,
    mesh_text: str,
    grid_function_text: str,
    caption: str,
    metadata: dict,
    first: bool,
) -> None:
    chunks = ["solution\n", mesh_text, grid_function_text]
    if first:
        low, high = metadata["glvisDisplayValueRange"]
        chunks.extend([
            "window_title 'EigenDrum time-dependent vibration'\n",
            "shading smooth\n",
            "autoscale off\n",
            f"valuerange {low:.17g} {high:.17g}\n",
            "view 45 30\n",
            "autopause off\n",
        ])
        keys = metadata.get("glvisZStretchKeys", "")
        if keys:
            chunks.append(f"keys {keys}\n")
    chunks.append(f"plot_caption '{caption}'\n")
    connection.sendall("".join(chunks).encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Replay exact EigenDrum P1 grid-function samples in GLVis slow motion."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19916)
    parser.add_argument("--fps", type=float, default=None, help="Override exported playback FPS.")
    parser.add_argument("--loop", action="store_true", help="Repeat until Ctrl-C.")
    parser.add_argument("--launch", action="store_true", help="Launch a local GLVis server first.")
    parser.add_argument("--glvis", default="glvis", help="GLVis executable name or path.")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    mesh_text = (root / metadata["meshFile"]).read_text(encoding="utf-8")
    frame_paths = [root / name for name in metadata["frameFiles"]]
    playback_fps = args.fps if args.fps and args.fps > 0 else metadata["playbackFramesPerSecond"]

    child = None
    if args.launch:
        executable = shutil.which(args.glvis) if Path(args.glvis).name == args.glvis else args.glvis
        if not executable or not Path(executable).exists():
            raise RuntimeError(f"GLVis executable not found: {args.glvis}")
        child = subprocess.Popen([str(executable), "-p", str(args.port)], cwd=root)
        time.sleep(0.5)

    connection = connect_with_retry(args.host, args.port)
    print(
        f"Streaming {len(frame_paths)} frames at {playback_fps:g} fps "
        f"({metadata['slowMotionFactor']:.1f}x slow motion)."
    )
    try:
        first = True
        while True:
            start = time.perf_counter()
            for index, frame_path in enumerate(frame_paths):
                grid_function_text = frame_path.read_text(encoding="utf-8")
                physical_time = metadata["sampleTimesSeconds"][index]
                caption = f"EigenDrum vibration: t = {physical_time:.6e} s"
                send_frame(connection, mesh_text, grid_function_text, caption, metadata, first)
                first = False
                deadline = start + (index + 1) / playback_fps
                time.sleep(max(0.0, deadline - time.perf_counter()))
            if not args.loop:
                break
            start = time.perf_counter()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        connection.close()
        # Leave a launched GLVis process open so the final frame remains inspectable.
        _ = child
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"play_glvis.py: {error}", file=sys.stderr)
        raise SystemExit(1)
`;
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crc32Table();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

export function createStoredZip(files) {
  const encoder = new TextEncoder();
  const entries = files.map(({ name, data }) => {
    const nameBytes = encoder.encode(name);
    const dataBytes = data instanceof Uint8Array ? data : encoder.encode(String(data));
    return { name, nameBytes, dataBytes, crc: crc32(dataBytes) };
  });
  const { time, day } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const local = new Uint8Array(30 + entry.nameBytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, time);
    writeU16(localView, 12, day);
    writeU32(localView, 14, entry.crc);
    writeU32(localView, 18, entry.dataBytes.length);
    writeU32(localView, 22, entry.dataBytes.length);
    writeU16(localView, 26, entry.nameBytes.length);
    writeU16(localView, 28, 0);
    local.set(entry.nameBytes, 30);
    localParts.push(local, entry.dataBytes);

    const central = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, time);
    writeU16(centralView, 14, day);
    writeU32(centralView, 16, entry.crc);
    writeU32(centralView, 20, entry.dataBytes.length);
    writeU32(centralView, 24, entry.dataBytes.length);
    writeU16(centralView, 28, entry.nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    central.set(entry.nameBytes, 46);
    centralParts.push(central);
    offset += local.length + entry.dataBytes.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, centralOffset);
  writeU16(endView, 20, 0);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

export function buildGlvisVibrationPackage({
  mesh,
  solution,
  strike,
  basename = 'eigendrum-vibration',
  cycles = 4,
  playbackFps = 30,
  displayGain = 4,
}) {
  if (!mesh || !solution || !strike) throw new Error('A solved mesh and a completed strike are required for GLVis export.');
  const base = safeBasename(basename);
  const sampled = sampleVibrationFrames(strike, solution, { cycles, playbackFps });
  const gain = clamp(Number(displayGain) || 1, 1, 64);
  const displayValueRange = sampled.physicalValueRange / gain;
  const zStretchCount = clamp(Math.round(2 * Math.log2(gain)), 0, 16);
  const zStretchKeys = '+'.repeat(zStretchCount);
  const meshFile = `${base}.mesh`;
  const frameFiles = sampled.frames.map((_, index) => frameName(index));
  const metadata = {
    format: 'EigenDrum MFEM/GLVis vibration export v2',
    formulation: '-Delta u = lambda u on a unit-area membrane with homogeneous Dirichlet boundary conditions',
    finiteElementSpace: 'conforming H1 P1 triangles with a consistent mass matrix',
    field: 'exact unscaled modal displacement used by the browser sound/visualization before audio-only output limiting',
    temporalSampling: 'physical-time samples resolve the highest exported modal frequency; playback is intentionally slow motion',
    meshFile,
    frameFiles,
    strikePoint: Array.from(strike.point),
    requestedFundamentalCycles: sampled.requestedFundamentalCycles,
    actualFundamentalCycles: sampled.actualFundamentalCycles,
    fundamentalFrequencyHz: sampled.fundamentalFrequencyHz,
    maximumFrequencyHz: sampled.maximumFrequencyHz,
    physicalDurationSeconds: sampled.physicalDurationSeconds,
    physicalStepSeconds: sampled.physicalStepSeconds,
    physicalSampleRateHz: sampled.physicalSampleRateHz,
    samplesPerFastestPeriod: sampled.samplesPerFastestPeriod,
    playbackFramesPerSecond: sampled.playbackFps,
    playbackDurationSeconds: sampled.playbackDurationSeconds,
    slowMotionFactor: sampled.slowMotionFactor,
    frameCount: sampled.frameCount,
    nodeCount: sampled.nodeCount,
    truncatedBySizeLimit: sampled.truncatedBySizeLimit,
    sampleTimesSeconds: sampled.times,
    physicalValueRange: [-sampled.physicalValueRange, sampled.physicalValueRange],
    displayGain: gain,
    glvisDisplayValueRange: [-displayValueRange, displayValueRange],
    glvisZStretchKeys: zStretchKeys,
    eigenvalues: Array.from(solution.eigenvalues),
    frequenciesHz: Array.from(strike.frequencies),
    decayRatesPerSecond: Array.from(strike.decayRates),
    modalAmplitudes: Array.from(strike.amplitudes),
  };

  const meshText = mfemMeshText(mesh);
  const manifest = ['frame,file,physical_time_seconds'];
  frameFiles.forEach((name, index) => manifest.push(`${index},${name},${sampled.times[index].toPrecision(17)}`));
  manifest.push('');

  const files = [
    { name: meshFile, data: meshText },
    {
      name: 'eigendrum.glvs',
      data: glvisScriptText({
        basename: base,
        frameCount: sampled.frameCount,
        times: sampled.times,
        displayValueRange,
        zStretchKeys,
      }),
    },
    { name: 'play_glvis.py', data: playerPythonText() },
    { name: 'run_glvis.sh', data: '#!/bin/sh\ncd "$(dirname "$0")"\nexec python3 play_glvis.py --launch "$@"\n' },
    { name: 'frames.csv', data: manifest.join('\n') },
    { name: 'metadata.json', data: `${JSON.stringify(metadata, null, 2)}\n` },
    {
      name: 'README.txt',
      data: [
        'EIGENDRUM TIME-DEPENDENT GLVIS EXPORT',
        '',
        'The .mesh file and every P1 grid-function frame contain the exact, unscaled',
        'modal displacement used by the browser response. Browser display gain is not',
        'multiplied into the field values. It is recorded only as a GLVis color-range',
        'and vertical-stretch viewing preference.',
        '',
        'AUTOMATIC SLOW-MOTION PLAYBACK (recommended)',
        '  1. Open a terminal in this extracted directory.',
        '  2. Run: python3 play_glvis.py --launch',
        '     Or start GLVis separately with: glvis',
        '     and then run: python3 play_glvis.py',
        '  3. Add --loop to repeat. Add --fps 60 to override playback speed.',
        '',
        'MANUAL FRAME STEPPING',
        '  Run: glvis -run eigendrum.glvs',
        '  Press Space to advance through the braced physical-time samples.',
        '',
        `Physical interval: 0 to ${sampled.physicalDurationSeconds.toExponential(8)} s`,
        `Physical step: ${sampled.physicalStepSeconds.toExponential(8)} s`,
        `Highest-mode resolution: ${sampled.samplesPerFastestPeriod.toFixed(2)} samples per period`,
        `Playback: ${sampled.frameCount} frames at ${sampled.playbackFps} fps`,
        `Slow-motion factor: ${sampled.slowMotionFactor.toFixed(2)}x`,
        `Exact physical scalar range: ${(-sampled.physicalValueRange).toExponential(8)} to ${sampled.physicalValueRange.toExponential(8)}`,
        `GLVis display range (${gain}x gain): ${(-displayValueRange).toExponential(8)} to ${displayValueRange.toExponential(8)}`,
        '',
        'Use GLVis + / - to further stretch or compress the vertical displacement.',
        'Use F7 to change the color range, p/P or F6 to change palettes, and m to',
        'toggle mesh edges.',
        '',
      ].join('\n'),
    },
  ];
  sampled.frames.forEach((values, index) => files.push({ name: frameName(index), data: gridFunctionText(values) }));
  return { files, metadata, blob: createStoredZip(files), filename: `${base}-glvis-vibration.zip` };
}

export function exportGlvisVibration(options) {
  const packageData = buildGlvisVibrationPackage(options);
  downloadBlob(packageData.filename, packageData.blob);
  return packageData;
}
