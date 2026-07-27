'use strict';

/**
 * Shadow-only final-size failure scorer.
 *
 * This never changes Tdarr behaviour. It scores the selected CQ/source features against
 * an exported sklearn HistGradientBoostingClassifier and logs/appends would-skip
 * decisions so we can compare them to actual live-size outcomes later.
 */

var fs = require('fs');
var path = require('path');

var MODEL_PATH = '/custom-cont-init.d/vmaf-plugin-patches/_lib/size_failure_shadow_hgb.json';
var MODEL_PATHS = [
  process.env.VMAF_SIZE_FAILURE_SHADOW_MODEL,
  MODEL_PATH,
  path.join(__dirname, 'size_failure_shadow_hgb.json')
].filter(Boolean);
var DEFAULT_LOG_PATH = '/app/configs/vmaf_size_shadow.jsonl';
var _model = null;
var _modelHash = null;

function _loadModel() {
  if (_model) return _model;
  var selectedPath = MODEL_PATHS.find(function (candidate) {
    return fs.existsSync(candidate);
  });
  if (!selectedPath) {
    throw new Error('VMAF size-failure shadow model is missing from every supported path');
  }
  var raw = fs.readFileSync(selectedPath, 'utf8');
  _model = JSON.parse(raw);
  _modelHash = require('crypto').createHash('sha256').update(raw, 'utf8').digest('hex');
  return _model;
}

function _num(v) {
  if (v === undefined || v === null || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function _cat(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.join(', ');
  var s = String(v);
  return s.length ? s : null;
}

function _transform(features, model) {
  var x = [];
  for (var i = 0; i < model.num_cols.length; i++) {
    var col = model.num_cols[i];
    var v = _num(features[col]);
    if (v === null) v = Number(model.num_impute_median[i]);
    var mean = Number(model.num_mean[i]);
    var scale = Number(model.num_scale[i]) || 1.0;
    x.push((v - mean) / scale);
  }
  for (var ci = 0; ci < model.cat_cols.length; ci++) {
    var c = model.cat_cols[ci];
    var cv = _cat(features[c]);
    if (cv === null) cv = _cat(model.cat_impute_mode[ci]);
    var cats = model.cat_categories[ci] || [];
    for (var j = 0; j < cats.length; j++) {
      x.push(String(cv) === String(cats[j]) ? 1.0 : 0.0);
    }
  }
  return x;
}

function _treeValue(nodes, x) {
  var idx = 0;
  for (var guard = 0; guard < 10000; guard++) {
    var n = nodes[idx];
    if (!n) return 0.0;
    if (n.is_leaf) return Number(n.value) || 0.0;
    var v = x[n.feature_idx];
    if (v === undefined || v === null || !isFinite(Number(v))) {
      idx = n.missing_go_to_left ? n.left : n.right;
    } else {
      idx = Number(v) <= Number(n.num_threshold) ? n.left : n.right;
    }
  }
  return 0.0;
}

function predictProbability(features) {
  var model = _loadModel();
  var x = _transform(features || {}, model);
  var raw = Number(model.baseline_prediction) || 0.0;
  for (var i = 0; i < model.trees.length; i++) {
    raw += _treeValue(model.trees[i], x);
  }
  var p = 1 / (1 + Math.exp(-raw));
  return {
    probability: p,
    raw_score: raw,
    model_schema: model.schema,
    model_hash_sha256: _modelHash,
    model_trained_at: model.trained_at || null,
    model_rows: model.rows,
    model_positive_rate: model.positive_rate,
    threshold_candidate: model.thresholds.would_skip_candidate,
    threshold_conservative: model.thresholds.would_skip_conservative,
    would_skip_candidate: p >= model.thresholds.would_skip_candidate,
    would_skip_conservative: p >= model.thresholds.would_skip_conservative
  };
}

function labelOutcome(outcome) {
  outcome = outcome || {};
  var status = String(outcome.size_target_status || '').toLowerCase();
  var skipReason = String(outcome.skip_reason || '').toLowerCase();
  var finalRatio = _num(outcome.final_output_ratio_pct);
  var positive = status === 'failed' || skipReason === 'live_size_guard_exceeded' ||
    (finalRatio !== null && finalRatio > 90);
  if (positive) return 1;
  var negative = status === 'met' || (finalRatio !== null && finalRatio <= 90);
  return negative ? 0 : null;
}

function appendShadowLog(record, logPath) {
  logPath = logPath || DEFAULT_LOG_PATH;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  MODEL_PATH: MODEL_PATH,
  MODEL_PATHS: MODEL_PATHS,
  DEFAULT_LOG_PATH: DEFAULT_LOG_PATH,
  predictProbability: predictProbability,
  labelOutcome: labelOutcome,
  appendShadowLog: appendShadowLog,
  _transform: _transform
};
