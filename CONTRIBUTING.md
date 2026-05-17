# Contributing to X Bulk Unfollow

Thank you for your interest in this project!

This is primarily a **personal tool** built for practical use. Contributions are welcome, but please keep the following principles in mind.

## Core Philosophy

This extension was built with a strong emphasis on **safety and abuse prevention** because:

- Bulk actions on X can easily get accounts restricted or banned.
- AI-powered suggestions (local scoring + Grok) can create a false sense of safety ("the AI said it was okay").
- We deliberately added friction (18s delays, hard caps, warnings, no auto-selection) to protect users from themselves and from platform enforcement.

Any change that reduces safety or makes it easier to do large, fast, or blind unfollow operations will likely be rejected.

## How to Contribute

1. **Fork** the repository and create your branch from `main`.
2. **Make focused changes** — prefer small, reviewable PRs.
3. **Update tests** when modifying `lib/scoring.js`.
4. **Document trade-offs** — especially anything that affects rate limiting, confirmation flows, or scoring logic.
5. **Run the tests** before submitting:
   ```bash
   node tests/test-scoring.js
   ```

## Areas Where Contributions Are Especially Welcome

- Improvements to the local scoring heuristic (with test cases)
- Better UX for the safety warnings without reducing protection
- Accessibility improvements in the manager UI
- Documentation clarifications
- Handling of new X API fields or edge cases

## Areas That Are Unlikely to Be Accepted

- Removing or weakening the 18-second minimum delay
- Removing the per-session unfollow cap
- Adding "one-click nuke everything below X score" without multiple confirmations
- Features that make it trivial to unfollow thousands of accounts quickly
- Any form of telemetry or external data collection

## Code Style

- Keep the extension dependency-free (vanilla JS + CSS).
- Prefer clarity and safety over cleverness.
- When in doubt, add more user-visible warnings rather than more automation.

## Questions?

Feel free to open an issue with the `question` label.

Thank you for helping make following hygiene tools safer and more responsible.
