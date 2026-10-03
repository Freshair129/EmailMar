# Windows local configuration launcher: Node selection

## Symptom

The first `scripts/local-config.ps1 -Action Start` failed after Configure and Status had succeeded. The error described two executable paths concatenated as one command.

## Evidence

- `Get-Command node -CommandType Application` returned both the system Node and the bundled Codex runtime Node.
- Both executables reported `v24.19.0`.
- The script passed `$nodeCommand.Source`, an array in this environment, to the call operator.
- Configure and Status exited 0 and reported only configured field names. The launcher failure occurred before Node started.

## Root Cause

The launcher assumed executable discovery returned exactly one `ApplicationInfo`. PowerShell enumerated two matching applications, and member enumeration produced two paths instead of one executable.

## Why the issue escaped detection

Syntax validation and source review do not exercise the host's PATH resolution. The defect appeared on the first actual Start invocation with this Windows environment.

## Proposed prevention

Select one resolved executable explicitly and validate that its version supports Emar's Node.js 22.13 minimum before invoking it. Keep nonzero startup failures visible to the caller. Verify the subsequent launch using the local health endpoint and the Gmail settings status; never print the process credential environment.
