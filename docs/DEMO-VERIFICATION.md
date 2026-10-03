# Demo UI verification — 2026-09-24

Scope: browser-memory demo data and simulated UI controls. Package version remains `0.3.0-beta.0`. No runtime model provider or actual email delivery is included.

## Acceptance

- Demo starts off; toggle/reset visibly identify the simulated workspace.
- Sample campaigns, recipients, templates, attachments, activity and DAGs render.
- Preview, approval, schedule, dispatch and reporting work on mock data.
- Consent and suppression restrictions remain visible; editing a draft invalidates its simulated approval.
- Gmail connect/disconnect simulation never navigates to Google.
- Independent DAG nodes progress together; human gates require an explicit decision.
- Switching modes closes forms and prevents stale responses from replacing the new view.
- Demo requests never fall through to the real REST API.
- Returning to the real workspace leaves its campaigns and audit untouched.

## Evidence

Baseline browser at `http://127.0.0.1:8788/`: zero campaigns and empty activity history. The real service uses SQLite. These checks read the UI only; credential and database contents were not inspected.

Browser checks on the local service:

- Toggle loaded three mock campaigns and four recipients (two eligible), with a persistent DEMO label.
- Draft preview rendered HTML and plain text. Explicit review enabled simulated approval; scheduling queued two recipients and withheld two. Simulated dispatch recorded two accepted results; open signal increased to one with a non-human-read interpretation.
- Two independent DAG nodes entered running together. Pause interrupted both; resume and explicit recovery allowed another claim generation. Review became ready after both completed. The human gate remained pending until explicitly confirmed, then the run completed.
- Simulated Gmail disconnect/connect changed the mock status and remained on the local Settings page.
- Switching off returned to zero real campaigns and empty real activity history, matching the baseline.

Initial integrated check: 76/77 tests passed. The failing UI fixture omitted `isConnected` on delegated click targets; the fixture was corrected, and its three focused tests then passed.

Terra's first independent source review flagged preview-frame hyperlink navigation. The final renderer sanitizes display-only HTML inside an inert template, removes navigational/resource attributes and active/nested markup, and retains iframe sandbox/CSP restrictions. Browser verification created a mock template version containing an external anchor, base and refresh metadata: the resulting srcdoc retained readable anchor text with `aria-disabled`, removed those destinations/metadata, and remained on `about:srcdoc`. No console errors were recorded. Editing an approved sample campaign to use that template returned it to draft with no approval.

Terra's follow-up identified same-mode recipient-preview response ordering. The handler now checks mode epoch, render generation, request sequence, source element identity, campaign and draft hash before applying responses or displaying errors. Delayed-response fixtures cover campaign navigation and reversed recipient response order.

## Final gate

- `npm test`: **78/78 passed**, zero failed/cancelled/skipped.
- `npm run check`: **Syntax OK: 22 JavaScript modules**.
- Terra: **PASS** on the final requested draft-hash guard, after prior navigation/isolation findings were resolved; source-review evidence is retained as local-only QA artifacts and is excluded from the public repository.
- Orchestrator: final tests and local browser checks passed. Reload starts with Demo OFF; the delivered tab is intentionally set to ON with a fresh seed for the user.
- Mode OFF hides the demo badge/reset; toggling/resetting discards simulated changes. Real campaigns and audit stayed empty after the browser exercise.

## Changed files

- `src/ui/demo.mjs`: isolated mock data and action router.
- `src/ui/app.mjs`, `src/ui/index.html`, `src/ui/styles.css`: toggle, reset, mode fencing, campaign detail and simulation controls.
- `src/http/ui-assets.mjs`, `src/http/server.mjs`: same-origin demo module delivery.
- `test/demo.test.mjs`, `test/demo-ui.test.mjs`: mock domain and UI isolation coverage.
- `docs/STANDALONE-UI.md`, this file, and two RCA notes under `.brain/rca/` documenting missing campaign rendering and preview navigation.

Real Gmail sign-in/send remain unverified; this demo supplies no live provider evidence. OAuth client/key remain locally configured from the preceding task. Google Cloud callback registration and account consent remain pending. Zuri JWT, Files resolver, Pub/Sub, PostgreSQL and deployment remain `NOT_CONFIGURED`.
