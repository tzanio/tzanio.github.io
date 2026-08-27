function interpolateZero(pa, pb, va, vb) {
  const denominator = va - vb;
  const t = Math.abs(denominator) > 1e-30 ? va / denominator : 0.5;
  return [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
}

function pointKey(point, tolerance = 1e-7) {
  return `${Math.round(point[0] / tolerance)}:${Math.round(point[1] / tolerance)}`;
}

export function zeroContourSegments(mesh, values) {
  const segments = [];
  const epsilon = 1e-13 * Math.max(1, ...values.map((value) => Math.abs(value)));
  for (const triangle of mesh.triangles) {
    const crossings = [];
    const edges = [[0, 1], [1, 2], [2, 0]];
    for (const [localA, localB] of edges) {
      const a = triangle[localA];
      const b = triangle[localB];
      let va = values[a];
      let vb = values[b];
      if (Math.abs(va) < epsilon) va = 0;
      if (Math.abs(vb) < epsilon) vb = 0;
      if (va === 0 && vb === 0) continue;
      if (va === 0) crossings.push(mesh.points[a]);
      else if (vb === 0) crossings.push(mesh.points[b]);
      else if ((va > 0) !== (vb > 0)) crossings.push(interpolateZero(mesh.points[a], mesh.points[b], va, vb));
    }
    const unique = [];
    for (const point of crossings) {
      if (!unique.some((other) => Math.hypot(point[0] - other[0], point[1] - other[1]) < 1e-9)) unique.push(point);
    }
    if (unique.length >= 2) segments.push([unique[0], unique[1]]);
  }
  return segments;
}

export function chainSegments(segments) {
  const adjacency = new Map();
  const pointByKey = new Map();
  const edges = segments.map(([a, b], index) => {
    const ka = pointKey(a);
    const kb = pointKey(b);
    pointByKey.set(ka, a);
    pointByKey.set(kb, b);
    if (!adjacency.has(ka)) adjacency.set(ka, []);
    if (!adjacency.has(kb)) adjacency.set(kb, []);
    adjacency.get(ka).push({ edge: index, other: kb });
    adjacency.get(kb).push({ edge: index, other: ka });
    return [ka, kb];
  });
  const used = new Uint8Array(edges.length);
  const polylines = [];

  const trace = (startKey, startEdge) => {
    const line = [pointByKey.get(startKey)];
    let key = startKey;
    let edgeIndex = startEdge;
    while (edgeIndex !== undefined && !used[edgeIndex]) {
      used[edgeIndex] = 1;
      const [a, b] = edges[edgeIndex];
      const nextKey = a === key ? b : a;
      line.push(pointByKey.get(nextKey));
      const candidate = adjacency.get(nextKey).find((entry) => !used[entry.edge]);
      key = nextKey;
      edgeIndex = candidate?.edge;
      if (key === startKey) break;
    }
    return line;
  };

  for (const [key, entries] of adjacency) {
    if (entries.length === 2) continue;
    for (const entry of entries) if (!used[entry.edge]) polylines.push(trace(key, entry.edge));
  }
  for (let edge = 0; edge < edges.length; edge += 1) {
    if (!used[edge]) polylines.push(trace(edges[edge][0], edge));
  }
  return polylines.filter((line) => line.length >= 2);
}

export function chaikinSmooth(points, iterations = 2) {
  let result = points.map((point) => point.slice());
  const closed = result.length > 2 && Math.hypot(
    result[0][0] - result[result.length - 1][0],
    result[0][1] - result[result.length - 1][1],
  ) < 1e-7;
  for (let pass = 0; pass < iterations; pass += 1) {
    const next = [];
    if (!closed) next.push(result[0]);
    const limit = closed ? result.length - 1 : result.length - 1;
    for (let i = 0; i < limit; i += 1) {
      const a = result[i];
      const b = result[(i + 1) % result.length];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) next.push(result[result.length - 1]);
    else next.push(next[0].slice());
    result = next;
  }
  return result;
}

export function smoothZeroContours(mesh, values, iterations = 2) {
  return chainSegments(zeroContourSegments(mesh, values)).map((line) => chaikinSmooth(line, iterations));
}
