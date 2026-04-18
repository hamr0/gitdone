// Dev-mode ergonomics:
//   - /dev/feedback  — POST endpoint for UI feedback; appends to log
//   - /dev/stream    — Server-Sent Events stream for live-reload
//   - injectDevHUD() — HTML snippet for every page: feedback textarea,
//                      auto-reload script
//
// Everything here is GATED by the --dev flag. Production pages are
// byte-identical to pre-1.H.dev.
//
// Feedback "channel": the user types in the in-page textarea, POSTs to
// /dev/feedback, the server appends to dev-feedback.log. Claude (the
// dev agent) reads the log to see what to change. No WebSockets, no
// separate services — same server, one log file.
//
// Live reload: each page subscribes to /dev/stream (SSE). When the
// server starts up, it emits a "ready" event with its boot timestamp.
// The browser compares against its remembered boot timestamp and
// reloads on mismatch. Simple, no filesystem watching.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEV_FEEDBACK_LOG = process.env.GITDONE_DEV_FEEDBACK_LOG
  || path.join(process.cwd(), 'dev-feedback.log');
const BOOT_ID = Date.now();
const sseClients = new Set();

function bootBroadcast(eventObj) {
  const line = 'data: ' + JSON.stringify(eventObj) + '\n\n';
  for (const res of sseClients) {
    try { res.write(line); } catch {} // ignore broken pipes
  }
}

// Announce boot ID to any already-connected client (from a previous server
// process). Ideally they reload on seeing a new boot id.
function announceBoot() {
  bootBroadcast({ kind: 'ready', boot_id: BOOT_ID, at: new Date().toISOString() });
}

async function handleFeedback(req, res) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 16 * 1024) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      return res.end('too large');
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  // Accept both form-urlencoded and JSON
  let message = '';
  let url = '';
  const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ctype === 'application/json') {
    try {
      const j = JSON.parse(raw);
      message = j.message || '';
      url = j.url || '';
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('invalid JSON');
    }
  } else {
    const qs = require('node:querystring').parse(raw);
    message = qs.message || '';
    url = qs.url || '';
  }
  const entry = {
    at: new Date().toISOString(),
    from_url: url,
    user_agent: req.headers['user-agent'] || '',
    message: String(message).slice(0, 4000),
  };
  try {
    await fsp.appendFile(DEV_FEEDBACK_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    process.stderr.write(`dev-feedback write failed: ${err.message}\n`);
  }
  // Also echo to stderr so Claude's terminal session sees it live
  process.stderr.write(`\n\x1b[1;36m[UI FEEDBACK]\x1b[0m ${entry.at} @ ${entry.from_url}\n${entry.message}\n\n`);
  res.writeHead(204, {});
  res.end();
}

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`retry: 2000\n\n`);
  res.write(`data: ${JSON.stringify({ kind: 'ready', boot_id: BOOT_ID, at: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// HTML snippet injected into every page in dev mode. Fixed bottom-right
// textarea + Submit button; Ctrl+Enter sends. Auto-reload via SSE.
// Deliberately vanilla JS, no dependencies, ~40 lines inline.
function devHUD() {
  return `
<style>
#gd-dev-hud{position:fixed;bottom:12px;right:12px;width:320px;background:#fff;border:2px solid #0645ad;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.1);padding:8px;font:13px/1.3 system-ui,sans-serif;z-index:9999}
#gd-dev-hud h3{margin:0 0 4px;font-size:12px;font-weight:600;color:#0645ad;text-transform:uppercase;letter-spacing:0.05em}
#gd-dev-hud textarea{width:100%;min-height:60px;box-sizing:border-box;padding:4px;font:inherit;border:1px solid #ccc;border-radius:3px}
#gd-dev-hud button{margin-top:4px;padding:4px 10px;font:inherit;background:#0645ad;color:#fff;border:0;border-radius:3px;cursor:pointer}
#gd-dev-hud button:disabled{opacity:0.5}
#gd-dev-hud .status{display:inline-block;margin-left:8px;color:#070;font-size:11px}
#gd-dev-hud .hint{font-size:11px;color:#666;margin-top:2px}
</style>
<div id="gd-dev-hud">
  <h3>dev feedback → claude</h3>
  <textarea id="gd-fb" placeholder="Change you want. Ctrl+Enter to send."></textarea>
  <button id="gd-send">Send</button>
  <span class="status" id="gd-status"></span>
  <div class="hint">Appends to <code>dev-feedback.log</code> + stderr. Page auto-reloads when server restarts.</div>
</div>
<script>
(function(){
  var ta=document.getElementById('gd-fb'),btn=document.getElementById('gd-send'),st=document.getElementById('gd-status');
  function send(){
    var m=ta.value.trim();if(!m){return}
    btn.disabled=true;st.textContent='sending...';
    fetch('/dev/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:m,url:location.href})})
      .then(function(r){
        if(r.ok){ta.value='';st.textContent='sent ✓';setTimeout(function(){st.textContent=''},2000)}
        else{st.textContent='err '+r.status}
      })
      .catch(function(e){st.textContent='err: '+e.message})
      .finally(function(){btn.disabled=false});
  }
  btn.onclick=send;
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send()}});
  // Live reload
  try{
    var es=new EventSource('/dev/stream'),myBoot=null;
    es.onmessage=function(ev){
      var d;try{d=JSON.parse(ev.data)}catch(x){return}
      if(d.kind==='ready'){
        if(myBoot===null){myBoot=d.boot_id}
        else if(myBoot!==d.boot_id){location.reload()}
      }
    };
  }catch(x){}
})();
</script>
`;
}

module.exports = {
  handleFeedback,
  handleStream,
  devHUD,
  announceBoot,
  BOOT_ID,
  DEV_FEEDBACK_LOG,
};
