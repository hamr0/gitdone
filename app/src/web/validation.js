// Input validation for the event-creation forms.
//
// Every user-supplied string is untrusted. We validate structure
// (types, lengths, patterns) here; authorization/auth decisions
// happen elsewhere (magic-link / DKIM).
//
// Principle §0.1.4 ("invisible beats correct"): errors should
// point at what to fix in one line, not produce a field-by-field
// wall. We collect multiple errors but each is a short string.

'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const MAX_TITLE = 200;
const MAX_STEPS = 50;
const MAX_STEP_NAME = 200;
const MAX_STEP_DETAILS = 4096; // ~600 words; forces brevity, fits in a notification email body without deliverability grief
const VALID_TRUST_LEVELS = ['unverified', 'authorized', 'forwarded', 'verified'];

function clean(s) {
  if (s == null) return '';
  return String(s).trim();
}

// Coerce form input to a consistent array shape.
// urlencoded: repeated fields become arrays; single fields become strings.
function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function validateEmail(email) {
  const e = clean(email).toLowerCase();
  if (!e) return { ok: false, reason: 'email is required' };
  if (e.length > 254) return { ok: false, reason: 'email too long (max 254 chars)' };
  if (!EMAIL_RE.test(e)) return { ok: false, reason: 'email format invalid' };
  return { ok: true, value: e };
}

function validateTitle(title) {
  const t = clean(title);
  if (!t) return { ok: false, reason: 'title is required' };
  if (t.length > MAX_TITLE) return { ok: false, reason: `title too long (max ${MAX_TITLE})` };
  return { ok: true, value: t };
}

function validateTrustLevel(level, defaultLevel) {
  const l = clean(level) || defaultLevel;
  if (!VALID_TRUST_LEVELS.includes(l)) {
    return { ok: false, reason: `min_trust_level must be one of ${VALID_TRUST_LEVELS.join(', ')}` };
  }
  return { ok: true, value: l };
}

// Parse a "depends on" input into a list of step indices (0-based).
// Accepted tokens: 1-based step numbers ("1", "2", "3"), comma-separated.
// Empty input → []. Non-numeric or out-of-range tokens collected as errors.
// The caller decides the total step count so "out of range" is accurate.
function parseDependsOn(raw, totalSteps, myIndex) {
  const s = clean(raw);
  if (!s) return { ok: true, value: [] };
  const tokens = s.split(',').map((t) => t.trim()).filter(Boolean);
  const indices = [];
  const errs = [];
  const seen = new Set();
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) {
      errs.push(`"${t}" is not a step number`);
      continue;
    }
    const n = parseInt(t, 10);
    if (n < 1 || n > totalSteps) {
      errs.push(`step ${n} is out of range (1..${totalSteps})`);
      continue;
    }
    const idx = n - 1;
    if (idx === myIndex) {
      errs.push(`a step cannot depend on itself`);
      continue;
    }
    if (seen.has(idx)) continue;     // silently dedupe
    seen.add(idx);
    indices.push(idx);
  }
  if (errs.length) return { ok: false, reason: errs.join('; ') };
  return { ok: true, value: indices };
}

// DFS-detect cycles in a dependency graph. Steps is an array; each step has
// `depends_on_indices: [number]` (0-based). Returns null on success, or
// an error message with the offending chain.
function detectDependencyCycles(steps) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = steps.map(() => WHITE);
  const stack = [];
  function dfs(i) {
    color[i] = GREY;
    stack.push(i);
    for (const dep of steps[i].depends_on_indices || []) {
      if (color[dep] === GREY) {
        const chain = stack.slice(stack.indexOf(dep)).map((x) => x + 1).concat(dep + 1).join(' → ');
        return `cycle detected: ${chain}`;
      }
      if (color[dep] === WHITE) {
        const r = dfs(dep);
        if (r) return r;
      }
    }
    color[i] = BLACK;
    stack.pop();
    return null;
  }
  for (let i = 0; i < steps.length; i++) {
    if (color[i] === WHITE) {
      const r = dfs(i);
      if (r) return r;
    }
  }
  return null;
}

