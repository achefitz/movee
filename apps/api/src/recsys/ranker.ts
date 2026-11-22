import { FEATURE_NAMES, FEATURE_VERSION, N_FEATURES, featureIndex } from './features';
import { predictMargin, sigmoid, trainGBDT, type GBDTModel } from './gbdt';

export type LinearModel = { kind: 'linear'; mean: number[]; std: number[]; w: number[]; b: number };

export type EnsembleModel = {
  kind: 'ensemble';
  featureVersion: number;
  trainedAt: number;
  gbdt: GBDTModel;
  linear: LinearModel;
  /** Blend weight on the GBDT logit; (1 - w) goes to the linear logit. */
  wGbdt: number;
  metrics: TrainReport;
};

export type TrainingRow = { x: number[]; y: 0 | 1; ts: number; userId: string };

export type TrainReport = {
  nTrain: number;
  nVal: number;
  positiveRate: number;
  auc: { prior: number; linear: number; gbdt: number; ensemble: number };
  logloss: { gbdt: number; ensemble: number };
  wGbdt: number;
  gbdtTrees: number;
  adopted: boolean;
  topFeatures: Array<[string, number]>;
};

export const MIN_TRAINING_ROWS = 200;
const MIN_VAL_EACH_CLASS = 15;
const VAL_FRACTION = 0.2;
const ADOPT_MARGIN = 0.005; // must beat the hand-tuned prior by this much AUC

// ---------------------------------------------------------------- metrics

export function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, nPos = 0, i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // ties get the mean rank
    for (let k = i; k <= j; k++) if (labels[idx[k]] === 1) { rankSum += avgRank; nPos++; }
    i = j + 1;
  }
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function logloss(probs: number[], labels: number[]): number {
  let s = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.min(1 - 1e-7, Math.max(1e-7, probs[i]));
    s -= labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p);
  }
  return s / Math.max(1, probs.length);
}

// ---------------------------------------------------------------- linear model

export function trainLinear(X: number[][], y: number[], iters = 400, lr = 0.2, l2 = 1e-3): LinearModel {
  const nf = X[0]?.length ?? 0;
  const mean = new Array(nf).fill(0), std = new Array(nf).fill(0);
  for (const r of X) for (let f = 0; f < nf; f++) mean[f] += r[f] / X.length;
  for (const r of X) for (let f = 0; f < nf; f++) std[f] += (r[f] - mean[f]) ** 2 / X.length;
  for (let f = 0; f < nf; f++) std[f] = Math.sqrt(std[f]) || 1;
  const Z = X.map(r => r.map((v, f) => (v - mean[f]) / std[f]));
  const w = new Array(nf).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(nf).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      let z = b;
      for (let f = 0; f < nf; f++) z += w[f] * Z[i][f];
      const err = sigmoid(z) - y[i];
      gb += err;
      for (let f = 0; f < nf; f++) gw[f] += err * Z[i][f];
    }
    b -= (lr * gb) / Z.length;
    for (let f = 0; f < nf; f++) w[f] -= lr * (gw[f] / Z.length + l2 * w[f]);
  }
  return { kind: 'linear', mean, std, w, b };
}

export function linearMargin(m: LinearModel, x: number[]): number {
  let z = m.b;
  for (let f = 0; f < m.w.length; f++) z += m.w[f] * ((x[f] - m.mean[f]) / m.std[f]);
  return z;
}

// ---------------------------------------------------------------- hand-tuned prior

const I = (n: typeof FEATURE_NAMES[number]) => featureIndex(n);
const PRIOR_WEIGHTS: Array<[number, number]> = [
  [I('ui_genre_te_mean'), 3],
  [I('ui_genre_te_min'), 1],
  [I('ui_content_cos'), 2],
  [I('ui_mean_top3_sim_liked'), 1.5],
  [I('ui_max_sim_skipped'), -1.2],
  [I('ui_decade_te'), 1],
  [I('ui_type_te'), 1],
  [I('item_te_like_rate'), 1],
  [I('item_bayes_rating'), 0.35],
  [I('src_i2i_rr'), 1.2],
  [I('src_covisit_rr'), 1.2],
  [I('src_count'), 0.15],
  [I('ui_keyword_affinity'), 0.15],
  [I('ui_cast_affinity'), 0.2],
  [I('ui_popularity_gap'), -0.3],
];

