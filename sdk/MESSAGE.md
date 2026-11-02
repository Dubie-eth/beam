# Unsigned legacy message compiler

Lane baseline: Beam main `c707f30`.
This lane owns `beam-message.mjs`, its tests and `fixtures/messages.json`. It
compiles the instruction objects that `beam-native.mjs` already returns into
the bytes of an unsigned legacy Solana `Message`, and parses those bytes back.
It does not change the Anchor program, archives, economics, program identity,
website, PDA derivation (PR #45), quotes (PR #46) or the local-bank runtime
tests (PR #47).

## Interface

- `compileLegacyMessage({ feePayer, recentBlockhash, instructions })` returns
  `{ header, accountKeys, recentBlockhash, instructions }`. Each compiled
  instruction is `{ programIdIndex, accountKeyIndexes, data }`. Instructions are
  the `{ programId, keys, data }` objects produced by `buildCreate`,
  `buildCreateV2`, `buildBuy` and `buildSell`, or any object of that shape.
- `serializeLegacyMessage(message)` returns the exact bytes a signer would sign.
- `decodeLegacyMessage(bytes)` parses legacy message bytes back into the
  compiled shape and rejects versioned (`0x80` prefix), truncated, padded and
  header-inconsistent input.
- `requiredSigners(message)` lists the keys that must sign, fee payer first.
- `signedTransactionSize(message)` and `assertFitsPacket(message)` size the
  eventual wire transaction (signature count + 64 bytes per signature + message)
  against the 1232-byte packet limit.
- `encodeCompactU16` / `decodeCompactU16` implement Solana's short-vec length
  prefix and are exported for tests.

Account ordering follows the rule implemented by `@solana/web3.js` 1.98.0
`Transaction.compileMessage()`: every instruction key and every distinct
program id is collected, duplicates are merged with the union of their
signer/writable flags, keys are sorted signers-first then writable-first then
by base58 string (`localeCompare('en', { caseFirst: 'lower', … })`), and the fee
payer is moved to index 0 as a writable signer, added if absent. Header counts
are derived from that order. A message may reference at most 256 accounts
because instruction indexes are `u8`.

## Evidence

`fixtures/messages.json` was produced by `tools/generate-message-fixtures.mjs`
running the real `@solana/web3.js` 1.98.0 `Transaction.compileMessage()` over
the SDK's own `buildBuy`, `buildSell` and `buildCreate` outputs built from
`fixtures/native-sol.json`, with a synthetic blockhash. The repository keeps
no web3.js dependency; the generator loads it from `NODE_PATH` only when the
fixture is regenerated. Four cases cover a single instruction, two
instructions sharing accounts (de-duplication and privilege merging), a fee
payer that no instruction names, and a two-signer `create`. The tests assert
header, account order, compiled indexes and serialized bytes against those
goldens, round-trip through the decoder, check compact-u16 vectors and input
validation, and refuse an oversized transaction.

```sh
node --test sdk/beam-message.test.mjs
```

## Boundary

No key material, signing, RPC, blockhash fetch, fee estimation, simulation or
sending exists here; a real client supplies a live blockhash and signs the
serialized bytes elsewhere. Versioned (v0) messages and address lookup tables
are not supported. The compiler does not validate that the instruction's
accounts are correct for the program — PDA/ATA derivation and account
discovery belong to PR #45 and the IDL work in PR #39 — so a byte-exact message
over wrong accounts is still a wrong transaction. The development program ID
is not deployed; fixtures use synthetic keys and are never transaction examples.