// Deadline: optional. Accept YYYY-MM-DD or full ISO-8601. Reject anything
// that can't be parsed cleanly, or dates before today.
function validateDeadline(raw) {
  const d = clean(raw);
  if (!d) return { ok: true, value: null };
  if (!ISO_DATE_RE.test(d)) {
    return { ok: false, reason: `deadline must be YYYY-MM-DD or ISO 8601 (got: ${d})` };
  }
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) {
    return { ok: false, reason: `deadline unparseable: ${d}` };
  }
  // Normalise to ISO string (with Z) for consistent storage
  return { ok: true, value: parsed.toISOString() };
}

function slugifyStepId(name, index) {
  const slug = clean(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `step-${index + 1}`;
}

// Full workflow event validator. Accepts parsed form body shape:
//   { title, initiator, min_trust_level,
//     step_name: [..], step_participant: [..], step_deadline: [..],
//     step_requires_attachment: [..] (checkboxes — present = yes),
//     step_depends_on: [..] (comma-separated 1-based step numbers per row) }
//
// `flow` was removed in 1.H.2b — a step's position in the dependency
// graph replaces it. Empty depends_on = runs immediately (was
// "non-sequential"); chain-each-to-previous = "sequential"; mixed = DAG.
//
// Returns { ok, value?: { title, initiator, min_trust_level,
// steps: [{id, name, participant, deadline, requires_attachment,
//          depends_on: [stepId]}] },
// errors?: [string] }
function validateWorkflowEvent(form) {
  const errors = [];

  const title = validateTitle(form.title);
  if (!title.ok) errors.push(title.reason);

  const initiator = validateEmail(form.initiator);
  if (!initiator.ok) errors.push(`initiator: ${initiator.reason}`);

  const trust = validateTrustLevel(form.min_trust_level, 'verified');
  if (!trust.ok) errors.push(trust.reason);

  const names = asArray(form.step_name);
  const participants = asArray(form.step_participant);
  const deadlines = asArray(form.step_deadline);
  const attachmentFlags = asArray(form.step_requires_attachment);
  const dependsOnRaw = asArray(form.step_depends_on);
  const detailsRaw = asArray(form.step_details);

  if (names.length === 0) {
    errors.push('at least one step is required');
  }
  if (names.length > MAX_STEPS) {
    errors.push(`too many steps (max ${MAX_STEPS})`);
  }

  const seenStepIds = new Set();
  const steps = [];
  for (let i = 0; i < names.length; i++) {
    const n = clean(names[i]);
    if (!n) {
      errors.push(`step ${i + 1}: name required`);
      continue;
    }
    if (n.length > MAX_STEP_NAME) {
      errors.push(`step ${i + 1}: name too long (max ${MAX_STEP_NAME})`);
      continue;
    }
    const pEmail = validateEmail(participants[i]);
    if (!pEmail.ok) {
      errors.push(`step ${i + 1} participant: ${pEmail.reason}`);
      continue;
    }
    const d = validateDeadline(deadlines[i]);
    if (!d.ok) {
      errors.push(`step ${i + 1} deadline: ${d.reason}`);
      continue;
    }
    const deps = parseDependsOn(dependsOnRaw[i], names.length, i);
    if (!deps.ok) {
      errors.push(`step ${i + 1} depends on: ${deps.reason}`);
      continue;
    }
    let id = slugifyStepId(n, i);
    if (seenStepIds.has(id)) {
      let suffix = 2;
      while (seenStepIds.has(`${id}-${suffix}`)) suffix++;
      id = `${id}-${suffix}`;
    }
    seenStepIds.add(id);

    const rawDetails = clean(detailsRaw[i] || '');
    if (rawDetails.length > MAX_STEP_DETAILS) {
      errors.push(`step ${i + 1} details: too long (max ${MAX_STEP_DETAILS} chars, got ${rawDetails.length}). Consider attaching a document and referencing it instead.`);
      continue;
    }

    steps.push({
      id,
      name: n,
      participant: pEmail.value,
      deadline: d.value,
      details: rawDetails || null,
      requires_attachment: attachmentFlags[i] === 'on' || attachmentFlags[i] === 'true' || attachmentFlags[i] === true,
      status: 'pending',
      // carried through the cycle-check as 0-based indices, then resolved
      // to step ids once every step's id is assigned.
      depends_on_indices: deps.value,
    });
  }

  // Resolve indices → step ids, then cycle-check.
  for (const s of steps) {
    s.depends_on = (s.depends_on_indices || []).map((idx) => steps[idx] && steps[idx].id).filter(Boolean);
  }
  if (steps.length && !errors.length) {
    const cycleErr = detectDependencyCycles(steps);
    if (cycleErr) errors.push(cycleErr);
  }

  // Deadline-vs-dependency ordering: if a dependent step has a deadline,
  // it must be >= every dependency's deadline. Impossible otherwise.
  if (steps.length && !errors.length) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.deadline) continue;
      for (const depIdx of s.depends_on_indices || []) {
        const dep = steps[depIdx];
        if (!dep || !dep.deadline) continue;
        if (new Date(s.deadline).getTime() < new Date(dep.deadline).getTime()) {
          errors.push(
            `step ${i + 1} deadline (${s.deadline.slice(0, 10)}) is before step ${depIdx + 1}'s deadline (${dep.deadline.slice(0, 10)}); step ${i + 1} depends on step ${depIdx + 1}`
          );
        }
      }
    }
  }

  for (const s of steps) delete s.depends_on_indices;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title: title.value,
      initiator: initiator.value,
      min_trust_level: trust.value,
      steps,
    },
  };
}

