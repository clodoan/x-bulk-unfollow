# Security Policy

## Supported Versions

This is a personal tool. Only the latest commit on `main` is supported.

## Reporting a Vulnerability

If you discover a security vulnerability in this extension, please **do not** open a public issue.

Instead, email the maintainer directly or use GitHub's private vulnerability reporting feature.

### What to Report

Please report issues such as:

- Accidental exposure or leakage of API keys / tokens
- Unsafe storage of credentials
- Cross-site scripting or injection vectors in the UI
- Unintended network requests to third-party domains
- Logic that could allow mass unfollowing without user intent

### Scope

This extension is designed to be **fully client-side**. It only makes requests to:

- `https://api.x.com/*` (X API)
- `https://api.x.ai/*` (when you explicitly use Grok analysis and provide your own key)

It does **not**:
- Send your following list to any server
- Phone home
- Use analytics or telemetry

## Best Practices for Users

- Never commit your `xaiApiKey` or X tokens anywhere.
- Only load the extension from a trusted source (your own clone).
- Review the code before pasting any API keys.
- Use a secondary X account when testing aggressive unfollow strategies.

## Responsible Disclosure

We appreciate responsible disclosure. If you report a valid security issue, we will acknowledge your contribution (unless you prefer to remain anonymous).
