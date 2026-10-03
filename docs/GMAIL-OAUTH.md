# Gmail OAuth connection contract — 0.3.0b

## Purpose and ownership

Emar's Gmail connection manager owns the OAuth authorization-code exchange and scoped encrypted token bundle. The Gmail API adapter remains the only send caller and obtains an access token from the manager for a trusted `(tenantId, businessId)` scope. The browser receives an authorization URL and safe connection metadata; it never receives access tokens, refresh tokens, client secrets, or encryption keys.

Zuri Integration remains the owner of OAuth credentials and connection state in integrated deployments. Standalone mode may inject the same manager from its process secret configuration. No key is generated or persisted beside the campaign store. A missing or invalid setting produces `NOT_CONFIGURED` with missing environment field names only.

## Google OAuth flow

The web-server authorization-code flow uses Google's fixed HTTPS authorization, token, and OpenID Connect UserInfo endpoints. The redirect URI is configured once and sent exactly as configured; request Host headers never influence it. HTTPS is required except for a loopback HTTP redirect used by local development. Google's web-server guide documents the state parameter, offline access, authorization-code exchange, and refresh flow: [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server).

EmailMar requests only `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. It uses `state`, PKCE with `S256`, and `access_type=offline`. The callback verifies the returned state, one-time 10-minute expiry, initiating callback nonce, and the original tenant/business/actor binding before exchanging a code. Provider cancellation consumes the matching state and returns a safe `CANCELLED` outcome. State and PKCE verifier are in process memory; a restart invalidates an incomplete login.

The callback is a cross-site top-level GET from Google. The normal standalone session cookie uses `SameSite=Strict` and is not relied on at callback time. The initiating same-origin POST must set a separate random callback nonce cookie with `HttpOnly; SameSite=Lax; Path=/v1/integrations/gmail/callback; Max-Age=600`; the route keeps the nonce-to-session binding server-side and passes the nonce as `sessionBinding` to this manager for both `start` and `complete`. Do not put the main session cookie or CSRF token in the Lax cookie. The root route also validates CSRF on the initiating POST.

The code exchanges tokens only at `https://oauth2.googleapis.com/token`, then verifies the Google account using a bearer-authenticated GET to `https://openidconnect.googleapis.com/v1/userinfo`. It requires a subject, email, and `email_verified: true`; it does not use unverified ID-token claims. The [Google OpenID Connect reference](https://developers.google.com/identity/openid-connect/reference) documents the UserInfo endpoint and response claims. A granted-scope response is checked for all three requested scopes before connection metadata is saved. Google may return `https://www.googleapis.com/auth/userinfo.email` in place of the requested `email` alias; EmailMar normalizes that equivalent scope and still rejects a response without `gmail.send`. See [Google OAuth scopes](https://developers.google.com/identity/protocols/oauth2/scopes). Refresh uses the fixed token endpoint. An `invalid_grant` response marks the connection as requiring reauthorization and removes its encrypted bundle.

## Runtime configuration

`GmailConnections.fromEnvironment({ store })` reads these process environment names; callers may instead inject their values into the constructor. Provide values from the deployment's secret manager. The encryption key is exactly 64 hexadecimal characters (32 bytes). Never generate a development fallback or store the key in the database directory.

| Environment field | Use |
|---|---|
| `EMAR_GOOGLE_CLIENT_ID` | Google OAuth web application client ID |
| `EMAR_GOOGLE_CLIENT_SECRET` | Google OAuth web application client secret |
| `EMAR_GOOGLE_REDIRECT_URI` | Fixed callback URI registered for that OAuth client |
| `EMAR_TOKEN_ENCRYPTION_KEY` | 32-byte AES key encoded as 64 hexadecimal characters |

If any field is missing or invalid, `status(context)` returns `{ status: 'NOT_CONFIGURED', missingFields: [...] }`. The list contains environment field names only. `start()` throws a sanitized `GMAIL_OAUTH_NOT_CONFIGURED` error with the same field-name list; it never includes a configured value.

## Windows local configuration

The local configuration helper `scripts/local-config.ps1` imports an existing Google Web OAuth client JSON file without displaying its contents. `Configure` creates a random 32-byte token-encryption key on first setup and preserves that key on subsequent configuration changes. It protects the client configuration and key with Windows current-user DPAPI at `%LOCALAPPDATA%\Emar\credentials.dpapi`, outside the repository and database directory. A corrupt or unreadable vault fails closed; it is not replaced with a new key automatically.

```powershell
.\scripts\local-config.ps1 -Action Configure -ClientJsonPath '<path to downloaded Google client JSON>'
.\scripts\local-config.ps1 -Action Status
.\scripts\local-config.ps1 -Action Start
```

