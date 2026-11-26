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
   INSERT INTO integration_hosts(id, service_id, issuer, jwks, scopes, product)
     VALUES (:host, :access_client_id, :issuer, :public_jwks,
       '["threads:create","threads:read","threads:reply","changes:read"]', :product);
   ```

   `product` (optional; lowercase letters, digits and `-`, up to 30) is what the host's channels
   are named after: our convention is `#<product>-<customer>`, so a host with product `agents`
   gets channels like `agents-paper-mill`. The inbox suggests these names when it approves
   [access requests](#access-requests); an admin can always change them. To set it on a host
   registered before: `UPDATE integration_hosts SET product = :product WHERE id = :host`.

   A host whose users sign in with a provider Opspile trusts can instead forward their token
   ([User tokens](#user-tokens)). Register it with the provider and **no** assertion keys; a host
   uses one mode or the other, and the database refuses a host with both.

   **For a user-token host, steps 4 and 5 are done in the inbox:** whoever signs in and is not
   enrolled becomes an [access request](#access-requests) that the admin team approves. The SQL
   below is for assertion hosts, and for what an approval refuses (a suspended channel, a
   revoked member).

4. Map the host's stable tenant ID (for a user-token host, the provider's organization ID, such
   as `0123456789ABCDEF01234567@AdobeOrg`) to an approved customer key and a channel name of your choice.
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
token, unless the host registered its provider ([User tokens](#user-tokens)). Sign a new assertion on each attempt, including retries. Example backend adapter for one
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

## User tokens

A host can opt in, per registration, to forward the token its user signed in with instead of
signing an assertion. The provider, not the host, then names the tenant, subject and email. The
Access service credentials stay the host's identity in every case: a user token without them, or
sent through a host that did not register this provider and client, is refused (`401`). Adobe IMS
is the only provider so far (`src/portal/integration-identity.js`).

```sql
-- Fictional values. An IMS host has no assertion keys; its issuer is the provider's.
INSERT INTO integration_hosts(id, service_id, issuer, jwks, scopes, identity)
  VALUES ('panel-prod', :access_client_id, 'https://ims-na1.adobelogin.com', '{"keys":[]}',
    '["threads:create","threads:read","threads:reply","changes:read"]', json(:identity));
```

```json
{
  "provider": "adobe-ims",
  "environment": "prod",
  "issuer": "https://ims-na1.adobelogin.com",
  "keys": "https://ims-na1.adobelogin.com/ims/keys",
  "clientIds": ["example-support-panel"],
  "tenant": "profile.ownerOrg",
  "subject": "token.user_id",
  "email": "profile.email"
}
```

- `environment` is `prod` (`ims-na1`) or `stg1` (`ims-na1-stg1`); `issuer` and `keys` must be
  that environment's, so a registration cannot point at another key source. Register a separate
  host (and service token) per environment: a token of one is refused by the other.
- `clientIds` are the IMS clients the host's sign-in uses; IMS access tokens have no audience, so
  the token's `client_id` is checked against them. Prefer one client per host.
- `tenant`, `subject` and `email` are the only mappings so far: the profile's `ownerOrg`, the
  token's `user_id` (which must equal the profile's `userId`), and the profile's `email` when
  `emailVerified` (or `null`, so that only members enrolled without an alias can authorize).
- Anything else in the object, or a value not listed here, makes the host authorize nobody.

**Verification.** The token must be an RS256 JWT signed by one of the environment's own
`ims_na1[-stg1]-key-*` keys from `/ims/keys` (the legacy `ims` key both environments publish is
never used), with `type: "access_token"`, the environment's `as`, no other `iss`, an accepted
`client_id`, a `user_id`, and `created_at + expires_in` (milliseconds) still ahead. Opspile then
reads `/ims/profile/v1` with the token: a `401`/`403` there means the token is revoked (`401`), a
network error, other status or a body that is not JSON means IMS is unavailable (`503`), never
`401`. Keys are kept an hour (refetched at most once a minute for a new `kid`), a verified token
up to five minutes (never past its expiry) and a profile one minute, in bounded caches keyed by
the token's SHA-256. A revocation therefore takes effect within a minute. Tokens are never logged
or stored.

**The organization.** IMS user access tokens carry no organization claim. Its reliable source is
the profile's `ownerOrg`: the organization owning the profile the user chose at sign-in (an
Enterprise, Federated or Business ID). Someone in several organizations has a profile per
organization, and the sign-in is where they pick one; each has its own `user_id`, so it is a
different subject. Memberships listed by `/ims/organizations` (an Adobe ID added to other
organizations, administrators of several) never choose the tenant: nothing the host sends can
choose among them. The list is only read for the name of the `ownerOrg` itself, on an
[access request](#access-requests). A profile without `ownerOrg` (a personal Adobe ID, or a sign-in without the
`additional_info.ownerOrg` scope) gets `403 not_enrolled`. With Directory Trust the owner is the
organization that owns the directory; enroll that one.

**Request headers.** The same as with assertions, except the bearer token:

| Header | Value |
| --- | --- |
| `CF-Access-Client-Id`, `CF-Access-Client-Secret` | The host's service token for this environment. |
| `Authorization` | `Bearer <the user's IMS access token>`, as issued; sign-in scopes at least `AdobeID,openid,additional_info.ownerOrg`, and `read_organizations` for the organization's name on an access request. |
| `Content-Type` | `application/json` on `POST` and `PUT`. |
| `Idempotency-Key` | On both `POST`s, as below. |

```js
// Fictional backend of a user-token host. It sends no tenant, organization or subject.
async function listRequests(imsAccessToken) {
  const path = '/integrations/portal/v1/threads';
  return fetch(new URL(path, config.portalOrigin), {
    redirect: 'error', headers: {
      'CF-Access-Client-Id': config.serviceId, 'CF-Access-Client-Secret': config.serviceSecret,
      Authorization: `Bearer ${imsAccessToken}`,
    },
  });
}
```

There is no mode header: the registration decides. Tenant, organization, subject or email headers
are ignored. Retries send the same token and the original `Idempotency-Key`; Opspile counts each
admitted operation for the rate limits itself. Unlike an assertion, a user token is not bound to
one request or single-use: only the host's backend, with its service credentials, can present it.
On `401`, have the user sign in again; on `503`, back off and keep the session.

## Access requests

A host with an identity provider ([User tokens](#user-tokens)) needs no SQL per person: a caller
the provider verified, of a host that allows the operation, who is not enrolled, **asks for
access by calling**. The portal records one request per `(host, tenant, subject)` and answers
`403 not_enrolled` with the request's state (below). The inbox's admin team (the people who open
the portal's lobbies) sees it in its inbox, as a thread of *Integration access*, with the host
and its product, the organization's name and ID, the person's name, verified email and IMS user
ID, and when they first asked. They decide it there (or with the admin API, README):

- **Approve, new organization.** The organization has no channel on this host. The admin names
  the channel (suggested: `<product>-<customer>`; see below), the customer and the team. The
  portal reserves the channel, disabled. The inbox creates the customer and files the channel
  by hand (the manual rules of step 4: source `portal`, field `channel_id`,
  `^<reserved ID>$`, priority 10, one for the team and one for the org). Only then is the person
  enrolled and the channel enabled. If filing fails, nobody is enrolled. The channel stays
  reserved, and approving again finishes it.
- **Approve, known organization.** The organization has an enabled channel on this host already
  (made by an approval or by hand). The person is enrolled in it. Nothing else changes, and its
  routing stays as it was.
- **Decline**, with an optional reason. The person's host is told the reason (below), so write
  it for them. After 30 days, their next call opens the request again.

Enrollment keeps the rules of step 5: an approval enrolls the request's own subject only, as a
new actor without an email (the subject is the provider's user ID). It never links an ordinary
portal user, staff or bot, and records who approved it (`integration_members.approved_by`,
`integration_requests.decided_by`). A subject with a member row of any state (revoked, or
enrolled under another verified email) is not captured. Neither is a channel that was enabled
and suspended since, or that an operator reserved by hand and has not enabled. Those stay with
an operator, as before.

**What is recorded.** The provider's display name, the email only when the provider says it is
verified, the tenant (the IMS organization ID) and the organization's name. The name comes from
`GET /ims/organizations/v6` with the user's token, only from the entry whose `orgRef` is the
tenant. It needs the `read_organizations` sign-in scope; without the scope, or when IMS does not
answer within three seconds, the name is left empty. Each organization's name is kept a day (a
miss ten minutes) in a bounded cache, and the response is read up to 256 KB. Tokens are never
stored. A request is refreshed at most every 15 minutes. At most 1,000 requests wait per host,
100 per tenant, and 120 new ones per host and hour. Beyond that nothing is recorded, and the
error says so (no `request`). Decided requests, and pending ones not repeated for 180 days, are
pruned.

**Assertion hosts** don't capture: the host names its users itself, and its operator enrolls them
as in steps 4 and 5. Capture is for providers Opspile verifies.

**The suggested name.** The customer part is kept short, because IMS names are often long
(`Paper Mill International Holdings Inc. - Marketing (Prod)`). It is built from the part before
` - `, `:`, `|` or `(`, without legal forms and filler words, from the first words that fit in
20 characters (`paper-mill`). When the verified email's domain gives a company name no longer
than that (`ada@mill.example` gives `mill`; public mail providers give nothing), the inbox
suggests that instead. A customer the inbox already knows (by that domain, slug or name) is
suggested as the customer.

**The error body.** `403` keeps the code `not_enrolled`, so a host that knows only the code
still works:

| Body | Meaning |
| --- | --- |
| `{"error":{"code":"not_enrolled","request":"pending"}}` | Recorded (or refreshed), waiting for approval. |
| `{"error":{"code":"not_enrolled","request":"declined","reason":"…"}}` | Declined; `reason` only when the admin gave one (plain text, for the person). |
| `{"error":{"code":"not_enrolled"}}` | Nothing recorded: an assertion host, a scope the host lacks, a profile without `ownerOrg`, a member row (revoked or another email), or the bounds reached. |

Once approved, the person's next call is admitted as any member's.

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
  topics by default. The portal root is title, optional topic and body separated by blank lines;
  a body that is the title again (`body.trim() === title.trim()`, a one-line request) is left out.
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
invalid_assertion` (also a user token refused), `403 not_enrolled` (including scope denial and
a user without an organization; for a user-token host it may say an
[access request](#access-requests)'s `request` and `reason`), `404 not_found` (including a
foreign object), `409 key_conflict`, `410 cursor_expired`, `429 rate_limited`, `503 unavailable`.
The pilot allows 60 admitted operations/minute per viewer, 600 per channel and 6,000 per host.
Honor `Retry-After` on 429; back off with jitter on transient failures. Use a **fresh assertion**
(or the same user token) and the **original operation key** when retrying a write. Never log credentials or message text.
