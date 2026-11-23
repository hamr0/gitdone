# ops/postfix

- `virtual` — role-address forwards (postmaster@, abuse@, ...); see
  `docs/wiki/deployment.md` §6.1. `postmaster@` still forwards to Gmail.
- `aliases-dmarc` — local alias delivering DMARC `rua` reports into a Maildir.

## DMARC report mailbox (server steps)

Run on the VPS after deploying the repo.

```bash
# 1. Maildir, owned by gitdone
sudo install -d -m 0700 -o gitdone -g gitdone /var/lib/gitdone/dmarc \
  /var/lib/gitdone/dmarc/new /var/lib/gitdone/dmarc/cur /var/lib/gitdone/dmarc/tmp

# 2. Route the rua addresses to the local alias. ops/postfix/virtual is the
#    source of truth (matches the box as of 2026-11-23, plus the two dmarc@
#    lines); diff before installing, then rebuild the map
sudo diff /etc/postfix/virtual /opt/gitdone/ops/postfix/virtual   # expect only the dmarc@ lines (+ ordering/comments)
sudo cp -a /etc/postfix/virtual /etc/postfix/virtual.bak-$(date +%Y%m%d-%H%M%S)
sudo install -m 0644 /opt/gitdone/ops/postfix/virtual /etc/postfix/virtual
sudo postmap /etc/postfix/virtual

# 3. Alias file OWNED BY gitdone, then build the .db and chown it too.
#    local(8) delivers file/dir alias targets with the alias DB owner's
#    privileges; a root-owned DB means default_privs=nobody, which cannot write
#    into the 0750 gitdone data dir.
sudo install -m 0644 -o gitdone -g gitdone /opt/gitdone/ops/postfix/aliases-dmarc /etc/postfix/aliases-dmarc
sudo postalias /etc/postfix/aliases-dmarc
sudo chown gitdone:gitdone /etc/postfix/aliases-dmarc.db

# 4. Enable and reload
sudo postconf -e "alias_maps = hash:/etc/aliases, hash:/etc/postfix/aliases-dmarc"
sudo postfix reload

# 5. Check
postmap -q dmarc@signedreply.com hash:/etc/postfix/virtual   # -> dmarc@localhost
postalias -q dmarc hash:/etc/postfix/aliases-dmarc            # -> /var/lib/gitdone/dmarc/
```

Rerun `postalias` + `chown` whenever `aliases-dmarc` changes.
