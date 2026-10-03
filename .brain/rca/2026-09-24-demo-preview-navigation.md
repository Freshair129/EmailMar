# Preview navigation isolation — 2026-09-24

## Symptom

Independent Terra review found that template links could navigate the email preview frame, contrary to the isolated demo experience.

## Evidence

`setPreview` inserted template HTML into iframe `srcdoc`. Its CSP blocked resource loading and forms, while the iframe sandbox blocked script execution and top-level navigation. Neither removed template hyperlink destinations from the frame itself.

## Root Cause

Resource restrictions were treated as sufficient for preview navigation isolation. The markup retained navigational destinations.

## Why the issue escaped detection

Earlier fixtures previewed ordinary text content and did not inspect navigational markup.

## Proposed prevention

Sanitize navigation from the display-only preview using an inert DOM fragment before assigning `srcdoc`. Keep original template content unchanged. Preserve sandbox/CSP restrictions and add a regression check for external links, refresh metadata and base elements.
