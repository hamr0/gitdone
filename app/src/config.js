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
};

module.exports = config;
