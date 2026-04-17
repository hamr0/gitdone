# Phase 0b — VPS Runbook

**Goal:** prove the production path works. Send a real email from an external Gmail (or similar) to an address on your new domain. Postfix on the VPS pipes it to `receive.js`. `receive.js` emits `trust_level: "verified"` for a clean sender. Done.

**If this works, Phase 0 graduates. If not, we learn what's broken at the plumbing layer before writing a line of Phase 1 code.**

---

## Prerequisites (fill these in before starting)

| Item | Value |
|---|---|
| VPS public IP | `____.____.____.____` |
| Base domain | `________________` (e.g., `gitdone.io`) |
| Receive hostname (where mail goes) | `gitdone.<base>` (e.g., `mail.gitdone.io` or just `gitdone.io`) |
| VPS hostname | `vps.<base>` (A record → VPS IP) |
| Node.js on VPS | `node -v` must be ≥ 18 |
| Reverse DNS (PTR) | VPS provider dashboard → set PTR for your IP to `vps.<base>` |

**Why PTR matters:** without reverse DNS pointing back to your hostname, many senders (Gmail included) may reject mail from you or defer delivery. For Phase 0b (receive-only) it matters less, but set it now so Phase 1 outbound isn't blocked.

---

## Step 1 — DNS records

At your DNS provider, create:

```
vps.<base>         A     <VPS IP>
gitdone.<base>     MX 10 vps.<base>.
```

(If you want mail to `*@<base>` directly instead of `*@gitdone.<base>`, set the MX on `<base>` itself. Simpler name choice, same plumbing.)

**Verify propagation** from your laptop before continuing:

```bash
dig +short MX gitdone.<base>
dig +short A vps.<base>
```

Both should resolve. If not, wait 5–30 min.

---

## Step 2 — Install Postfix and Node

SSH to VPS, then:

```bash
sudo dnf install -y postfix s-nail
node --version   # confirm >= 18, install via dnf/nvm if missing
```

`s-nail` gives you a simple `mail` CLI for local testing.

---

## Step 3 — Deploy the POC code to the VPS

From your laptop:

```bash
cd /home/hamr/PycharmProjects/gitdone
rsync -av --exclude node_modules poc/phase0/ <vps-user>@<vps-ip>:/opt/gitdone-poc/
```

Then on the VPS:

```bash
cd /opt/gitdone-poc
npm install
chmod +x receive.js
```

**Permissions:** Postfix's pipe transport runs the script as a specific user. For the POC we'll use Postfix's default `nobody` user. That means the script needs to be world-readable and its output log must be writable by `nobody`. So:

```bash
sudo chmod -R a+rX /opt/gitdone-poc
sudo touch /tmp/gitdone-poc.log
sudo chmod 666 /tmp/gitdone-poc.log
```

(Not production permissions — fine for POC.)

---

## Step 4 — Configure Postfix

Edit `/etc/postfix/main.cf`. Either use `postconf -e` (safer, one setting at a time) or append these:

```bash
sudo postconf -e "myhostname = vps.<base>"
sudo postconf -e "mydomain = <base>"
sudo postconf -e "myorigin = \$mydomain"
sudo postconf -e "inet_interfaces = all"
sudo postconf -e "inet_protocols = ipv4"
sudo postconf -e "mydestination = \$myhostname, localhost, gitdone.<base>"
sudo postconf -e "local_recipient_maps ="
sudo postconf -e "luser_relay = receive"
sudo postconf -e "mailbox_command ="
```

**What this does:**

- `mydestination` — tells Postfix "accept mail for these domains as local." `gitdone.<base>` is added.
- `local_recipient_maps =` (empty) — don't validate usernames; accept any `*@gitdone.<base>`.
- `luser_relay = receive` — route unknown users to the local alias `receive`. Combined with empty `local_recipient_maps`, this makes *every* address at the domain route to `receive`.
- `mailbox_command =` — disable the default mbox delivery; we want alias expansion only.

Now wire the `receive` alias to the pipe. Edit `/etc/aliases`:

```bash
echo 'receive: "|/usr/bin/node /opt/gitdone-poc/receive.js >> /tmp/gitdone-poc.log 2>&1"' | sudo tee -a /etc/aliases
sudo newaliases
```

Restart Postfix:

```bash
sudo systemctl enable --now postfix
sudo systemctl restart postfix
sudo systemctl status postfix
```

---

## Step 5 — Firewall

