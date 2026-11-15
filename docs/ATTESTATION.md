# Work Receipt attestation format

Signed Work Receipts write `receipt.intoto.json`: an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) inside a [DSSE envelope](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md), signed with the receipt author's Ed25519 key.

## v0.2

Predicate type: `https://github.com/iamGodofall/work-receipts/blob/main/docs/ATTESTATION.md#v0.2`

- **Envelope:** `payloadType` is `application/vnd.in-toto+json`. The signature is Ed25519 over the DSSE pre-authentication encoding of the payload. `keyid` is the key fingerprint: the first 16 bytes of SHA-256 over the DER SubjectPublicKeyInfo, in hex groups of four.
- **Subject:** one entry, `{ "name": "work-tree", "digest": { "gitTree": "<tree id>" } }`. The tree id is the git tree hash of the code the acceptance checks ran against: what `git add -A` would commit, minus gitignored files and the `.receipts` folder. No attestation is produced when the receipt could not identify its code.

| Predicate field | Meaning |
| --- | --- |
| `verdict` | `verified`, `checks_failed`, `out_of_scope`, `unverified`, or `tampered`, computed by code from the evidence |
| `verdictReason` | Human-readable reason for the verdict |
| `recorderVersion` | Version of the logic that computed the receipt |
| `sessionId`, `generatedAt` | Session identifier and generation time |
| `goal`, `contractDigest` | Contract goal and SHA-256 over the canonical contract |
| `eventLog` | `{ intact, events, headHash }` of the hash-chained session log |
| `checks[]` | `{ id, command, status, exitCode, outputDigest, checkedAt }` for each acceptance check |
| `scope` | `{ filesChanged, outOfScope[], checkInputsChanged[] }` from git |
| `receiptBundleDigest` | SHA-256 of the full evidence bundle (`receipt.json`), tying the attestation to it |
| `headCommit` | Commit checked out when the receipt was generated, if any |
| `authorship` | `{ agentLines, otherLines }`, or `null` when not measured |
| `signer` | `{ algorithm: "ed25519", publicKey, fingerprint }` |

## Verifying

```bash
node plugin/bin/cli.js verify-attestation receipt.intoto.json --expect-key <fingerprint> --tree <commit>
```

`signer.publicKey` is self-asserted, so trust comes only from pinning: `--expect-key` (the author's published fingerprint) or `--key <public.pem>`. An envelope checked without pinning exits with status 3 (intact, but anyone could have made it). Independent check with OpenSSL: rebuild the pre-authentication encoding `DSSEv1 <len(type)> <type> <len(payload)> <payload>` and run `openssl pkeyutl -verify -pubin -inkey key.pem -rawin -in pae.bin -sigfile sig.bin`.

The attestation proves which key signed which verdict for which tree. It does not prove the recorded check results were truthful; see the limitations printed on every receipt.
