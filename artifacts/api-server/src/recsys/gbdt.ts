/**
 * Minimal histogram-based gradient-boosted trees for binary log-loss
 * (the same algorithm family as XGBoost / LightGBM, second-order splits,
 * L2-regularised leaves, row + column subsampling, early stopping).
 * Dependency-free so it bundles cleanly with esbuild.
 */

export type GBDTParams = {
  nTrees: number;
  maxDepth: number;
  learningRate: number;
  minChildWeight: number; // min hessian sum per leaf
  minLeafRows: number;
  lambda: number;         // L2 on leaf values
  subsample: number;
  colsample: number;
  nBins: number;
  earlyStoppingRounds: number;
  seed: number;
};

export const DEFAULT_GBDT_PARAMS: GBDTParams = {
  nTrees: 300,
  maxDepth: 4,
  learningRate: 0.08,
  minChildWeight: 2,
  minLeafRows: 10,
  lambda: 2,
  subsample: 0.8,
  colsample: 0.8,
  nBins: 32,
  earlyStoppingRounds: 30,
  seed: 42,
};

/** Flat node arrays; feature === -1 marks a leaf whose value is in `value`. */
export type Tree = { feature: number[]; threshold: number[]; left: number[]; right: number[]; value: number[] };

export type GBDTModel = { kind: 'gbdt'; base: number; trees: Tree[]; nFeatures: number; gain: number[] };

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileEdges(values: number[], nBins: number): number[] {
  const sorted = Float64Array.from(values).sort();
  const uniq: number[] = [];
  for (const v of sorted) if (uniq.length === 0 || uniq[uniq.length - 1] !== v) uniq.push(v);
  if (uniq.length <= 1) return [];
  if (uniq.length <= nBins) {
    return uniq.slice(0, -1).map((v, i) => (v + uniq[i + 1]) / 2);
  }
  const edges: number[] = [];
  for (let b = 1; b < nBins; b++) {
    const v = sorted[Math.floor((b * sorted.length) / nBins)];
    if (edges.length === 0 || v > edges[edges.length - 1]) edges.push(v);
  }
  return edges;
}

/** Bin index = number of edges strictly below x, so "bin <= k" ⇔ "x <= edges[k]". */
function binOf(edges: number[], x: number): number {
  let lo = 0, hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function predictTree(t: Tree, x: number[]): number {
  let n = 0;
  while (t.feature[n] !== -1) n = x[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n];
  return t.value[n];
}

export function predictMargin(m: GBDTModel, x: number[], nTrees = m.trees.length): number {
  let z = m.base;
  for (let i = 0; i < nTrees; i++) z += predictTree(m.trees[i], x);
  return z;
}

export type TrainResult = { model: GBDTModel; bestIteration: number; valLoss: number[] };

export function trainGBDT(
  X: number[][],
  y: number[],
  params: Partial<GBDTParams> = {},
  val?: { X: number[][]; y: number[] },
): TrainResult {
  const p = { ...DEFAULT_GBDT_PARAMS, ...params };
  const n = X.length;
  const nf = X[0]?.length ?? 0;
  const rng = mulberry32(p.seed);

  const edges: number[][] = [];
  const bins: Uint8Array[] = [];
  for (let f = 0; f < nf; f++) {
    const col = X.map(r => r[f]);
    const e = quantileEdges(col, p.nBins);
    edges.push(e);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = binOf(e, col[i]);
    bins.push(b);
  }

  const pos = y.reduce((a, b) => a + b, 0);
  const prior = Math.min(0.99, Math.max(0.01, pos / Math.max(1, n)));
  const base = Math.log(prior / (1 - prior));
  const margin = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  const model: GBDTModel = { kind: 'gbdt', base, trees: [], nFeatures: nf, gain: new Array(nf).fill(0) };

  const valMargin = val ? new Float64Array(val.y.length).fill(base) : null;
  const valLoss: number[] = [];
  let best = Infinity, bestIter = 0;

  for (let t = 0; t < p.nTrees; t++) {
    for (let i = 0; i < n; i++) {
      const pr = sigmoid(margin[i]);
      g[i] = pr - y[i];
      h[i] = Math.max(pr * (1 - pr), 1e-6);
    }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (rng() < p.subsample) rows.push(i);
    const feats: number[] = [];
    for (let f = 0; f < nf; f++) if (edges[f].length > 0 && rng() < p.colsample) feats.push(f);

    const tree: Tree = { feature: [], threshold: [], left: [], right: [], value: [] };
    const build = (idx: number[], depth: number): number => {
      const node = tree.feature.length;
      tree.feature.push(-1); tree.threshold.push(0); tree.left.push(-1); tree.right.push(-1); tree.value.push(0);
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      tree.value[node] = (-G / (H + p.lambda)) * p.learningRate;
      if (depth >= p.maxDepth || idx.length < 2 * p.minLeafRows) return node;

      const parentScore = (G * G) / (H + p.lambda);
      let bestGain = 1e-6, bestF = -1, bestBin = -1;
      for (const f of feats) {
        const nb = edges[f].length + 1;
        const hg = new Float64Array(nb), hh = new Float64Array(nb), hc = new Int32Array(nb);
        const bf = bins[f];
        for (const i of idx) { const b = bf[i]; hg[b] += g[i]; hh[b] += h[i]; hc[b]++; }
        let gl = 0, hl = 0, cl = 0;
        for (let b = 0; b < nb - 1; b++) {
          gl += hg[b]; hl += hh[b]; cl += hc[b];
          const gr = G - gl, hr = H - hl, cr = idx.length - cl;
          if (cl < p.minLeafRows || cr < p.minLeafRows) continue;
          if (hl < p.minChildWeight || hr < p.minChildWeight) continue;
          const gain = (gl * gl) / (hl + p.lambda) + (gr * gr) / (hr + p.lambda) - parentScore;
          if (gain > bestGain) { bestGain = gain; bestF = f; bestBin = b; }
        }
      }
      if (bestF < 0) return node;

      const L: number[] = [], R: number[] = [];
      for (const i of idx) (bins[bestF][i] <= bestBin ? L : R).push(i);
      tree.feature[node] = bestF;
      tree.threshold[node] = edges[bestF][bestBin];
      model.gain[bestF] += bestGain;
      tree.left[node] = build(L, depth + 1);
      tree.right[node] = build(R, depth + 1);
      return node;
    };
    build(rows, 0);
    model.trees.push(tree);
    for (let i = 0; i < n; i++) margin[i] += predictTree(tree, X[i]);

    if (val && valMargin) {
      let loss = 0;
      for (let i = 0; i < val.y.length; i++) {
        valMargin[i] += predictTree(tree, val.X[i]);
        loss += logloss1(val.y[i], sigmoid(valMargin[i]));
      }
      loss /= Math.max(1, val.y.length);
      valLoss.push(loss);
      if (loss < best - 1e-5) { best = loss; bestIter = t + 1; }
      else if (t + 1 - bestIter >= p.earlyStoppingRounds) break;
    } else {
      bestIter = t + 1;
    }
  }
  model.trees = model.trees.slice(0, Math.max(1, bestIter));
  return { model, bestIteration: Math.max(1, bestIter), valLoss };
}

function logloss1(y: number, p: number): number {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}
