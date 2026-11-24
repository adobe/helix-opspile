# Embed Enterprise Support in another host (v1)

A signed-in member of a registered host can start and follow support conversations inside that
host. The audience is **all approved members of this host's customer and its support staff**.
Show that audience before accepting a message. Only send the title, optional public topic and
customer-written body. Don't send private diagnostics, session links, prompts or staff notes.

The host renders its own list, conversation and composer. Its browser calls its **own backend**;
only that backend calls the portal Worker at `/integrations/portal/v1`. The API doesn't grant
CORS access, frame the standalone portal, use its cookies, or require a particular login provider,
chat platform, email domain or channel naming convention.

## Operator setup

1. Apply the [portal migrations](../portal/migrations) to the **portal database**, not the inbox's.
   Connect the existing `OPSPILE` and `PORTAL` service bindings (README, “Customer portal”).
2. Protect the integration path with a separate Cloudflare Access application and a **Service Auth**
   policy allowing the specific backend service tokens. Use the portal's Access team domain and
   set the portal Worker var `PORTAL_INTEGRATION_AUD` to this application's audience. With no
   audience or with the standalone portal audience, integration access is disabled. Leave the
   ordinary portal's hostname policy, one-time PIN and frame restrictions in place.
3. Register each host in portal D1, out of band. Use independent service credentials and signing
   keys per host and environment. Register the Access service token's **client ID** (the signed
   `common_name`), not its display name. Keep the service secret and signing private key on the
   host backend only. Register an RSA public JWKS with unique `kid`s; use RSA keys of at least
   2048 bits. To rotate, add the new public key, switch signers, then remove the old key.

   ```sql
   -- Bound parameters, not literal secrets. Only PUBLIC key material belongs here.
   INSERT INTO integration_hosts(id, service_id, issuer, jwks, scopes)
     VALUES (:host, :access_client_id, :issuer, :public_jwks,
       '["threads:create","threads:read","threads:reply","changes:read"]');
   ```

4. Map the host's stable tenant ID to an approved customer key and a channel name of your choice.
   For example, an inventory console might map `account-42` to `paper-mill` and display
   `Mill support`. There is one mapping per `(host, tenant)` and `(host, customer)`. A different
   console using those exact identifiers gets its own channel, accounts, request keys and history.

   ```sql
   INSERT INTO integration_customers(host, tenant, customer, name)
     VALUES (:host, :tenant, :customer_key, :channel_name) RETURNING channel;
   ```

   Save the returned **reserved channel ID**. Before enabling the tenant, in the **inbox** set
   up the existing manual assignment rules for this ID (Rules: source `portal`, field
   `channel_id`, pattern `^<reserved ID>$`, priority 10, note `manual assignment`). One rule
   targets the approved **team**, the other the approved **org**. Verify the effective rules,
   including sharing/follow rules, with the support owner. Do not fall back to a display-name
   match. This ordering means no first message can arrive before its route is configured; normal
   outbox and normalization retries use these same rules. Neither Worker accesses the other's DB.

5. Enroll **specific subjects**, not everyone the host can sign in. Use names suitable for display
   to the customer. For an ID-only host, create an actor without an email and link the returned ID
   to the approved subject. If using a verified email alias, link only the uniquely matching actor
   **in this channel**, after separately approving the subject. An actor already linked to another
   subject (including an inactive member) cannot be claimed. Require a human to resolve conflicts;
   do not replace mappings. Never link to an ordinary portal user, staff or bot.

   ```sql
   INSERT INTO integration_actors(channel, name, verified_email)
     VALUES (:channel, :display_name, :lowercase_verified_email_or_null) RETURNING actor;
   INSERT INTO integration_members(channel, subject, actor) VALUES (:channel, :subject, :actor);
   -- Only after checking the channel route, audience and roster:
   UPDATE integration_customers SET enabled = 1 WHERE channel = :channel;
   ```

   To link a previously approved actor by alias instead of creating another, use a parameterized
   `INSERT INTO integration_members(channel, subject, actor) SELECT channel, :approved_subject,
   actor FROM integration_actors WHERE channel = :channel AND verified_email = :email`. Require
   exactly one inserted row; on no match or a uniqueness conflict, stop. No runtime email lookup
   can enroll a new subject.

   A member linked by email must also present the same issuer-verified email on every call.
   A matching email alone never authorizes anything. Change `integration_members.active` to `0` to
   revoke, `integration_customers.enabled` to `0` to suspend, or empty a host's scopes to disable
   it. Don't delete and reassign identities. These are configuration changes, not host-specific
   code or deploys. Reads, retries and polls recheck enrollment.

## Backend request

Send the Access service credentials in `CF-Access-Client-Id` / `CF-Access-Client-Secret` over
HTTPS. Access forwards a signed application token; the Worker checks that token, its audience
and service identity. A browser-supplied ID or host hint is **not** accepted as identity.

Also send `Authorization: Bearer <JWT>` signed by the registered host (`alg: RS256`, registered
`kid`). Use the verified **server session** to derive `tenant` and `sub`. Don't forward a login
token. Sign a new assertion on each attempt, including retries. Example backend adapter for one
operation (the host supplies its own JWT library and session verification):

