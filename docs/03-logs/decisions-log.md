# Decisions Log

Track architectural and design decisions with rationale.

## Format

```
### Decision: [Title]
**Date**: YYYY-MM-DD
**Status**: Accepted | Superseded | Deprecated
**Context**: Why was this decision needed?
**Decision**: What was decided?
**Consequences**: What are the trade-offs?
```

---

### Decision: JSON Files Over Database
**Date**: 2025-01 (initial)
**Status**: Accepted
**Context**: MVP needed simple, inspectable data storage without database setup overhead.
**Decision**: Use JSON files for event data, Git repos for audit trails.
**Consequences**: Limited query capabilities and scaling, but simple to implement, inspect, and deploy. Sufficient for MVP and small-scale deployments.

### Decision: Magic Links Over Passwords
**Date**: 2025-01 (initial)
**Status**: Accepted
**Context**: Vendors need one-click access without account management.
**Decision**: JWT-based magic links sent via email with 30-day expiry.
**Consequences**: Email dependency for auth. No password management needed. Mobile-friendly one-click access.

### Decision: SMTP Over MSMTP
**Date**: 2025 (migration)
**Status**: Accepted
**Context**: MSMTP required system-level installation and complex per-server config.
**Decision**: Migrate to Nodemailer SMTP with .env configuration.
**Consequences**: No system dependencies, works identically in all environments, one-line deployment via `.env` file copy.

### Decision: Git for Audit Trail
**Date**: 2025-01 (initial)
**Status**: Accepted
**Context**: Needed immutable proof of work completion with file versioning.
**Decision**: Each event gets its own Git repo; step completion creates commits.
**Consequences**: Storage overhead from Git repos, but provides immutable history, built-in versioning, and familiar tooling.
