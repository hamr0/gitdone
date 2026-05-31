// 12-factor config: all knobs come from env vars, with sensible defaults
// suitable for production. Tests override by setting env before require.

'use strict';

function bool(v, def) {
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function list(v, def) {
  if (v == null) return def;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  mtaHostname: process.env.GITDONE_MTA_HOSTNAME || 'mail.git-done.com',
  domain: process.env.GITDONE_DOMAIN || 'git-done.com',
  dataDir: process.env.GITDONE_DATA_DIR || '/var/lib/gitdone',
  logFile: process.env.GITDONE_LOG_FILE || '/var/log/gitdone/receive.log',
  logToStdout: bool(process.env.GITDONE_LOG_STDOUT, true),
  maxHeaderBytes: num(process.env.GITDONE_MAX_HEADER_BYTES, 64 * 1024),
  otsBin: process.env.GITDONE_OTS_BIN || '/usr/local/bin/ots',
  // Lifecycle sweep thresholds (hourly cron in app/bin/sweep.js).
  // activationTtlHours: delete never-clicked events after this many hours
  //   so they disappear cleanly instead of piling up as zombie records.
  // overdueNudgeDays:   days past the "reference clock" (max deadline of
  //   pending steps, or event.activated_at if no deadlines set) before
  //   a one-shot nudge is emailed to the organiser.
  // archiveDays:        days past the reference clock before an incomplete
  //   event is auto-archived (hidden from default dashboards, stops
  //   counting replies). Never auto-complete — archive is reversible,
  //   complete is a commit we can't take back.
  activationTtlHours: num(process.env.GITDONE_ACTIVATION_TTL_HOURS, 72),
  overdueNudgeDays: num(process.env.GITDONE_OVERDUE_NUDGE_DAYS, 14),
  archiveDays: num(process.env.GITDONE_ARCHIVE_DAYS, 45),
  // Reverse proxies whose peer address means "trust X-Forwarded-For for the
  // real client IP" (knowless `determineSourceIp`, used for per-IP login
  // rate-limiting). gitdone sits behind a single nginx on the same host, so
  // the default is loopback. SECURITY PRECONDITION: the trusted proxy MUST
  // *overwrite* X-Forwarded-For with $remote_addr (never append
  // $proxy_add_x_forwarded_for) — otherwise the leftmost XFF element is
  // client-controlled and an attacker can forge it to mint unlimited per-IP
  // buckets. See deployment.md §nginx and knowless 1.3.0 CHANGELOG.
  trustedProxies: list(process.env.GITDONE_TRUSTED_PROXIES, ['127.0.0.1', '::1']),
};

module.exports = config;
