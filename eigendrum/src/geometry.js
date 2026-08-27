const TAU = 2 * Math.PI;

export function polygonArea(points) {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a[0] * b[1] - a[1] * b[0];
  }
  return 0.5 * twiceArea;
}

export function ensureCounterClockwise(points) {
  const copy = points.map((p) => [p[0], p[1]]);
  return polygonArea(copy) < 0 ? copy.reverse() : copy;
}

export function normalizeUnitArea(points) {
  const polygon = ensureCounterClockwise(points);
  const area = Math.abs(polygonArea(polygon));
  if (!(area > 1e-12)) throw new Error('The shape has negligible area.');
  let cx = 0;
  let cy = 0;
  let weight = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
    weight += cross;
  }
  if (Math.abs(weight) > 1e-14) {
    cx /= 3 * weight;
    cy /= 3 * weight;
  } else {
    cx = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
    cy = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
  }
  const scale = 1 / Math.sqrt(area);
  return polygon.map((p) => [(p[0] - cx) * scale, (p[1] - cy) * scale]);
}

export function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-30) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distancePointSegment(point, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = point[0] - a[0];
  const wy = point[1] - a[1];
  const vv = vx * vx + vy * vy;
  const t = vv > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv)) : 0;
  const dx = point[0] - (a[0] + t * vx);
  const dy = point[1] - (a[1] + t * vy);
  return Math.hypot(dx, dy);
}

export function distanceToBoundary(point, polygon) {
  let distance = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    distance = Math.min(distance, distancePointSegment(point, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return distance;
}

export function resampleClosedPolygon(points, spacing, minimumPerEdge = 1) {
  const polygon = ensureCounterClockwise(points);
  const sampled = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.max(minimumPerEdge, Math.ceil(length / spacing));
    for (let j = 0; j < count; j += 1) {
      const t = j / count;
      sampled.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return sampled;
}

export function simplifyRdp(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const a = points[0];
  const b = points[points.length - 1];
  let maxDistance = -1;
  let split = -1;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = distancePointSegment(points[i], a, b);
    if (d > maxDistance) {
      maxDistance = d;
      split = i;
    }
  }
  if (maxDistance <= tolerance) return [a, b];
  const left = simplifyRdp(points.slice(0, split + 1), tolerance);
  const right = simplifyRdp(points.slice(split), tolerance);
  return left.slice(0, -1).concat(right);
}

function pointDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function removeSequentialDuplicates(points, minimumDistance) {
  const result = [];
  for (const point of points) {
    if (result.length === 0 || pointDistance(point, result[result.length - 1]) >= minimumDistance) {
      result.push([point[0], point[1]]);
    }
  }
  return result;
}

export function smoothClosedPolygon(points, passes = 2, maxPoints = 240) {
  let polygon = points.map((point) => [point[0], point[1]]);
  if (polygon.length < 3) return polygon;
  for (let pass = 0; pass < passes; pass += 1) {
    const smoothed = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      smoothed.push([
        0.75 * a[0] + 0.25 * b[0],
        0.75 * a[1] + 0.25 * b[1],
      ]);
      smoothed.push([
        0.25 * a[0] + 0.75 * b[0],
        0.25 * a[1] + 0.75 * b[1],
      ]);
    }
    polygon = smoothed;
  }
  if (polygon.length > maxPoints) {
    const sampled = [];
    const stride = polygon.length / maxPoints;
    for (let i = 0; i < maxPoints; i += 1) sampled.push(polygon[Math.floor(i * stride)]);
    polygon = sampled;
  }
  return polygon;
}

export function prepareDrawnPolygon(points, {
  closeDistance = 0.10,
  minimumSpacing = 0.010,
  smoothingPasses = 2,
  maxPoints = 240,
} = {}) {
  let cleaned = removeSequentialDuplicates(points, Math.max(1e-5, 0.45 * minimumSpacing));
  if (cleaned.length < 3) return { polygon: cleaned, autoClosed: false, endpointDistance: Infinity };
  const endpointDistance = pointDistance(cleaned[0], cleaned[cleaned.length - 1]);
  const autoClosed = endpointDistance <= closeDistance;
  if (autoClosed) {
    while (cleaned.length > 3 && pointDistance(cleaned[0], cleaned[cleaned.length - 1]) <= closeDistance) {
      cleaned.pop();
    }
  }
  cleaned = removeSequentialDuplicates(cleaned, minimumSpacing);
  let polygon = smoothClosedPolygon(cleaned, autoClosed ? smoothingPasses : Math.min(1, smoothingPasses), maxPoints);
  if (!isSimplePolygon(polygon)) polygon = cleaned;
  return { polygon: ensureCounterClockwise(polygon), autoClosed, endpointDistance };
}

export function smoothClosedStroke(points, options = {}) {
  const prepared = prepareDrawnPolygon(points, options);
  if (prepared.polygon.length < 3) throw new Error('The drawn outline has too few distinct points.');
  if (!isSimplePolygon(prepared.polygon)) throw new Error('The drawn outline crosses itself.');
  if (Math.abs(polygonArea(prepared.polygon)) < 1e-5) throw new Error('The drawn outline has negligible area.');
  return prepared.polygon;
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  const eps = 1e-12;
  if (Math.abs(o1) < eps && distancePointSegment(c, a, b) < eps) return true;
  if (Math.abs(o2) < eps && distancePointSegment(d, a, b) < eps) return true;
  if (Math.abs(o3) < eps && distancePointSegment(a, c, d) < eps) return true;
  if (Math.abs(o4) < eps && distancePointSegment(b, c, d) < eps) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

export function isSimplePolygon(points) {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-8) return false;
    for (let j = i + 1; j < n; j += 1) {
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

export const PRESETS = {
  circle: {
    label: 'Unit-area circle',
    make: () => Array.from({ length: 64 }, (_, i) => {
      const angle = TAU * i / 64;
      return [Math.cos(angle), Math.sin(angle)];
    }),
  },
  square: {
    label: 'Unit-area square',
    make: () => [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  },
  triangle: {
    label: 'Unit-area equilateral triangle',
    make: () => [[0, 1], [-Math.sqrt(3) / 2, -0.5], [Math.sqrt(3) / 2, -0.5]],
  },
  star: {
    label: 'Unit-area five-point star',
    make: () => Array.from({ length: 10 }, (_, i) => {
      const radius = i % 2 === 0 ? 1 : 0.43;
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    }),
  },
  flower: {
    label: 'Unit-area five-lobed flower',
    make: () => Array.from({ length: 90 }, (_, i) => {
      const angle = TAU * i / 90;
      const radius = 1 + 0.23 * Math.cos(5 * angle);
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    }),
  },
  lshape: {
    label: 'Unit-area L-shaped domain',
    make: () => [[-1, -1], [1, -1], [1, 0], [0, 0], [0, 1], [-1, 1]],
  },
};

export function presetPolygon(id) {
  const preset = PRESETS[id] ?? PRESETS.circle;
  return normalizeUnitArea(preset.make());
}
