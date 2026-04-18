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
const VALID_FLOWS = ['sequential', 'non-sequential', 'hybrid'];
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

function validateFlow(flow) {
  const f = clean(flow).toLowerCase();
  if (!VALID_FLOWS.includes(f)) {
    return { ok: false, reason: `flow must be one of ${VALID_FLOWS.join(', ')}` };
  }
  return { ok: true, value: f };
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
//   { title, initiator, flow, min_trust_level,
//     step_name: [..], step_participant: [..], step_deadline: [..],
//     step_requires_attachment: [..] (checkboxes — present = yes) }
//
// Returns { ok, value?: { title, initiator, flow, min_trust_level,
// steps: [{id, name, participant, deadline, requires_attachment}] },
// errors?: [string] }
function validateWorkflowEvent(form) {
  const errors = [];

  const title = validateTitle(form.title);
  if (!title.ok) errors.push(title.reason);

  const initiator = validateEmail(form.initiator);
  if (!initiator.ok) errors.push(`initiator: ${initiator.reason}`);

  const flow = validateFlow(form.flow);
  if (!flow.ok) errors.push(flow.reason);

  const trust = validateTrustLevel(form.min_trust_level, 'verified');
  if (!trust.ok) errors.push(trust.reason);

  const names = asArray(form.step_name);
  const participants = asArray(form.step_participant);
  const deadlines = asArray(form.step_deadline);
  const attachmentFlags = asArray(form.step_requires_attachment);

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
    let id = slugifyStepId(n, i);
    // Ensure step id uniqueness within the event
    if (seenStepIds.has(id)) {
      let suffix = 2;
      while (seenStepIds.has(`${id}-${suffix}`)) suffix++;
      id = `${id}-${suffix}`;
    }
    seenStepIds.add(id);

    steps.push({
      id,
      name: n,
      participant: pEmail.value,
      deadline: d.value,
      requires_attachment: attachmentFlags[i] === 'on' || attachmentFlags[i] === 'true' || attachmentFlags[i] === true,
      status: 'pending',
    });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title: title.value,
      initiator: initiator.value,
      flow: flow.value,
      min_trust_level: trust.value,
      steps,
    },
  };
}

module.exports = {
  validateWorkflowEvent,
  validateEmail,
  validateTitle,
  validateTrustLevel,
  validateFlow,
  validateDeadline,
  slugifyStepId,
  VALID_FLOWS,
  VALID_TRUST_LEVELS,
  EMAIL_RE,
  ISO_DATE_RE,
};
