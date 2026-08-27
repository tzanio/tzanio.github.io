import { boundsOf } from './geometry.js';
import { scalarToPalette, rgbCss } from './palettes.js';
import { smoothZeroContours } from './contours.js';

function maxAbs(values) {
  let maximum = 0;
  if (!values) return maximum;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

export class TopViewRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.mesh = null;
    this.transform = null;
    this.palette = 'glvis-five';
    this.showMesh = false;
    this.showNodal = false;
    this.drawing = false;
    this.drawingPoints = [];
    this.closePreview = false;
    this.lastValues = null;
    this.lastRange = 1;
    this.lastStrikePoint = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2.5, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.computeTransform();
    this.render(this.lastValues, this.lastRange, this.lastStrikePoint);
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this.computeTransform();
  }

  clearMesh() {
    this.mesh = null;
    this.lastValues = null;
    this.transform = null;
    this.render(null, 1, null);
  }

  setOptions({ palette, showMesh, showNodal }) {
    if (palette) this.palette = palette;
    if (typeof showMesh === 'boolean') this.showMesh = showMesh;
    if (typeof showNodal === 'boolean') this.showNodal = showNodal;
    this.render(this.lastValues, this.lastRange, this.lastStrikePoint);
  }

  setDrawing(enabled, points = [], closePreview = false) {
    this.drawing = enabled;
    this.drawingPoints = points;
    this.closePreview = closePreview;
    if (enabled) this.clearMesh();
    else this.render(this.lastValues, this.lastRange, this.lastStrikePoint);
  }

  updateDrawing(points, closePreview = false) {
    this.drawingPoints = points;
    this.closePreview = closePreview;
    this.render(null, 1, null);
  }

  computeTransform() {
    if (!this.mesh || this.mesh.points.length === 0) {
      this.transform = null;
      return;
    }
    const bounds = boundsOf(this.mesh.points);
    const padding = 0.09;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const sx = (1 - 2 * padding) * width / Math.max(bounds.width, 1e-9);
    const sy = (1 - 2 * padding) * height / Math.max(bounds.height, 1e-9);
    const scale = Math.min(sx, sy);
    const centerX = 0.5 * (bounds.minX + bounds.maxX);
    const centerY = 0.5 * (bounds.minY + bounds.maxY);
    this.transform = {
      scale,
      centerX,
      centerY,
      screenX: width / 2,
      screenY: height / 2,
    };
  }

  worldToScreen(point) {
    const t = this.transform;
    return [
      t.screenX + (point[0] - t.centerX) * t.scale,
      t.screenY - (point[1] - t.centerY) * t.scale,
    ];
  }

  clientToWorld(clientX, clientY) {
    if (!this.transform) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * this.canvas.width / Math.max(rect.width, 1);
    const y = (clientY - rect.top) * this.canvas.height / Math.max(rect.height, 1);
    const t = this.transform;
    return [t.centerX + (x - t.screenX) / t.scale, t.centerY - (y - t.screenY) / t.scale];
  }

  clientToDrawingPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return [
      2 * (clientX - rect.left) / Math.max(rect.width, 1) - 1,
      1 - 2 * (clientY - rect.top) / Math.max(rect.height, 1),
    ];
  }

  drawingToScreen(point) {
    return [0.5 * (point[0] + 1) * this.canvas.width, 0.5 * (1 - point[1]) * this.canvas.height];
  }

  render(values, range = null, strikePoint = null) {
    this.lastValues = values;
    this.lastRange = range ?? (values ? maxAbs(values) : 1);
    this.lastStrikePoint = strikePoint;
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.fillStyle = '#f9f7f2';
    ctx.fillRect(0, 0, width, height);

    if (this.drawing) {
      this.renderDrawing();
      return;
    }

    if (!this.mesh || !values || !this.transform) {
      ctx.fillStyle = '#8c887f';
      ctx.font = `${Math.max(12, width / 55)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Choose a shape to compute its membrane spectrum', width / 2, height / 2);
      return;
    }

    const colorRange = Math.max(this.lastRange, 1e-12);
    for (const triangle of this.mesh.triangles) {
      const points = triangle.map((index) => this.worldToScreen(this.mesh.points[index]));
      const value = (values[triangle[0]] + values[triangle[1]] + values[triangle[2]]) / 3;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      ctx.lineTo(points[1][0], points[1][1]);
      ctx.lineTo(points[2][0], points[2][1]);
      ctx.closePath();
      ctx.fillStyle = rgbCss(scalarToPalette(value, colorRange, this.palette));
      ctx.fill();
    }

    if (this.showMesh) {
      ctx.beginPath();
      for (const triangle of this.mesh.triangles) {
        const points = triangle.map((index) => this.worldToScreen(this.mesh.points[index]));
        ctx.moveTo(points[0][0], points[0][1]);
        ctx.lineTo(points[1][0], points[1][1]);
        ctx.lineTo(points[2][0], points[2][1]);
        ctx.closePath();
      }
      ctx.strokeStyle = 'rgba(23, 24, 24, .19)';
      ctx.lineWidth = Math.max(0.55, this.canvas.width / 1500);
      ctx.stroke();
    }

    if (this.showNodal && maxAbs(values) > 1e-11) this.renderNodalLines(values);

    ctx.beginPath();
    for (const [a, b] of this.mesh.boundaryEdges) {
      const pa = this.worldToScreen(this.mesh.points[a]);
      const pb = this.worldToScreen(this.mesh.points[b]);
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
    }
    ctx.strokeStyle = '#171816';
    ctx.lineWidth = Math.max(1.4, this.canvas.width / 650);
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (strikePoint) {
      const point = this.worldToScreen(strikePoint);
      const radius = Math.max(4, this.canvas.width / 125);
      ctx.beginPath();
      ctx.arc(point[0], point[1], radius, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(255,255,255,.78)';
      ctx.fill();
      ctx.strokeStyle = '#171816';
      ctx.lineWidth = Math.max(1.2, this.canvas.width / 1000);
      ctx.stroke();
    }
  }

  renderNodalLines(values) {
    const ctx = this.context;
    const lines = smoothZeroContours(this.mesh, values, 2);
    ctx.save();
    ctx.beginPath();
    for (const line of lines) {
      if (line.length < 2) continue;
      const first = this.worldToScreen(line[0]);
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < line.length; i += 1) {
        const point = this.worldToScreen(line[i]);
        ctx.lineTo(point[0], point[1]);
      }
    }
    ctx.strokeStyle = 'rgba(20,20,18,.88)';
    ctx.lineWidth = Math.max(1.25, this.canvas.width / 850);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  renderDrawing() {
    const ctx = this.context;
    const points = this.drawingPoints;
    ctx.fillStyle = '#7d786e';
    ctx.font = `${Math.max(12, this.canvas.width / 58)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    if (points.length === 0) {
      ctx.fillText('Draw a simple closed outline', this.canvas.width / 2, this.canvas.height / 2);
      return;
    }
    const screen = points.map((point) => this.drawingToScreen(point));
    ctx.beginPath();
    ctx.moveTo(screen[0][0], screen[0][1]);
    for (let i = 1; i < screen.length; i += 1) ctx.lineTo(screen[i][0], screen[i][1]);
    if (this.closePreview && screen.length > 2) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(169,68,50,.08)';
      ctx.fill();
    }
    ctx.strokeStyle = this.closePreview ? '#793024' : '#a94432';
    ctx.lineWidth = Math.max(2, this.canvas.width / 450);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    for (let i = 0; i < screen.length; i += 1) {
      ctx.beginPath();
      ctx.arc(screen[i][0], screen[i][1], i === 0 ? 5 : 2.5, 0, 2 * Math.PI);
      ctx.fillStyle = i === 0 ? '#1c1c1a' : '#a94432';
      ctx.fill();
    }
  }
}

