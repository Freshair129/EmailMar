# Campaign detail rendering — 2026-09-24

## Symptom

Campaign detail cannot display its preview and controls, including when opening a seeded demo campaign.

## Evidence

Before demo UI edits, `src/ui/app.mjs` function `campaignPage(c, p)` declared recipients, queue, adapter readiness and `canSend`, then ended without returning HTML. Its caller assigned that result to `main.innerHTML` and called `setPreview`, which requires `#email-preview`.

## Root Cause

The campaign detail renderer was incomplete: no markup was returned for its preview or existing action handlers.

## Why the issue escaped detection

Earlier browser evidence covered an empty campaign list, settings and workflow cards. Syntax checks cannot detect a missing render return, and domain/HTTP tests do not render the browser detail page.

## Proposed prevention

Restore the detail markup while integrating the requested demo controls. Exercise a seeded campaign through preview, approval, scheduling and simulated dispatch in the browser, and add UI fixture coverage. Demo actions must stay in browser memory without reaching real REST mutations or Gmail.

## Follow-up: recipient preview response ordering

Terra's subsequent review found that the recipient-change handler fenced only the real/demo mode epoch. A delayed preview from campaign A could therefore overwrite campaign B after navigation within the same mode, or an older recipient selection could overwrite the latest one. The main renderer already used a generation guard, but the change handler did not. Initial tests covered mode switching, so they missed same-mode navigation and reversed response order.

Prevention: capture the render generation, originating select element and a request sequence for each recipient preview; discard stale successes and errors before any DOM or preview-state update. Add delayed-response tests for same-mode navigation and recipient-selection ordering.