```js
async function createRequest(session, { title, body }, requestKey) {
  const path = '/integrations/portal/v1/threads';
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signRS256({
    iss: config.issuer, aud: config.integrationAudience, iat, exp: iat + 45,
    jti: crypto.randomUUID(), tenant: session.activeAccountId, sub: session.memberId,
    method: 'POST', path, scope: 'threads:create',
    // If the enrollment uses an alias, add email and email_verified: true
    // ONLY from an issuer-verified address in this session.
  }, config.privateKey, config.kid);
  return fetch(new URL(path, config.portalOrigin), {
    method: 'POST', redirect: 'error', headers: {
      'CF-Access-Client-Id': config.serviceId, 'CF-Access-Client-Secret': config.serviceSecret,
      Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json',
      'Idempotency-Key': requestKey,
    }, body: JSON.stringify({ title, body }),
  });
}
```

`aud` is the integration Access audience string, times are Unix seconds (up to 60 seconds from
`iat` to `exp`), `method` is uppercase, and `path` is the exact pathname without a query string.
The signed `scope` must be the one for the route, and allowed for the host. Configure the origin,
paths and scopes server-side. Don't proxy arbitrary upstream URLs, headers or JSON. Protect the
host's own endpoints against CSRF and session mix-ups. Return private, non-cacheable responses.

## HTTPS/JSON contract

All paths below are relative to `/integrations/portal/v1`. Write bodies accept only the fields
listed. Strings are text, not HTML. Render public message bodies as text or sanitized markdown.

| Request | Scope | Response |
| --- | --- | --- |
| `POST /threads` `{title,body,topic?}` | `threads:create` | `201 {threadId,channelId,channelName,requestId}`, `Location` for the thread. An enrollment with no channel gets one. |
| `GET /threads` | `threads:read` | `{items:[{id,title,lastActivity,resolved,unread}],next,unreadThreads,changeCursor}`. Before the first thread: empty list, zero unread and a usable cursor. |
| `GET /threads/{root}` | `threads:read` | `{id,title,resolved,messages:[{id,at,kind,name,body,rev,deleted}],next}`. No implicit read acknowledgement. |
| `POST /threads/{root}/replies` `{body}` | `threads:reply` | `201 {id,threadId}`. Only a root of the caller's channel is a valid target. |
| `PUT /threads/{root}/read` `{through}` | `threads:read` | `{unreadThreads}`. Acknowledge up to that displayed message ID, never a later reply. |
| `GET /changes?after={cursor}` | `changes:read` | `{events:[{id,type:"thread.updated",threadId,reason}],next,hasMore,unreadThreads}`. Reasons: `created`, `reply`, `edited`, `deleted`, `resolution`, `read`. Read changes are viewer-only. |

- Title: one nonblank line, at most 120 characters; body: nonblank, at most 2,000 (UTF-16 code
  units). A host can register public topic keys (`integration_hosts.topics`, a JSON array); no
  topics by default. The portal root is title, optional topic and body separated by blank lines.
- Both POSTs require `Idempotency-Key` (1–128 ASCII letters, digits, `.`, `_`, `:`, `-`). Keep one
  key per user intent; a timeout doesn't mean the message wasn't committed. The same member,
  operation and input return `200` with the original IDs. Reusing the key with different input
  (including a different reply target) returns `409 key_conflict`. Receipts aren't pruned with
  the feed; retry only while the member is still authorized.
- List/detail take `limit` (default 25, max 100) and `cursor` (`next:null` when done). Threads
  sort by last non-deleted message time, then ID descending; messages by insertion order. A
  collection cursor belongs to this viewer and collection, including the root for detail. If
  the snapshot changes while paging, restart on `410` rather than mixing two snapshots.
- `unread` counts non-deleted messages by others after this viewer's marker. Staff and app replies
  show as **Adobe Support**; no upstream identities, emails, agent progress, files or reactions
  are returned. The staff checkmark on the root supplies `resolved`; a deleted message has an
  empty body. The feed contains no message bodies and has no effect on inbox delivery.

### Keeping the host's UI current

1. Load the list, badge and `changeCursor` together. Poll `/changes` every 10 seconds while the
   host is visible (even with its support panel closed), and immediately on focus or reconnect.
2. Apply the unread count and refetch changed visible threads/list. Deduplicate by event `id`.
   Save `next` **after** applying successfully; drain immediately while `hasMore` (100 per page).
   Empty batches have `events:[]`. A failed poll leaves the last good view and cursor in place.
3. Keep state per account and subject. On logout/tenant or profile switch, abort requests, ignore
   late responses and discard that view's drafts, cursors and badge. Never reuse cached pages
   for the next viewer. On `410 cursor_expired` (including after seven days offline), discard
   the snapshot and start from the list again. No webhooks or push permissions are needed.

Errors have shape `{"error":{"code":"…"}}`: `400 invalid_input` / `invalid_cursor`, `401
invalid_assertion`, `403 not_enrolled` (including scope denial), `404 not_found` (including a
foreign object), `409 key_conflict`, `410 cursor_expired`, `429 rate_limited`, `503 unavailable`.
The pilot allows 60 admitted operations/minute per viewer, 600 per channel and 6,000 per host.
Honor `Retry-After` on 429; back off with jitter on transient failures. Use a **fresh assertion**
and the **original operation key** when retrying a write. Never log credentials or message text.
