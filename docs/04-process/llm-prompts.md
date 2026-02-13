# LLM Prompts & Agent Instructions

Guidelines for AI agents working on this project.

## When Working on GitDone

1. **Always verify** you understand requirements before proceeding
2. **Provide step-by-step** instructions with clear explanations
3. **Include ready-to-run** scripts and commands
4. **Explain the "why"** behind technical recommendations
5. **Flag potential issues** before they become problems
6. **Suggest simpler alternatives** when appropriate
7. **Never modify** authentication or database schema without explicit permission
8. **Always identify** which files will be affected by changes

## Project-Specific Context

- This is a Node.js/Express + Next.js application
- Data is stored in JSON files, not a database
- Git repositories are used for audit trails (one per event)
- Magic links use JWT tokens with 30-day expiry
- Email is sent via SMTP (Nodemailer); Gmail for dev, SendGrid for production
- Always use absolute paths when loading `.env` files

## Common Gotchas to Avoid

- Don't use regular Gmail passwords; use app passwords
- Don't forget to `unset SMTP_*` env vars before testing email
- Don't assume the frontend port; check `NEXT_PUBLIC_API_BASE_URL`
- Don't modify `data/magic_tokens.json` structure without checking `magicLinkService.js`
