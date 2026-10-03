# Create campaign navigation — 0.2.0b

## Symptom

Saving a new campaign successfully created its row, but returned to the campaign list instead of opening its detail screen.

## Evidence

Browser verification on an isolated local server at port 8790 created a template, a fictional recipient and a draft. The success toast and new campaign row appeared, while the URL remained `#campaigns`. Clicking that row opened the correct detail and rendered personalized content.

## Root Cause

The create form assigned the detail hash before refreshing the workspace projection. The hashchange handler could not find the newly created ID in the old collection and navigated back to the list.

## Why the issue escaped detection

Domain and HTTP tests verify creation but do not run browser hash routing. This was found during the first browser form workflow verification.

## Proposed prevention

Refresh workspace state before applying the form's returned destination. Repeat creation in the browser and verify the detail URL and personalized preview. Keep browser smoke verification alongside the domain/API suite for UI changes.
