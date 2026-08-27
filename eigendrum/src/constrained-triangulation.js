// Self-contained constrained triangulation for a single simple polygon.
//
// The input convention matches EigenDrum's mesher: polygon boundary vertices
// occupy indices [0, boundaryCount), in cyclic counter-clockwise order; all
// later points are interior candidates.  Boundary edges are never flipped.
// The algorithm is:
//   1. ear-clip a collinearity-reduced boundary polygon;
//   2. reinsert omitted boundary samples by splitting constrained edges;
//   3. insert interior points by triangle/edge splitting;
//   4. apply Lawson flips to all unconstrained edges.
//
// This removes the previous runtime dependency on cdt2d/esm.sh while retaining
// a conforming, boundary-fitted, Delaunay-improved triangular mesh.

const EPS = 1e-12;

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function orientTriangle(points, triangle) {
  const [a, b, c] = triangle;
  return orient(points[a], points[b], points[c]) >= 0 ? [a, b, c] : [a, c, b];
}

function triangleScale(points, a, b, c) {
  const pa = points[a];
  const pb = points[b];
  const pc = points[c];
  return Math.max(
    (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2,
    (pb[0] - pc[0]) ** 2 + (pb[1] - pc[1]) ** 2,
    (pc[0] - pa[0]) ** 2 + (pc[1] - pa[1]) ** 2,
    1,
  );
}

function pointInTriangle(point, a, b, c, tolerance = 1e-12) {
  const denominator = orient(a, b, c);
  if (Math.abs(denominator) < EPS) return null;
  const s0 = orient(a, b, point);
  const s1 = orient(b, c, point);
  const s2 = orient(c, a, point);
  const sign = denominator > 0 ? 1 : -1;
  const scale = Math.max(Math.abs(denominator), 1);
  if (sign * s0 < -tolerance * scale
      || sign * s1 < -tolerance * scale
      || sign * s2 < -tolerance * scale) return null;
  return [sign * s0, sign * s1, sign * s2];
}

function reducedBoundaryIndices(points, boundaryCount) {
  const retained = [];
  for (let i = 0; i < boundaryCount; i += 1) {
    const previous = points[(i - 1 + boundaryCount) % boundaryCount];
    const current = points[i];
    const next = points[(i + 1) % boundaryCount];
    const ux = current[0] - previous[0];
    const uy = current[1] - previous[1];
    const vx = next[0] - current[0];
    const vy = next[1] - current[1];
    const product = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const sine = product > EPS ? Math.abs(ux * vy - uy * vx) / product : 0;
    // Exact or nearly exact straight-edge samples are reinserted later. Curved
    // boundaries (including the 64-gon circle) retain their genuine turning.
    if (sine > 1e-8) retained.push(i);
  }
  if (retained.length < 3) {
    // Degenerate fallback: keep vertices distributed around the cycle. This is
    // only reachable for malformed or numerically collapsed outlines.
    retained.length = 0;
    retained.push(0, Math.floor(boundaryCount / 3), Math.floor(2 * boundaryCount / 3));
  }
  return retained;
}

function earClip(points, polygonIndices) {
  const remaining = polygonIndices.slice();
  const triangles = [];
  let guard = 0;
  const guardLimit = Math.max(100, remaining.length * remaining.length * 3);

  while (remaining.length > 3 && guard < guardLimit) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const ia = remaining[(i - 1 + remaining.length) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];
      const a = points[ia];
      const b = points[ib];
      const c = points[ic];
      const turn = orient(a, b, c);
      if (turn <= 1e-14 * triangleScale(points, ia, ib, ic)) continue;

      let contains = false;
      for (const candidate of remaining) {
        if (candidate === ia || candidate === ib || candidate === ic) continue;
        const hit = pointInTriangle(points[candidate], a, b, c, 2e-13);
        // A non-adjacent polygon vertex lying on an ear diagonal must also
        // block that ear.  Ignoring boundary hits can bridge across a reflex
        // corner (the unit L-shape is the canonical example) and triangulate
        // the convex hull instead of the polygon.
        if (hit) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      triangles.push([ia, ib, ic]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }

    if (!clipped) {
      throw new Error('Unable to triangulate the polygon boundary. Remove self-touching or extremely narrow features.');
    }
    guard += 1;
  }

  if (remaining.length === 3) triangles.push(orientTriangle(points, remaining));
  if (!triangles.length) throw new Error('Boundary triangulation produced no elements.');
  return triangles.map((triangle) => orientTriangle(points, triangle));
}

class Triangulation {
  constructor(points, triangles, constrainedEdges = []) {
    this.points = points;
    this.triangles = [];
    this.edgeMap = new Map();
    this.constrained = new Set(constrainedEdges.map(([a, b]) => edgeKey(a, b)));
    for (const triangle of triangles) this.addTriangle(triangle);
  }

  edgeAdd(key, triangleIndex) {
    let owners = this.edgeMap.get(key);
    if (!owners) {
      owners = new Set();
      this.edgeMap.set(key, owners);
    }
    owners.add(triangleIndex);
  }

  edgeRemove(key, triangleIndex) {
    const owners = this.edgeMap.get(key);
    if (!owners) return;
    owners.delete(triangleIndex);
    if (owners.size === 0) this.edgeMap.delete(key);
  }

  triangleEdges(triangle) {
    return [
      edgeKey(triangle[0], triangle[1]),
      edgeKey(triangle[1], triangle[2]),
      edgeKey(triangle[2], triangle[0]),
    ];
  }

  addTriangle(triangle) {
    const oriented = orientTriangle(this.points, triangle);
    const area = orient(
      this.points[oriented[0]],
      this.points[oriented[1]],
      this.points[oriented[2]],
    );
    if (!(area > 1e-15 * triangleScale(this.points, ...oriented))) return -1;
    const index = this.triangles.length;
    this.triangles.push(oriented);
    for (const key of this.triangleEdges(oriented)) this.edgeAdd(key, index);
    return index;
  }

  removeTriangle(index) {
    const triangle = this.triangles[index];
    if (!triangle) return;
    for (const key of this.triangleEdges(triangle)) this.edgeRemove(key, index);
    this.triangles[index] = null;
  }

  setTriangle(index, triangle) {
    this.removeTriangle(index);
    const oriented = orientTriangle(this.points, triangle);
    const area = orient(
      this.points[oriented[0]],
      this.points[oriented[1]],
      this.points[oriented[2]],
    );
    if (!(area > 1e-15 * triangleScale(this.points, ...oriented))) {
      throw new Error('Triangulation update generated a degenerate element.');
    }
    this.triangles[index] = oriented;
    for (const key of this.triangleEdges(oriented)) this.edgeAdd(key, index);
  }

  oppositeVertex(triangle, u, v) {
    return triangle.find((index) => index !== u && index !== v);
  }

  splitBoundaryEdge(u, v, pointIndex) {
    const key = edgeKey(u, v);
    const owners = [...(this.edgeMap.get(key) ?? [])].filter((index) => this.triangles[index]);
    if (owners.length !== 1) {
      throw new Error('A sampled boundary edge was not present exactly once in the triangulation.');
    }
    const triangleIndex = owners[0];
    const opposite = this.oppositeVertex(this.triangles[triangleIndex], u, v);
    this.removeTriangle(triangleIndex);
    this.triangles[triangleIndex] = orientTriangle(this.points, [u, pointIndex, opposite]);
    for (const edge of this.triangleEdges(this.triangles[triangleIndex])) this.edgeAdd(edge, triangleIndex);
    this.addTriangle([pointIndex, v, opposite]);
    this.constrained.delete(key);
    this.constrained.add(edgeKey(u, pointIndex));
    this.constrained.add(edgeKey(pointIndex, v));
  }

  locatePoint(pointIndex) {
    const point = this.points[pointIndex];
    for (let index = 0; index < this.triangles.length; index += 1) {
      const triangle = this.triangles[index];
      if (!triangle) continue;
      const [a, b, c] = triangle.map((vertex) => this.points[vertex]);
      const hit = pointInTriangle(point, a, b, c, 5e-12);
      if (!hit) continue;
      const scale = Math.max(hit[0] + hit[1] + hit[2], 1);
      let edge = null;
      if (hit[0] <= 2e-11 * scale) edge = [triangle[0], triangle[1]];
      else if (hit[1] <= 2e-11 * scale) edge = [triangle[1], triangle[2]];
      else if (hit[2] <= 2e-11 * scale) edge = [triangle[2], triangle[0]];
      return { triangleIndex: index, edge };
    }
    return null;
  }

  insertPoint(pointIndex) {
    const point = this.points[pointIndex];
    for (let i = 0; i < pointIndex; i += 1) {
      const dx = point[0] - this.points[i][0];
      const dy = point[1] - this.points[i][1];
      if (dx * dx + dy * dy < 1e-24) return false;
    }

    const location = this.locatePoint(pointIndex);
    if (!location) return false;
    if (location.edge) return this.splitEdge(location.edge[0], location.edge[1], pointIndex);

    const triangleIndex = location.triangleIndex;
    const [a, b, c] = this.triangles[triangleIndex];
    this.removeTriangle(triangleIndex);
    this.triangles[triangleIndex] = orientTriangle(this.points, [a, b, pointIndex]);
    for (const edge of this.triangleEdges(this.triangles[triangleIndex])) this.edgeAdd(edge, triangleIndex);
    this.addTriangle([b, c, pointIndex]);
    this.addTriangle([c, a, pointIndex]);
    return true;
  }

  splitEdge(u, v, pointIndex) {
    const key = edgeKey(u, v);
    const owners = [...(this.edgeMap.get(key) ?? [])].filter((index) => this.triangles[index]);
    if (owners.length === 0 || owners.length > 2) return false;
    const opposites = owners.map((index) => this.oppositeVertex(this.triangles[index], u, v));
    for (const index of owners) this.removeTriangle(index);

    const first = owners[0];
    this.triangles[first] = orientTriangle(this.points, [u, pointIndex, opposites[0]]);
    for (const edge of this.triangleEdges(this.triangles[first])) this.edgeAdd(edge, first);
    this.addTriangle([pointIndex, v, opposites[0]]);

    if (owners.length === 2) {
      const second = owners[1];
      this.triangles[second] = orientTriangle(this.points, [v, pointIndex, opposites[1]]);
      for (const edge of this.triangleEdges(this.triangles[second])) this.edgeAdd(edge, second);
      this.addTriangle([pointIndex, u, opposites[1]]);
    }

    if (this.constrained.has(key)) {
      this.constrained.delete(key);
      this.constrained.add(edgeKey(u, pointIndex));
      this.constrained.add(edgeKey(pointIndex, v));
    }
    return true;
  }

  edgeIsIllegal(key) {
    if (this.constrained.has(key)) return null;
    const owners = [...(this.edgeMap.get(key) ?? [])].filter((index) => this.triangles[index]);
    if (owners.length !== 2) return null;
    const [u, v] = key.split(':').map(Number);
    const p = this.oppositeVertex(this.triangles[owners[0]], u, v);
    const q = this.oppositeVertex(this.triangles[owners[1]], u, v);
    if ([u, v, p, q].some((value) => value === undefined)) return null;

    const pu = this.points[u];
    const pv = this.points[v];
    const pp = this.points[p];
    const pq = this.points[q];
    if (orient(pu, pv, pp) * orient(pu, pv, pq) >= -1e-20) return null;
    if (orient(pp, pq, pu) * orient(pp, pq, pv) >= -1e-20) return null;

    let a = pu;
    let b = pv;
    let c = pp;
    if (orient(a, b, c) < 0) [a, b] = [b, a];
    const ax = a[0] - pq[0];
    const ay = a[1] - pq[1];
    const bx = b[0] - pq[0];
    const by = b[1] - pq[1];
    const cx = c[0] - pq[0];
    const cy = c[1] - pq[1];
    const determinant = (ax * ax + ay * ay) * (bx * cy - by * cx)
      - (bx * bx + by * by) * (ax * cy - ay * cx)
      + (cx * cx + cy * cy) * (ax * by - ay * bx);
    const coordinateScale = Math.max(
      Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by), Math.abs(cx), Math.abs(cy), 1,
    );
    if (determinant <= 2e-13 * coordinateScale ** 4) return null;
    return { owners, u, v, p, q };
  }

  flipEdge(description) {
    const { owners, u, v, p, q } = description;
    const [first, second] = owners;
    this.removeTriangle(first);
    this.removeTriangle(second);
    this.triangles[first] = orientTriangle(this.points, [p, q, u]);
    this.triangles[second] = orientTriangle(this.points, [q, p, v]);
    for (const key of this.triangleEdges(this.triangles[first])) this.edgeAdd(key, first);
    for (const key of this.triangleEdges(this.triangles[second])) this.edgeAdd(key, second);
    return [
      ...this.triangleEdges(this.triangles[first]),
      ...this.triangleEdges(this.triangles[second]),
    ];
  }

  improveDelaunay() {
    const queue = [...this.edgeMap.keys()];
    let cursor = 0;
    let flips = 0;
    const flipLimit = Math.max(200, this.triangles.length * 30);
    while (cursor < queue.length && flips < flipLimit) {
      const key = queue[cursor++];
      const description = this.edgeIsIllegal(key);
      if (!description) continue;
      queue.push(...this.flipEdge(description));
      flips += 1;
    }
    return flips;
  }

  activeTriangles() {
    return this.triangles.filter(Boolean);
  }
}

