import { constrainedTriangulate } from './constrained-triangulation.js';
import {
  boundsOf,
  distanceToBoundary,
  normalizeUnitArea,
  pointInPolygon,
  resampleClosedPolygon,
} from './geometry.js';

const SQRT3 = Math.sqrt(3);


function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function triangleArea(points, triangle) {
  const [a, b, c] = triangle.map((i) => points[i]);
  return 0.5 * Math.abs(orient(a, b, c));
}

function makeInteriorLattice(polygon, h) {
  const bounds = boundsOf(polygon);
  const dy = 0.5 * SQRT3 * h;
  const points = [];
  let row = 0;
  for (let y = bounds.minY + 0.45 * h; y <= bounds.maxY - 0.35 * h; y += dy, row += 1) {
    const shift = row % 2 ? 0.5 * h : 0;
    for (let x = bounds.minX + 0.35 * h + shift; x <= bounds.maxX - 0.35 * h; x += h) {
      const point = [x, y];
      if (pointInPolygon(point, polygon) && distanceToBoundary(point, polygon) > 0.32 * h) {
        points.push(point);
      }
    }
  }
  return points;
}

function exactInteriorLattice(polygon, targetInterior) {
  const target = Math.max(20, Math.round(targetInterior));
  let h = Math.sqrt(2 / (SQRT3 * target)) * 1.02;
  let points = makeInteriorLattice(polygon, h);
  let fineH;
  let finePoints;
  let coarseH;

  if (points.length >= target) {
    fineH = h;
    finePoints = points;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      h *= 1.12;
      points = makeInteriorLattice(polygon, h);
      if (points.length < target) {
        coarseH = h;
        break;
      }
      if (points.length < finePoints.length) {
        fineH = h;
        finePoints = points;
      }
    }
  } else {
    coarseH = h;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      h *= 0.88;
      points = makeInteriorLattice(polygon, h);
      if (points.length >= target) {
        fineH = h;
        finePoints = points;
        break;
      }
      coarseH = h;
    }
  }

  if (!finePoints) {
    throw new Error(`Unable to place ${target} interior mesh points in the selected domain.`);
  }
  if (!coarseH) coarseH = fineH * 1.12;

  // Find the coarsest spacing that still supplies at least the requested
  // number of interior vertices. This minimizes oversampling before the
  // deterministic exact-count selection below.
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const mid = 0.5 * (fineH + coarseH);
    const candidate = makeInteriorLattice(polygon, mid);
    if (candidate.length >= target) {
      fineH = mid;
      finePoints = candidate;
    } else {
      coarseH = mid;
    }
  }

  if (finePoints.length === target) return { h: fineH, points: finePoints };
  const selected = [];
  for (let i = 0; i < target; i += 1) {
    const index = Math.min(
      finePoints.length - 1,
      Math.floor((i + 0.5) * finePoints.length / target),
    );
    selected.push(finePoints[index]);
  }
  return { h: fineH, points: selected };
}
function triangulate(points, boundaryCount) {
  const raw = constrainedTriangulate(points, boundaryCount);
  const triangles = [];
  for (const cell of raw) {
    if (cell.length !== 3) continue;
    const tri = orient(points[cell[0]], points[cell[1]], points[cell[2]]) >= 0
      ? [cell[0], cell[1], cell[2]]
      : [cell[0], cell[2], cell[1]];
    if (triangleArea(points, tri) > 1e-14) triangles.push(tri);
  }
  return triangles;
}

function buildAdjacency(vertexCount, triangles) {
  const adjacency = Array.from({ length: vertexCount }, () => new Set());
  for (const [a, b, c] of triangles) {
    adjacency[a].add(b); adjacency[a].add(c);
    adjacency[b].add(a); adjacency[b].add(c);
    adjacency[c].add(a); adjacency[c].add(b);
  }
  return adjacency;
}

function moveIsValid(index, candidate, points, trianglesByVertex, polygon) {
  if (!pointInPolygon(candidate, polygon) || distanceToBoundary(candidate, polygon) < 1e-8) return false;
  const previous = points[index];
  points[index] = candidate;
  let valid = true;
  for (const tri of trianglesByVertex[index]) {
    const [a, b, c] = tri.map((i) => points[i]);
    if (orient(a, b, c) < 1e-11) {
      valid = false;
      break;
    }
  }
  points[index] = previous;
  return valid;
}

