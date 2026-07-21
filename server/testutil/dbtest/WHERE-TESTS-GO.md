# Which layer catches which bug

Every entry below is a defect this codebase actually shipped. The point of the list is that the next
one of its kind fails a test instead of a review round.

| Class | Caught by | Example it would have caught |
|---|---|---|
| A write that never persists a field | repository round-trip (`sqlite_attachment_test.go`) | an encrypted edit assigned ciphertext on the struct while the UPDATE wrote only `content` |
| Two reads of one table drifting apart | batch read asserted against single read | a column added to `GetByMessageID` and not to `GetByMessageIDs` |
| A URL served unsigned | egress guard (`egress_signing_test.go`) | `thumb_url` signed nowhere, so every thumbnail 401'd cross-origin |
| A model gaining a URL field nobody signs | reflection over `*URL` fields | the same bug, next time, automatically |
| Channel and DM drifting apart | paired assertions across both models | `thumb_url` signed for channels only; DM delete leaving the thumbnail behind |
| A policy applied on one path and not its sibling | per-path table (`encryption_policy_test.go`) | encryption enforced on create, open on edit |
| Quota charged and never released | ledger balance (`quota_ledger_test.go`) | thumbnails charged at upload, not released on delete |
| Schema drift | real migrations in every DB test | tests passing against a hand-written table nothing else had |
| A trigger keyed on an assumption that changed | migration tests | FTS keyed on the old encryption version, so a converted message left the index |
| Client assuming "unknown" means "off" | store selector tests | plaintext sent to a server whose E2EE flag had not loaded |
| A translation added to one language | `i18n/parity.test.ts` | keys shipped in EN only; a duplicate key shadowing an earlier one |
| A primitive with a falsy-value bug | utility tests | `throw null` read as "no failure", resolving with a hole in the results |
| A race | `go test -race` in CI | nothing yet — which is the point of running it every push |

## Where a new test belongs

Ask what would have to break for the bug to reach a user, and test at that layer:

- **It would be wrong in the database** → repository test with `dbtest`.
- **It would be wrong on the wire** → service test asserting the payload.
- **It would be wrong only for one of channel/DM** → assert both in the same test.
- **It would be wrong because a rule was forgotten somewhere** → a table over the places the rule
  applies, so a new place with no row is visible.
- **It is a pure function** → direct table-driven test, including the falsy inputs.

If a fix has no test, say so in the change rather than letting it look covered.
