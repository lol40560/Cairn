# Cairn v2.0.3

## Highlights

- Makes direct team joining independent of automatic network discovery and keeps failed joins retryable.
- Shows actionable connection errors and preserves credential-redacted diagnostic details.
- Patches DOMPurify to 3.4.17 in both the dependency tree and Monaco's active renderer bundle, while retaining Monaco 0.57.0.

## Security and distribution

- Build-time checks prevent Monaco's older vendored sanitizer from entering the renderer bundle.
- Error details redact invitation secrets and credentials, and third-party notices reflect the patched dependency.
- v2.0.3 installers are not Developer ID-signed or Apple-notarized, and Windows installers are unsigned. macOS Gatekeeper and Windows SmartScreen warnings are expected.

## Team joining and synchronization

- Guides users to open a project before joining and validates direct addresses before changing team state.
- Cleans up partial joins, serializes room changes, and resolves simultaneous connections consistently.
- Counts peers only after authentication, retries initial discovery failures, and tries alternate IPv4 addresses.
- Cancels timed-out connections and prevents obsolete retries from reviving stopped sessions.
- Clears stale team state on project changes and defaults downloads to the monitored folder. Alternate downloads are clearly identified as separate copies.

## Validation

- 541 tests, production dependency audit, lint, TypeScript, legal checks, and production build passed.
- Five unsafe sanitizer cases reproduced with the old copy and were blocked by the patched version in an isolated browser renderer; allowed markup and HTTPS links remained intact.
- Real encrypted two-instance checks synchronized file changes in both directions without feedback loops. Two physical computers on the same Wi-Fi have not yet been checked together.

## Known limitations

- Peers still need a reachable network connection. Internet relays and clickable invitation links are not included.
- Cairn does not claim full-project convergence because the protocol has no acknowledgement model.
- Session rollback remains analysis-only; a safe automatic three-way revert is not implemented.
- Binary conflict comparison remains metadata-only.
- Checkpoints and deleted-file recovery are safeguards, not replacements for independent backups.