function smoothInterior(points, triangles, boundaryCount, polygon, passes = 2) {
  const result = points.map((p) => [p[0], p[1]]);
  for (let pass = 0; pass < passes; pass += 1) {
    const adjacency = buildAdjacency(result.length, triangles);
    const trianglesByVertex = Array.from({ length: result.length }, () => []);
    for (const tri of triangles) for (const index of tri) trianglesByVertex[index].push(tri);
    const proposed = result.map((p) => p.slice());
    for (let i = boundaryCount; i < result.length; i += 1) {
      const neighbors = [...adjacency[i]];
      if (neighbors.length < 3) continue;
      const average = neighbors.reduce((sum, j) => [sum[0] + result[j][0], sum[1] + result[j][1]], [0, 0]);
      average[0] /= neighbors.length;
      average[1] /= neighbors.length;
      const candidate = [
        result[i][0] + 0.48 * (average[0] - result[i][0]),
        result[i][1] + 0.48 * (average[1] - result[i][1]),
      ];
      if (moveIsValid(i, candidate, result, trianglesByVertex, polygon)) proposed[i] = candidate;
    }
    for (let i = boundaryCount; i < result.length; i += 1) result[i] = proposed[i];
  }
  return result;
}

function compactMesh(points, triangles, boundaryCount) {
  const used = new Uint8Array(points.length);
  for (const tri of triangles) for (const index of tri) used[index] = 1;
  for (let i = 0; i < boundaryCount; i += 1) used[i] = 1;
  const map = new Int32Array(points.length).fill(-1);
  const compactPoints = [];
  const boundary = [];
  for (let i = 0; i < points.length; i += 1) {
    if (!used[i]) continue;
    map[i] = compactPoints.length;
    compactPoints.push(points[i]);
    boundary.push(i < boundaryCount);
  }
  const compactTriangles = triangles.map((tri) => tri.map((i) => map[i]));
  const boundaryEdges = [];
  for (let i = 0; i < boundaryCount; i += 1) {
    const a = map[i];
    const b = map[(i + 1) % boundaryCount];
    if (a >= 0 && b >= 0) boundaryEdges.push([a, b]);
  }
  return { points: compactPoints, triangles: compactTriangles, boundary, boundaryEdges };
}

export function meshQuality(mesh) {
  let area = 0;
  let minAngle = 180;
  let maxAspect = 0;
  for (const triangle of mesh.triangles) {
    const p = triangle.map((i) => mesh.points[i]);
    const lengths = [
      Math.hypot(p[1][0] - p[2][0], p[1][1] - p[2][1]),
      Math.hypot(p[2][0] - p[0][0], p[2][1] - p[0][1]),
      Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]),
    ];
    const triArea = 0.5 * Math.abs(orient(p[0], p[1], p[2]));
    area += triArea;
    const angles = lengths.map((opposite, i) => {
      const a = lengths[(i + 1) % 3];
      const b = lengths[(i + 2) % 3];
      const cosine = Math.max(-1, Math.min(1, (a * a + b * b - opposite * opposite) / (2 * a * b)));
      return Math.acos(cosine) * 180 / Math.PI;
    });
    minAngle = Math.min(minAngle, ...angles);
    const semiperimeter = 0.5 * (lengths[0] + lengths[1] + lengths[2]);
    const inradius = triArea / Math.max(semiperimeter, 1e-30);
    const circumradius = lengths[0] * lengths[1] * lengths[2] / Math.max(4 * triArea, 1e-30);
    maxAspect = Math.max(maxAspect, circumradius / Math.max(2 * inradius, 1e-30));
  }
  return { area, minAngle, maxAspect };
}

export function generateTriangularMesh(inputPolygon, targetInterior = 400) {
  const polygon = normalizeUnitArea(inputPolygon);
  const target = Math.max(20, Math.round(targetInterior));
  const interior = exactInteriorLattice(polygon, target);
  const h = interior.h;
  const boundaryPoints = resampleClosedPolygon(polygon, 0.86 * h, 1);
  const interiorPoints = interior.points;
  let points = boundaryPoints.concat(interiorPoints);
  let triangles = triangulate(points, boundaryPoints.length);
  points = smoothInterior(points, triangles, boundaryPoints.length, polygon, 2);
  triangles = triangulate(points, boundaryPoints.length);
  const mesh = compactMesh(points, triangles, boundaryPoints.length);
  const quality = meshQuality(mesh);
  return {
    ...mesh,
    polygon,
    targetInterior: target,
    spacing: h,
    quality,
    generation: 0,
  };
}
