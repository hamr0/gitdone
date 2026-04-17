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
};

module.exports = config;