```bash
sudo firewall-cmd --permanent --add-service=smtp
sudo firewall-cmd --reload
sudo firewall-cmd --list-services   # confirm smtp is listed
```

Also confirm your VPS provider isn't blocking inbound port 25 at the network layer (DigitalOcean, Hetzner, and some others block port 25 outbound by default; inbound is usually fine but check their docs).

Quick external check from your laptop:

```bash
nc -zv vps.<base> 25
```

Should print `connection succeeded`. If not → firewall or provider block.

---

## Step 6 — Test locally first (on the VPS)

Before any external email, sanity-check the pipe:

```bash
echo -e "From: tester@localhost\r\nTo: anyone@gitdone.<base>\r\nSubject: local pipe test\r\n\r\nhi" | sendmail anyone@gitdone.<base>
sleep 2
cat /tmp/gitdone-poc.log
```

You should see JSON output from `receive.js`. It'll classify as `unverified` (unsigned local mail, no DKIM), but that proves the plumbing works.

**If nothing appears in the log:**

```bash
sudo journalctl -u postfix --since "5 min ago"
sudo tail -50 /var/log/maillog
```

Common errors to look for:
- `fatal: unsupported dictionary type` → config typo
- `Command died with status 1` → script error or permission issue
- `User unknown in local recipient table` → `local_recipient_maps` still set
- `command not allowed` → SELinux (see troubleshooting below)

---

## Step 7 — Real external test (graduation)

From any Gmail / Fastmail / Proton account, send to:

```
test@gitdone.<base>
```

Subject + body whatever. Attach a small PDF if you want to exercise attachment hashing.

Wait ~10 seconds, then on the VPS:

```bash
tail -1 /tmp/gitdone-poc.log | python3 -m json.tool
```

**Graduation criteria — all of these must be true:**

- `"accepted": true`
- `"trust_level": "verified"`
- `"dkim.signatures[0].result": "pass"`
- `"from"` matches the sender
- `"subject"` matches what you sent
- `"attachments"` populated with `sha256` (if you attached)

If you see this, Phase 0b is done. Architecture validated.

---

## Troubleshooting

### Script doesn't run (Postfix logs show the mail arrived but nothing in gitdone-poc.log)

**SELinux** (common on Fedora). Check if it's denying:

```bash
sudo ausearch -m avc -ts recent | grep -i postfix
```

If you see denials, temporarily set permissive to confirm:

```bash
sudo setenforce 0
# re-send test email
# check log again
```

If that fixes it, we need a proper SELinux policy. Ping me with the `ausearch` output and I'll generate one. Or for a POC, just leave it permissive — we'll do it properly in Phase 1:

```bash
# Permanent permissive — POC only, DO NOT ship to production
sudo sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config
```

### `node: command not found` when Postfix runs the script

The `PATH` inside the Postfix pipe context is minimal. Use the absolute path (we already did — `/usr/bin/node`). Confirm:

```bash
which node
```

If it's not `/usr/bin/node`, update the alias in `/etc/aliases` to match.

### Mail comes in as `unverified` instead of `verified`

- Check `dkim.signatures[]` — what does the comment say?
- If `body hash did not verify` from a Gmail sender in direct MX, that's a real problem. Send me the output.
- If no DKIM signature at all, your sender's outbound MTA isn't signing. Try from a different provider.

### Gmail bounces / defers your test email

Most likely no PTR record, or your IP is on a spam blocklist (fresh VPS IPs sometimes are). Check:

```bash
dig +short -x <VPS IP>
```

Should resolve to `vps.<base>`. If not, set the PTR at your VPS provider.

Check blocklists: https://mxtoolbox.com/blacklists.aspx

---

## What Phase 0b does NOT include

- TLS on inbound (add in Phase 1; Let's Encrypt via `certbot` + `smtpd_tls_*` settings)
- Outbound SMTP (receipts, reminders) — Phase 1
- Real attachment forwarding — Phase 1
- Git commits — Phase 1
- OpenTimestamps anchoring — Phase 1

POC charter: prove the pipe. Nothing more.

---

## Teardown (if Phase 0b fails and you want to start over)

```bash
sudo systemctl stop postfix
sudo dnf remove postfix s-nail
sudo rm -rf /opt/gitdone-poc /tmp/gitdone-poc.log
sudo rm -f /etc/aliases.db
# manually remove the "receive:" line from /etc/aliases
```

DNS records you can leave — they're cheap.
