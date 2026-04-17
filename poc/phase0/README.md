# GitDone Phase 0 POC

**Goal:** prove the core receive pipeline (DKIM verify + MIME parse) works on a real email, before touching Postfix or writing a line of production code.

**Status:** throwaway. Do NOT extend this into production. When it passes graduation, we rewrite into `backend/` with structure + tests.

---

## Graduation criteria (from PRD §10, Phase 0)

One real email, fed in via stdin, produces:
- `dkim.result: "pass"` for a major provider (Gmail / Outlook / Fastmail / etc.)
- Correct `from`, `subject`, `body_preview`
- Attachment list with size + SHA-256 (if the test email has an attachment)

If all three work on three different provider samples (e.g. Gmail, Outlook, Yahoo), POC passes.

---

## Local test (Phase 0a — no VPS needed)

### 1. Install

```bash
cd poc/phase0
npm install
```

### 2. Get a real .eml file

Pick any email in your inbox that you know is DKIM-signed (almost anything from Gmail, Outlook, mailing lists, newsletters).

- **Gmail web:** open email → three-dot menu → "Show original" → "Download original" → save as `sample.eml`
- **Thunderbird:** right-click message → Save As → `sample.eml`
- **mutt / CLI:** the raw message file in your Maildir already works

Drop the file into `poc/phase0/sample.eml`.

### 3. Run

```bash
cat sample.eml | node receive.js
```

Expected output: a JSON blob with `dkim.result: "pass"`, parsed headers, body preview, and (if present) attachment hashes.

### 4. Repeat with 2 more emails from different providers

Confirm DKIM passes for each. If one fails, note which provider and why (the `dkim` object will tell you — `fail`, `neutral`, `none`, etc.).

---

## VPS wire-up (Phase 0b — after local POC passes)

These are the steps that turn this into an actually-receiving mail server. Do NOT run these until local POC is green.

### 1. DNS

Point an MX record for your test subdomain at your VPS:

```
gitdone.yourdomain.   IN   MX  10  vps.yourdomain.
```

Plus A record for `vps.yourdomain.` → VPS IP.

(SPF / DKIM / DMARC for outbound come in Phase 1 — not needed just to receive.)

### 2. Postfix

```bash
sudo dnf install postfix
sudo systemctl enable --now postfix
```

Edit `/etc/postfix/main.cf`:

```
myhostname = vps.yourdomain
mydomain = yourdomain
myorigin = $mydomain
inet_interfaces = all
mydestination = $myhostname, localhost.$mydomain, localhost, gitdone.yourdomain
```

### 3. Pipe transport

Edit `/etc/postfix/master.cf`, add:

```
gitdone unix - n n - - pipe
  flags=FR user=gitdone argv=/usr/bin/node /home/gitdone/poc/phase0/receive.js
```

Edit `/etc/postfix/transport`:

```
gitdone.yourdomain  gitdone:
```

Run: `sudo postmap /etc/postfix/transport && sudo systemctl reload postfix`

### 4. Firewall

```bash
sudo firewall-cmd --permanent --add-service=smtp
sudo firewall-cmd --reload
```

### 5. Test

From any external mail client, send to `anything@gitdone.yourdomain`. Output of `receive.js` lands in Postfix logs (`journalctl -u postfix` and/or `/var/log/maillog`). If you want it visible, wrap the script so stdout appends to `/var/log/gitdone-poc.log`.

---

## What's deliberately NOT in this POC

- No git commits
- No OpenTimestamps
- No routing by event ID
- No attachment forwarding
- No database / JSON storage
- No error recovery / retry
- No tests

All of that is Phase 1+. POC's only job is to prove DKIM + MIME works on stdin.

---

## Teardown

When POC graduates:

```bash
rm -rf poc/phase0
```

Then start Phase 1 design per PRD §10.
