# Files and uploads

Verified against `main` at 2026-08-27.

## Shape

Server side: `services/upload_pipeline.go` is the shared path; the per-surface services
(`upload_service.go`, `dm_upload_service.go`, `feedback_upload_service.go`,
`report_upload_service.go`, `server_report_upload_service.go`) go through it.
`storage_service.go` owns disk, `file_cleanup_service.go` + `cleanup_service.go` own deletion,
`file_url_signer.go` owns egress signing.

Supporting packages: `pkg/files` (`locator.go`, `safemime.go`), `pkg/fileacl`, `pkg/signedurl`,
`pkg/antivirus` (`clamav.go`, `breaker.go`).

`refactor(uploads): two upload loops instead of six copies` (08-02) collapsed duplicated per-surface
loops — if you are adding a surface, use the pipeline, do not copy a loop.

## Layout and path safety

Per-type upload directories with **centralised path validation** (`pkg/fileacl`,
`feat(files): per-type upload dirs and centralized path validation`, 05-04). Directory listing is
blocked on `/api/uploads` and `/static/landing`.

`UPLOAD_DIR` and `UPLOAD_MAX_SIZE` come from config; the client limit must match the server's —
`fix(upload): align client limit with the server and stop silent drops` exists because it did not,
and oversize files were dropped without telling anyone.

`pkg/files/safemime.go` does MIME safe-serve: the stored extension decides the served type. **A file
stored without a real extension serves as `application/octet-stream`, and cross-origin `<img>` loads
are then blocked** — this bit the thumbnail work specifically.

## Quota

Per-user byte quota (`MQVI_DEFAULT_QUOTA_BYTES`), a running counter, with disk cleanup on delete
(`feat(storage): per-user upload quota with disk cleanup on delete`, 05-05).

Because it is a **running counter rather than a computed sum**, every path that stores or removes
bytes must adjust it, and a failure to release must not be silently swallowed —
`fix(uploads): report failed quota releases instead of dropping them` (08-02).

## Antivirus

ClamAV, via **unix socket** (`MQVI_CLAMAV_ADDR`, e.g. `unix:/run/clamav/clamd.ctl`), before storage.

Behaviour is fully configurable and the policies matter:

| Setting | Meaning |
|---|---|
| `MQVI_ANTIVIRUS_ENABLED` | master switch |
| `MQVI_ANTIVIRUS_TIMEOUT_SECONDS` | per-scan timeout (10) |
| `MQVI_ANTIVIRUS_MAX_SCAN_SIZE_MB` | above this, the too-large policy applies (25) |
| `MQVI_ANTIVIRUS_TOO_LARGE_POLICY` | `skip_with_log` by default |
| `MQVI_ANTIVIRUS_UNAVAILABLE_POLICY` | `allow_with_log` by default |
| `MQVI_ANTIVIRUS_CLEAN_CACHE_TTL_HOURS` / `INFECTED_CACHE_TTL_DAYS` | result caching (24h / 30d) |
| `MQVI_ANTIVIRUS_CIRCUIT_*` | failure threshold 3, window 30s, open 10s |

The **circuit breaker** (`pkg/antivirus/breaker.go`, generic breaker in `pkg/breaker`) stops a dead
clamd from turning every upload into a 10-second stall. Note the default `UNAVAILABLE_POLICY` is
*allow*, so a broken scanner degrades to unscanned uploads rather than a broken product — that is a
deliberate availability-over-strictness choice and worth re-confirming before claiming uploads are
always scanned.

Coded errors reach the client so it can explain itself: `upload_infected`,
`upload_scan_unavailable`, `upload_too_large_scan`, `upload_too_large`.

**Thumbnails are scanned too** (2026-07-21 decision) — a client-generated thumbnail is untrusted
input like any other upload.

## Thumbnails

Decision: 2026-07-21, "Chat attachment thumbnails: storage, signing and quota".

Every chat attachment stores a **companion thumbnail as a separate file**, with `thumb_url`, pixel
dimensions and `thumb_size` on the attachment row. Generated **on the client** — there is no
server-side image pipeline in this deployment.

Three properties, each learned the hard way:

1. **The thumbnail must be signed at every egress the original is.** The file endpoint is
   signature-gated, so an unsigned `thumb_url` 401s on every cross-origin client (Electron, mobile)
   while working fine on same-origin web.
2. **It needs a real extension**, or it serves as `application/octet-stream` and cross-origin
   `<img>` is blocked.
3. **It is charged to the uploader's quota**, capped at 5 MB. An uncharged thumbnail is an unmetered
   store — send a trivial file with a huge "thumbnail" and pay nothing. `thumb_size` is persisted
   rather than recomputed precisely so delete and orphan cleanup can give the bytes back.

Video attachments get a **poster frame** so the message list fetches no video bytes; on iOS the
poster is extracted **natively** because HEVC would otherwise yield nothing
(`feat(ios): extract video posters natively so iPhone HEVC gets a frame`).

## Upload transport (client)

Decision: 2026-07-20, "XMLHttpRequest for multipart uploads, fetch for everything else".

`uploadRequest()` lives in `client/src/api/client.ts` next to `apiClient`. **All 16 multipart call
sites use XHR; every JSON request stays on `fetch`.**

Reason: the Fetch API has **no upload progress event** — a spec-level gap. `xhr.upload.onprogress`
plus `xhr.abort()` is the only transport giving byte-level progress and a cancel that actually stops
the request. `fetch` with a `ReadableStream` body was rejected as Chromium-only, HTTP/2-dependent
and proxy-hostile, and this app sits behind Cloudflare.

**The cost, and it is a live regression risk:** auth behaviour — Bearer header, credentials, the 401
refresh-and-retry, the `APIResponse` envelope — is now implemented **twice**. Change one without the
other and uploads silently diverge from the rest of the API.

Related: **HTTP/3 (QUIC) is disabled at Cloudflare** (2026-07-20 decision) — read that entry before
re-enabling it.

## Deletion and cleanup

Soft delete with 30-day recovery for accounts and servers; tombstone hard-delete preserves message
history. An **embedded daily cleanup worker** handles soft-delete TTL, orphan files and disk-delete
retries.

**Trap:** the orphan sweep once deleted files it had no source record for
(`fix(cleanup): stop the orphan sweep deleting files it has no source for`, 07-14). A sweep that
deletes on *absence of evidence* is the wrong default; `services/cleanup_orphan_test.go` guards it.

## Viewer

In-app overlay viewer for image / video / audio / pdf / docx / xlsx
(`feat(client): in-app overlay viewer…`, 05-13). Report and feedback attachments open in it too.
Electron copies images via the native clipboard.

## Things to check when touching this area

- Does the change adjust the quota counter on **both** the store and the release path?
- Is the new URL signed **at egress**, not stored signed? (1-hour TTL — see
  `auth-and-permissions.md`.)
- Does the stored file have a real extension?
- If it is client-supplied, is it scanned?
- If it is a new multipart call site, does it use `uploadRequest()` rather than `fetch`?
