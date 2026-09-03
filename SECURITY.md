# Security Policy

LastMilePDF is a desktop app that opens and edits local PDF files, and
optionally sends text to an AI provider (Anthropic or a custom endpoint you
configure) for the "Fix with AI" feature. API keys are stored via Electron's
`safeStorage` (OS keychain/DPAPI-backed), never in plain text.

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Instead, use GitHub's private vulnerability reporting for this repository:
open the **Security** tab → **Report a vulnerability**. This sends the
report privately to the maintainer without disclosing it publicly.

If that option isn't available to you, open a regular issue asking to be
contacted privately, without describing the vulnerability itself, and the
maintainer will follow up.

## Supported versions

This project is pre-1.0 and doesn't yet maintain multiple release
branches. Security fixes land on `master` and the most recent release.
