// JSON-line logger. Writes to stdout (captured by journald) and optionally
// to a file (for human tailing). 12-factor §11.

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

let fileStream = null;
let fileStreamFailed = false;
function getFileStream() {
  if (fileStream || fileStreamFailed || !config.logFile) return fileStream;
  try {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    fileStream = fs.createWriteStream(config.logFile, { flags: 'a' });
  } catch (err) {
    fileStreamFailed = true;
    // Silent: stdout (journald) is the primary sink; file is convenience.
    // Don't pollute stderr or block delivery on log-write failure.
  }
  return fileStream;
}

function emit(record) {
  const line = JSON.stringify(record) + '\n';
  if (config.logToStdout) process.stdout.write(line);
  const stream = getFileStream();
  if (stream) stream.write(line);
}

module.exports = { emit };
