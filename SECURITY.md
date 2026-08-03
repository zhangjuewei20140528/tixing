# Security

Please do not report credentials, private user data, or production tokens in a public issue.

Before publishing or deploying this project:

- Copy `.env.example` to `.env.local` and set unique production secrets.
- Never commit `.env.local`, database files, QR screenshots, logs, or deployment archives.
- Rotate any credential that has appeared in a local file, terminal, screenshot, or chat.
- Use HTTPS and a managed PostgreSQL instance for production.

For a privately reported vulnerability, contact the repository maintainer through the
private contact method listed in the repository profile.