/** Used until enough swipes exist to train (and whenever a trained model fails to beat it). */
export function priorMargin(x: number[]): number {
  let z = 0;
  for (const [i, w] of PRIOR_WEIGHTS) z += w * x[i];
  return z - 5;
}

// ---------------------------------------------------------------- ensemble

export type Ranker = EnsembleModel | null;

export function scoreRow(model: Ranker, x: number[]): number {
  if (!model || model.featureVersion !== FEATURE_VERSION) return sigmoid(priorMargin(x));
  return sigmoid(model.wGbdt * predictMargin(model.gbdt, x) + (1 - model.wGbdt) * linearMargin(model.linear, x));
}

/**
 * Time-based validation: train on older swipes, validate on the newest 20%
 * (mirrors how the model is used — predicting future swipes from past ones).
 * The blend weight and tree count are tuned on validation, then both models
 * are refit on all rows.
 */
export function trainRanker(rows: TrainingRow[], now = Date.now()): { model: EnsembleModel | null; report: TrainReport | null } {
  const usable = rows.filter(r => r.x.length === N_FEATURES).sort((a, b) => a.ts - b.ts);
  if (usable.length < MIN_TRAINING_ROWS) return { model: null, report: null };

  const cut = Math.floor(usable.length * (1 - VAL_FRACTION));
  const tr = usable.slice(0, cut), va = usable.slice(cut);
  const vaPos = va.filter(r => r.y === 1).length;
  if (vaPos < MIN_VAL_EACH_CLASS || va.length - vaPos < MIN_VAL_EACH_CLASS) return { model: null, report: null };

  const Xtr = tr.map(r => r.x), ytr = tr.map(r => r.y);
  const Xva = va.map(r => r.x), yva = va.map(r => r.y);

  const { model: g, bestIteration } = trainGBDT(Xtr, ytr, {}, { X: Xva, y: yva });
  const lin = trainLinear(Xtr, ytr);

  const zg = Xva.map(x => predictMargin(g, x));
  const zl = Xva.map(x => linearMargin(lin, x));
  let bestW = 1, bestAuc = -1;
  for (const w of [0, 0.25, 0.5, 0.6, 0.75, 0.9, 1]) {
    const a = auc(zg.map((z, i) => w * z + (1 - w) * zl[i]), yva);
    if (a > bestAuc + 1e-9) { bestAuc = a; bestW = w; }
  }
  const priorAuc = auc(Xva.map(priorMargin), yva);
  const ensProb = zg.map((z, i) => sigmoid(bestW * z + (1 - bestW) * zl[i]));
  const adopted = bestAuc > priorAuc + ADOPT_MARGIN;

  // Refit on everything with the tuned tree count.
  const Xall = usable.map(r => r.x), yall = usable.map(r => r.y);
  const full = trainGBDT(Xall, yall, { nTrees: bestIteration, earlyStoppingRounds: Infinity }).model;
  const fullLin = trainLinear(Xall, yall);

  const report: TrainReport = {
    nTrain: tr.length,
    nVal: va.length,
    positiveRate: yall.reduce<number>((a, b) => a + b, 0) / yall.length,
    auc: {
      prior: priorAuc,
      linear: auc(zl, yva),
      gbdt: auc(zg, yva),
      ensemble: bestAuc,
    },
    logloss: { gbdt: logloss(zg.map(sigmoid), yva), ensemble: logloss(ensProb, yva) },
    wGbdt: bestW,
    gbdtTrees: bestIteration,
    adopted,
    topFeatures: full.gain
      .map((v, i) => [FEATURE_NAMES[i], v] as [string, number])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
  };

  return {
    model: adopted
      ? { kind: 'ensemble', featureVersion: FEATURE_VERSION, trainedAt: now, gbdt: full, linear: fullLin, wGbdt: bestW, metrics: report }
      : null,
    report,
  };
}
