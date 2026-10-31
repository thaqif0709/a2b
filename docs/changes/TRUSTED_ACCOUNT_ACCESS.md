# Trusted account access

## Problem and scope

Public signup did not verify email ownership, but `TESTER_EMAILS` granted both testing tools and owner access.
A local synthetic signup matching that allowlist could read `/api/stats` immediately. A regression expecting
404 reproduced the issue against upstream `134045a` before this change (actual response: 200).

## Changes

- Gate private owner data with exact existing account IDs in `OWNER_USER_IDS`.
- Following [review on #42](https://github.com/thaqif0709/a2b/pull/42#pullrequestreview-5709613060), retain
  upstream's `TESTER_EMAILS` behavior for demo driving, capacity bypass and suggested-place review. There is no
  `TESTER_USER_IDS` setting. Owner access and tester access are independent.
- Restrict usage, private feedback reads, and feedback close/reopen (including the legacy DELETE endpoint)
  to owners on the server. An email allowlist match never grants private feedback or usage access.
- Add a separate owner flag to `/api/me` and clear it on failed authentication refresh.
- Keep demo controls and a new Suggested places row under Settings → Testing; show Usage and Feedback inbox
  only under Administration for owners. Testers open the Places list without a private Messages tab. Accounts
  with both capabilities can switch between Messages and Places; owner-only accounts cannot review places.
- Document deliberate provisioning after trusted confirmation of an existing account ID. No email migration,
  schema change, production configuration, or new dependency is included.
- Use synthetic email tester fixtures and ID owner grants; cover signup, role separation, exact matching,
  revocation, and feedback authorization regression coverage.

## Original validation (before review refresh)

- Before the fix: the unverified-email signup regression failed because `/api/stats` returned 200.
- After the fix: focused signup, role separation, private feedback, and usage tests passed (4/4).
- `npm test`: 180 tests passed, no failures. `git diff --check` passed.
- Local Chrome component smoke used the real Worker with an in-memory D1 fixture and the actual Settings modules
  and styles. Verified guest and ordinary signup have no privileged controls, tester gets demo but no private
  inbox/usage, owner gets both, and revocation disables access and demo on refresh. Opened the inbox and usage
  panels successfully. No browser exceptions occurred. External requests were blocked; map boot was omitted.
- Checked 375 × 812 portrait and 812 × 375 landscape with reduced motion; Settings retained its width with
  enlarged root text and owner buttons were at least 44 CSS pixels high. Existing UI styles are unchanged.

## Owner review / rollout

The maintainer must confirm and provision owner IDs as described in README before expecting private inbox/usage
access. Existing email-based testing tools continue to work. Signup still does not verify email ownership, so
an unregistered allowlisted address can still claim demo/capacity/suggestion-review access; this is the retained
upstream behavior explicitly requested in review, not a completed fix for every tester privilege. Private owner
access never derives from that address. No CLA, deployment or production secret change is performed here.

## Review refresh — 30 October 2026

- Merged upstream `7ff9dda`, preserving suggested-place review, landscape and train updates. Resolved the
  Settings/inbox conflict with separate tester and owner entry points. Restored CONTRIBUTING's tester setup.
- `npm test`: exit 0, 192 pass, 0 fail, 0 skip, including upstream's email-based suggestion workflow and
  private feedback/stats denials. Public signup with a tester email is explicitly tested as tester=true,
  owner=false; clients cannot choose trusted IDs or inject owner roles. Syntax and diff checks pass.
- Local Chrome component smoke with real Worker/in-memory D1 and actual HTML/CSS/modules: guest/ordinary/tester,
  owner-only and combined roles; Suggested places loads, tester has no Messages tab, owner-only has no Places tab,
  combined owner/tester switches both, private API denial and revocation. Portrait 375×812 and landscape 812×375,
  reduced motion, enlarged text; no page errors or external requests. Full-map/native-device tests not claimed.
- Synthetic screenshots: [tester settings](../images/trusted-access/tester-settings.png),
  [suggested places](../images/trusted-access/suggested-places.png).
