# Assumptions, Constraints & Risks

## Technical Constraints

1. **JSON File Storage**: No database; event data stored as JSON files in `/data/events/`
2. **Single Server**: Architecture designed for single VPS deployment
3. **No Real-Time**: Stats update every 6 hours via background scheduler, not live
4. **File-Based Auth**: Magic tokens stored in `data/magic_tokens.json`
5. **Node.js Runtime**: Backend requires Node.js 18+
6. **System Dependencies**: FFmpeg required for video processing, Sharp for images

## Assumptions

1. Event JSON files are only created/modified by the application API (not external sources)
2. Step `status` field values are consistent: only `"pending"` or `"completed"`
3. Platform will have < 10,000 events (single-file aggregation adequate)
4. Server restarts are infrequent (scheduler state resets on restart)
5. Gmail SMTP is sufficient for development; dedicated service (SendGrid) for production

## Known Limitations

- **Scaling**: JSON file storage is suitable for 100s of events, not millions
- **Querying**: No complex query capability without a database
- **Concurrency**: No file-level locking for simultaneous writes
- **Email Dependency**: Magic link auth requires working SMTP; no fallback

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Git repo size growth | Storage overhead per event | Monitor disk usage; archive old repos |
| Gmail rate limits | Email delivery delays | Use SendGrid/Mailgun for production |
| Corrupt JSON files | Data loss for affected event | Error handling skips corrupt files; backup strategy |
| JWT secret compromise | All magic links invalidated | Rotate secret; short token expiry |

## Future Scaling Path

1. **Phase 1 (Current)**: Single VPS, file-based storage
2. **Phase 2**: PostgreSQL database + object storage (S3)
3. **Phase 3**: Microservices + container orchestration
4. **Phase 4**: Multi-region deployment