Run `Start` instead of plain `npm start` when using this vault. The helper decrypts the configuration into the service process environment, starts Emar, and restores the calling process environment on exit. Plain `npm start` does not load this Windows vault. The vault is tied to the Windows user profile and is not a portable plaintext key backup.

Google Cloud must include `http://127.0.0.1:8788/v1/integrations/gmail/callback` in the existing client's **Authorized redirect URIs**. Preserve existing callbacks used by other applications. Importing the downloaded JSON configures Emar locally; it does not modify the client's registered Google Cloud callbacks, enable Gmail API, or grant Google account consent.

## Manager API

```js
const gmailConnections = GmailConnections.fromEnvironment({ store });

await gmailConnections.start(context, { sessionBinding });
await gmailConnections.complete({ state, code, error, sessionBinding });
gmailConnections.status(context);
gmailConnections.disconnect(context);
gmailConnections.connectionIdentity({ tenantId, businessId });
gmailConnections.validateConnectionIdentity({ tenantId, businessId, expectedConnectionIdentity });
await gmailConnections.getAccessToken({ tenantId, businessId, provider: 'gmail', expectedConnectionIdentity });
```

`start` and `disconnect` require a trusted human context with `integration.write`. `status` requires `integration.read`. The HTTP route must independently authorize the initiating browser request, enforce same-origin/CSRF controls, and set the short-lived callback cookie described above. `complete` trusts only the state record created by `start` plus the matching callback nonce; it does not accept tenant, business, or actor claims from callback query parameters.

`start` returns `{ authorizationUrl, expiresAt }`. `complete` returns safe status metadata, or a sanitized `GmailConnectionsError` with `code` and HTTP `status`. `status` returns one of `NOT_CONFIGURED`, `DISCONNECTED`, `CONNECTED`, or `REAUTH_REQUIRED`; connected states may include `email`, `connectionId`, granted `scopes`, and `connectedAt`. The safe `callbackOrigin` property exposes only the validated redirect URI origin for the HTTP route's Origin check. `connectionIdentity` returns `null` or `{ connectionId, accountId, email }` for internal approval pinning. A new successful connection receives a new `connectionId`; token refresh preserves it. Connecting a different Google subject within the same tenant/business scope is rejected until the existing connection is explicitly disconnected.

The access-token method is internal to the backend integration boundary. The Gmail adapter may receive its returned bearer token, but the manager never places it in status, callback results, audit metadata, or public errors. Do not log authorization URLs, callback query values, token request bodies, provider bodies, or token bundles.

## Token protection and concurrency

The manager stores token bundles in `store.connections`, keyed by the JSON tuple `[tenantId, businessId]`. AES-256-GCM encrypts access token, refresh token, and expiry together. Its additional authenticated data binds the ciphertext to the Gmail provider, token format version, tenant, and business. The map record contains only the encrypted envelope plus non-secret connection metadata. Every connection, refresh, disconnect, and reauthorization/revocation transition appends a scoped audit event and calls `store.checkpoint()`; audit entries contain connection IDs and reason/scope metadata, never account emails, provider subjects, tokens, or provider error text. If checkpointing fails, the manager restores the in-memory map and audit list and returns a sanitized persistence error. An absent/incorrect key cannot decrypt a record and never triggers key creation.

Refresh is single-flight per connection scope. Disconnect deletes the record and advances the scope generation; a refresh finishing afterward checks that the exact original connection record is still current before writing refreshed ciphertext. This prevents an in-flight refresh from restoring a disconnected connection. Reconnection is also checked against an optional approval-pinned `expectedConnectionIdentity` before returning the bearer token.

The pending authorization state is process-local and expires after 10 minutes, so a restart invalidates an incomplete login. The default `SqliteStore` persists the encrypted `connections` map and audit events; the `InMemoryStore` fixture intentionally loses them on restart. Neither store persists the encryption key. Production still requires a protected database path, an external secret manager for the key, registered redirect URI, and live provider qualification.

## Risk and acceptance boundary

Risk level: **HIGH**. This path grants an external email-send capability and stores refresh credentials. Fixture tests cover state replay and binding, PKCE, scope checks, token redaction, encryption/AAD, refresh concurrency and revocation, account pinning, disconnect races, and storage health/checkpoint failures. They do not prove Google client registration, consent-screen verification, production secret injection, production SQLite ACLs, or a live Gmail send. Google describes offline refresh and the possibility of revoked or expired refresh grants in its [OAuth web-server guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).
