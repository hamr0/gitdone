# Insights

Lessons learned and patterns discovered during development.

---

### Gmail SMTP requires app passwords
Regular Gmail passwords don't work with SMTP. Must enable 2FA first, then generate an app password at https://myaccount.google.com/apppasswords.

### Environment variable precedence matters
`dotenv` does NOT override existing environment variables. Shell exports take precedence over `.env` file values. Always `unset SMTP_*` before testing email configuration.

### Frontend API URL must match backend port
The frontend must be configured with `NEXT_PUBLIC_API_BASE_URL` pointing to the correct backend port (3001). Mismatched ports cause stats loading and API call failures.

### Absolute paths for .env loading
All backend scripts use `path.resolve(__dirname, '../.env')` to load .env from project root. This ensures consistency regardless of working directory.