export function renderModeThumbnail(canvas, mesh, values, palette) {
  const context = canvas.getContext('2d', { alpha: false });
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(80, Math.round(rect.width * ratio));
  canvas.height = Math.max(70, Math.round(rect.height * ratio));
  context.fillStyle = '#f9f7f2';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const bounds = boundsOf(mesh.points);
  const scale = 0.82 * Math.min(
    canvas.width / Math.max(bounds.width, 1e-9),
    canvas.height / Math.max(bounds.height, 1e-9),
  );
  const centerX = 0.5 * (bounds.minX + bounds.maxX);
  const centerY = 0.5 * (bounds.minY + bounds.maxY);
  const map = ([x, y]) => [
    canvas.width / 2 + (x - centerX) * scale,
    canvas.height / 2 - (y - centerY) * scale,
  ];
  const range = Math.max(maxAbs(values), 1e-12);
  for (const triangle of mesh.triangles) {
    const points = triangle.map((index) => map(mesh.points[index]));
    const value = (values[triangle[0]] + values[triangle[1]] + values[triangle[2]]) / 3;
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    context.lineTo(points[1][0], points[1][1]);
    context.lineTo(points[2][0], points[2][1]);
    context.closePath();
    context.fillStyle = rgbCss(scalarToPalette(value, range, palette));
    context.fill();
  }
}
