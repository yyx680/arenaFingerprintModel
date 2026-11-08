// Chronological holdout: identify revealed Battle models from prior observed prices only.
// Strict exact-price hard screen; no public quotes, token estimates or same-turn leakage.
// Usage: node tools/expr/arena-price-holdout-validation.mjs
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('arena-battle-price-training.json', 'utf8'));
if (data.schema !== 'arena-battle-price-training-v1' || !data.history_complete) {
  throw new Error('Complete Battle training set required');
}
const components = ['input', 'output', 'cache_read', 'cache_write'];
const turns = data.battles.flatMap(b => b.turns.map(t => ({
  session_id: b.session_id, prompt_message_id: t.prompt_message_id,
  created_at: t.created_at,
  candidates: t.candidates,
}))).filter(t => t.candidates.length).sort((a, b) =>
  Date.parse(a.created_at) - Date.parse(b.created_at)
  || a.session_id.localeCompare(b.session_id)
  || a.prompt_message_id.localeCompare(b.prompt_message_id));

const profiles = new Map();
const details = [];
for (const turn of turns) {
  // Predict BOTH anonymous positions before using either one's revealed label to train.
  for (const sample of turn.candidates) {
    const evidence = sample.price_evidence;
    const rates = Object.fromEntries(components.map(k =>
      [k, evidence?.components?.[k]?.effective_usd_per_mtok ?? null]));
    const observed = Object.fromEntries(components.filter(k =>
      Number.isFinite(rates[k]) && rates[k] > 0).map(k => [k, rates[k]]));
    const truePreviouslySeen = profiles.has(sample.model_name);
    const usable = evidence?.usage_source === 'provider'
      && evidence?.cost_source !== 'agent_p50'
      && Object.keys(observed).length >= 2;
    const candidates = [];
    if (usable) {
      for (const [model, profile] of profiles) {
        if (Object.entries(observed).every(([k, price]) =>
          profile[k].size === 1 && profile[k].has(price))) {
          candidates.push(model);
        }
      }
    }
    candidates.sort();
    let outcome = 'insufficient_positive_components';
    if (usable && !truePreviouslySeen) outcome = 'model_not_yet_seen';
    else if (usable && candidates.length === 0) outcome = 'no_strict_match';
    else if (usable && candidates.length === 1 && candidates[0] === sample.model_name) outcome = 'unique_correct';
    else if (usable && candidates.length === 1) outcome = 'unique_wrong';
    else if (usable && candidates.includes(sample.model_name)) outcome = 'ambiguous_contains_true';
    else if (usable) outcome = 'ambiguous_misses_true';
    details.push({
      session_id: turn.session_id, sample_hash: sample.sample_hash,
      true_model: sample.model_name,
      true_model_previously_seen: truePreviouslySeen,
      observed_positive_rates_usd_per_mtok: observed,
      strict_candidates: candidates,
      outcome,
    });
  }
  for (const sample of turn.candidates) {
    const evidence = sample.price_evidence;
    if (evidence?.usage_source !== 'provider' || evidence?.cost_source === 'agent_p50') continue;
    if (!profiles.has(sample.model_name)) {
      profiles.set(sample.model_name,
        Object.fromEntries(components.map(k => [k, new Set()])));
    }
    const profile = profiles.get(sample.model_name);
    for (const k of components) {
      const price = evidence.components?.[k]?.effective_usd_per_mtok;
      if (Number.isFinite(price) && price > 0) profile[k].add(price);
    }
  }
}
const counts = Object.fromEntries([...new Set(details.map(d => d.outcome))]
  .map(o => [o, details.filter(d => d.outcome === o).length]));
const repeatedUsable = details.filter(d => d.true_model_previously_seen
  && d.outcome !== 'insufficient_positive_components');
const collisionGroups = new Map();
for (const [model, profile] of profiles) {
  if (profile.input.size !== 1 || profile.output.size !== 1) continue;
  const key = [...profile.input][0] + '/' + [...profile.output][0];
  const names = collisionGroups.get(key) || [];
  names.push(model);
  collisionGroups.set(key, names);
}
const result = {
  schema: 'arena-price-holdout-validation-v1',
  generated_at: new Date().toISOString(),
  source: 'arena-battle-price-training.json; chronological per-turn holdout',
  training_set_generated_at: data.generated_at,
  methodology: [
    'Order turns by user-message timestamp; for each turn, predict both sides using only rates from PRIOR turns, then update profiles.',
    'Require at least two positive provider-usage / actual-cost component rates in the test; zero or missing is not a measured price.',
    'A candidate must have exactly one observed prior rate for EVERY positive test component and match it exactly after existing 9-decimal normalization.',
    'Never break ties using response text, model-name hints, public prices, or a relaxed price tolerance.',
    'No same-turn leakage; unseen models and previously unmeasured components may correctly produce no candidate.',
  ],
  total_messages: details.length,
  prior_model_names: profiles.size,
  repeated_usable_test_messages: repeatedUsable.length,
  outcomes: counts,
  repeated_usable_unique_correct: repeatedUsable.filter(d => d.outcome === 'unique_correct').length,
  repeated_usable_ambiguous_contains_true: repeatedUsable.filter(d => d.outcome === 'ambiguous_contains_true').length,
  repeated_usable_no_strict_match: repeatedUsable.filter(d => d.outcome === 'no_strict_match').length,
  repeated_usable_wrong_or_missing_true: repeatedUsable.filter(d =>
    d.outcome === 'unique_wrong' || d.outcome === 'ambiguous_misses_true').length,
  final_price_collision_groups: [...collisionGroups].filter(([, names]) => names.length > 1)
    .map(([input_output_usd_per_mtok, model_names]) => ({
      input_output_usd_per_mtok, model_names: model_names.sort(),
    })),
  details,
};
fs.writeFileSync('arena-price-holdout-validation.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output: 'arena-price-holdout-validation.json',
  total_messages: result.total_messages,
  repeated_usable: result.repeated_usable_test_messages,
  unique_correct: result.repeated_usable_unique_correct,
  ambiguous_contains_true: result.repeated_usable_ambiguous_contains_true,
  no_strict_match: result.repeated_usable_no_strict_match,
  wrong_or_missing_true: result.repeated_usable_wrong_or_missing_true,
  collision_groups: result.final_price_collision_groups.length }));
