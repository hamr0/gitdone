// Envelope metadata from Postfix pipe transport.
// argv shape (from master.cf):
//   /opt/gitdone/bin/receive.sh ${client_address} ${client_helo} ${sender} ${original_recipient}
// receive.sh forwards args to receive.js, so process.argv has them at indices 2-5.

'use strict';

function parseEnvelope(argv) {
  const [, , clientIp, clientHelo, sender, recipient] = argv;
  const norm = (v) => (v && v !== 'unknown' ? v : null);
  return {
    clientIp: norm(clientIp),
    clientHelo: norm(clientHelo),
    sender: norm(sender),
    recipient: norm(recipient),
  };
}

module.exports = { parseEnvelope };
