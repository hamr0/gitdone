// Render a workflow's dependency graph as plain-English prose.
// Input: validated steps array from validateWorkflowEvent, each with
//   { id, name, depends_on: [stepId, ...] }
// Output: a single string like
//   "Step 1 and Step 2, then Step 3."
// "Step 1, then Steps 2 and 3 (parallel)."
// "All steps run in parallel." / "Step 1 runs alone."
//
// Approach: compute the topological level of each step (length of the
// longest dependency chain reaching it), group by level, and join.
// Levels are 1-based in output to match the form's step numbering.

'use strict';

function levelsByStep(steps) {
  // Map step id -> 0-based index for dep lookup
  const idToIndex = new Map();
  steps.forEach((s, i) => idToIndex.set(s.id, i));
  const level = new Array(steps.length).fill(-1);

  function compute(i) {
    if (level[i] >= 0) return level[i];
    const deps = steps[i].depends_on || [];
    if (deps.length === 0) { level[i] = 0; return 0; }
    let maxDep = -1;
    for (const depId of deps) {
      const j = idToIndex.get(depId);
      if (j == null) continue; // unresolved dep — treat as root
      maxDep = Math.max(maxDep, compute(j));
    }
    level[i] = maxDep + 1;
    return level[i];
  }
  for (let i = 0; i < steps.length; i++) compute(i);
  return level;
}

function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function groupLabel(indices) {
  // indices are 0-based; output is 1-based
  const labels = indices.map((i) => `Step ${i + 1}`);
  if (indices.length === 1) return labels[0];
  // "Steps 1, 2, and 3" — plural
  const nums = indices.map((i) => String(i + 1));
  return `Steps ${joinList(nums)}`;
}

function renderFlowProse(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  if (steps.length === 1) return 'Step 1 runs alone.';

  const level = levelsByStep(steps);
  const maxLevel = Math.max(...level);

  // All at level 0 → fully parallel
  if (maxLevel === 0) {
    return `All ${steps.length} steps run in parallel (any order).`;
  }

  // Group indices by level
  const groups = [];
  for (let l = 0; l <= maxLevel; l++) {
    const idxs = [];
    for (let i = 0; i < level.length; i++) if (level[i] === l) idxs.push(i);
    if (idxs.length) groups.push({ level: l, indices: idxs });
  }

  const phrases = groups.map((g) => groupLabel(g.indices));
  return phrases.join(', then ') + '.';
}

module.exports = { renderFlowProse, levelsByStep };