const VALID_CRYPTO_MODES = ['declaration', 'attestation'];
const VALID_DEDUP_RULES = ['unique', 'latest', 'accumulating'];
const MAX_THRESHOLD = 10000;

// Crypto event validator — PRD §4.2. Branches on mode:
//   declaration: { title, initiator, signer }
//   attestation: { title, initiator, threshold, dedup, allow_anonymous }
// Returns { ok, value?, errors? } in the same shape as validateWorkflowEvent.
function validateCryptoEvent(form) {
  const errors = [];

  const mode = clean(form.mode).toLowerCase();
  if (!VALID_CRYPTO_MODES.includes(mode)) {
    errors.push(`mode must be one of ${VALID_CRYPTO_MODES.join(', ')}`);
    return { ok: false, errors };
  }

  const title = validateTitle(form.title);
  if (!title.ok) errors.push(title.reason);

  const initiator = validateEmail(form.initiator);
  if (!initiator.ok) errors.push(`initiator: ${initiator.reason}`);

  const trust = validateTrustLevel(form.min_trust_level, 'verified');
  if (!trust.ok) errors.push(trust.reason);

  if (mode === 'declaration') {
    const signer = validateEmail(form.signer);
    if (!signer.ok) errors.push(`signer: ${signer.reason}`);
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: {
        type: 'crypto',
        mode: 'declaration',
        title: title.value,
        initiator: initiator.value,
        min_trust_level: trust.value,
        signer: signer.value,
      },
    };
  }

  // attestation
  const tRaw = clean(form.threshold);
  const threshold = parseInt(tRaw, 10);
  if (!tRaw || !Number.isFinite(threshold) || threshold < 1) {
    errors.push('threshold must be an integer >= 1');
  } else if (threshold > MAX_THRESHOLD) {
    errors.push(`threshold too large (max ${MAX_THRESHOLD})`);
  }

  const dedup = clean(form.dedup).toLowerCase() || 'unique';
  if (!VALID_DEDUP_RULES.includes(dedup)) {
    errors.push(`dedup must be one of ${VALID_DEDUP_RULES.join(', ')}`);
  }
  const allowAnonymous = form.allow_anonymous === 'on'
    || form.allow_anonymous === 'true'
    || form.allow_anonymous === true;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: 'crypto',
      mode: 'attestation',
      title: title.value,
      initiator: initiator.value,
      min_trust_level: trust.value,
      threshold,
      dedup,
      allow_anonymous: allowAnonymous,
      replies: [],
    },
  };
}

module.exports = {
  validateWorkflowEvent,
  validateCryptoEvent,
  VALID_CRYPTO_MODES,
  VALID_DEDUP_RULES,
  validateEmail,
  validateTitle,
  validateTrustLevel,
  validateDeadline,
  parseDependsOn,
  detectDependencyCycles,
  slugifyStepId,
  VALID_TRUST_LEVELS,
  EMAIL_RE,
  ISO_DATE_RE,
};