function boundaryChains(retained, boundaryCount) {
  const chains = [];
  for (let k = 0; k < retained.length; k += 1) {
    const start = retained[k];
    const end = retained[(k + 1) % retained.length];
    const omitted = [];
    let index = (start + 1) % boundaryCount;
    while (index !== end) {
      omitted.push(index);
      index = (index + 1) % boundaryCount;
    }
    chains.push({ start, end, omitted });
  }
  return chains;
}

export function constrainedTriangulate(points, boundaryCount) {
  if (!Array.isArray(points) || boundaryCount < 3 || boundaryCount > points.length) {
    throw new Error('Invalid constrained triangulation input.');
  }
  const retained = reducedBoundaryIndices(points, boundaryCount);
  const initialTriangles = earClip(points, retained);
  const initialEdges = retained.map((value, index) => [value, retained[(index + 1) % retained.length]]);
  const triangulation = new Triangulation(points, initialTriangles, initialEdges);

  for (const chain of boundaryChains(retained, boundaryCount)) {
    let left = chain.start;
    for (const pointIndex of chain.omitted) {
      triangulation.splitBoundaryEdge(left, chain.end, pointIndex);
      left = pointIndex;
    }
  }

  for (let pointIndex = boundaryCount; pointIndex < points.length; pointIndex += 1) {
    triangulation.insertPoint(pointIndex);
  }
  triangulation.improveDelaunay();
  return triangulation.activeTriangles();
}
