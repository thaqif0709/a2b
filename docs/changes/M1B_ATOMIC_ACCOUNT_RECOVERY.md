# Atomic account recovery

Initially based on upstream `134045a`; refreshed onto `7ff9dda` for review on 30 October 2026. This change fixes password recovery on the existing website.

## Problem and changes

- The previous recovery flow read and marked a recovery code in separate queries. Two requests could both claim the same code. A subsequent failure could also leave the code consumed without completing recovery.
- Recovery now uses one D1 batch transaction for the conditional code claim, password update, old-session revocation and replacement-session creation. Every later mutation checks this request's replacement-code hash: a zero-row claim cannot change the account or create a session.
- All passwords and random credentials are prepared before the transaction. A database failure rolls back the code claim, password and sessions together, so the same saved code can retry.
- Each successful reset replaces the used recovery code. Its plaintext appears only in that reset response; only its hash is stored. The existing save-code panel displays it immediately, before follow-up requests, and explains that the old code no longer works.
- The reset button is disabled while a request is pending. The form now asks for the latest saved code, including replacements.
- Recovery has a separate eight-attempt / fifteen-minute window per normalized email. Concurrent requests reserve attempts inside the same transaction. Unknown emails receive the same invalid/limited responses; users sharing an IP do not share the limit. Success clears recovery and login failures for that account; daily cleanup removes expired attempts.
- Malformed percent-encoded session cookies are treated as signed out instead of causing a server error.
- Migration `0015_recovery_attempts.sql` and runtime schema initialization create the attempt table and email/time index. No role or tester authorization behavior changes.

## Original validation

- Baseline synthetic test of upstream `consumeRecoveryCode`: both competing requests succeeded (2/2), demonstrating the race without real accounts.
- `npm test`: 185 tests passed, including six new recovery tests.
- Synchronized API requests: exactly one recovery succeeds, the loser receives no session cookie or replacement code, only the winner's password works, and only its new session remains.
- Injected database errors at password update, old-session deletion and new-session insertion: code, password and sessions match their pre-request state; retry with the same code succeeds.
- Twelve concurrent invalid attempts: eight invalid responses and four limited responses; another account from the same IP succeeds; expired attempts no longer block recovery. Unknown emails follow the same limit.
- Local Wrangler D1 runtime confirmed one winner and rollback/retry at all three fault points. This checks the actual D1 batch behavior beyond the SQLite test shim. No remote database was accessed.
- Local browser synthetic account: recovery form completed, replacement warning/code panel appeared, dismissal returned to the authenticated profile. No real user credentials or location were used. Browser viewport was not resized; phone-device validation remains for owner review.
- New migration executed successfully against a fresh local Wrangler database. `git diff --check` passed.

## Review and rollout notes

Cloudflare documents that [D1 batches are SQL transactions and roll back on statement failure](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). A conditional update that matches no rows does not fail, hence the explicit request-specific guards.

The rate limit is per account, so someone who knows an address can temporarily exhaust its window; it is independent of the password-login window. A response lost after a successful commit cannot reveal the replacement code again: the user can sign in with the new password, but must save the replacement when it is displayed. Recovery codes retain the existing no-expiry policy and format.

Apply the additive migration through the owner's normal release process before deploying. This change is submitted for review only; it has not been merged or deployed, and no CLA has been accepted.

## Review refresh — 30 October 2026

- Merged upstream `7ff9dda` without conflicts. Preserved the already-landed place suggestions and train reports.
- Renamed the additive migration to `0015_recovery_attempts.sql`: main already owns 0013 and 0014. No existing
  production migration is changed; this renumbering updates this branch only.
- `npm test`: exit 0, 197 pass, 0 fail, 0 skip, including concurrent recovery, rollback/retry at all three
  mutation stages, rate limiting and malformed cookies. Syntax checks and `git diff --check` pass.
- The renamed migration executes successfully on an isolated local Wrangler D1 database. No remote migration,
  merge, deployment or CLA action was performed.
- Re-ran the actual local Wrangler D1 concurrency and fault harness against the refreshed branch: one winner,
  no loser cookie, and rollback/retry passes for password update, session revocation and session insertion.
