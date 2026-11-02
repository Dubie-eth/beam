import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_TRANSACTION_BYTES, encodeCompactU16, decodeCompactU16,
  compileLegacyMessage, serializeLegacyMessage, decodeLegacyMessage,
  requiredSigners, signedTransactionSize, assertFitsPacket,
} from './beam-message.mjs';
import { buildBuy, buildSell, PROGRAM_ID } from './beam-native.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/messages.json', import.meta.url)));
const native = JSON.parse(readFileSync(new URL('./fixtures/native-sol.json', import.meta.url)));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (text) => Uint8Array.from(Buffer.from(text, 'hex'));

const inputOf = (c) => ({
  feePayer: c.feePayer,
  recentBlockhash: fixture.recentBlockhash,
  instructions: c.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys, data: fromHex(ix.dataHex) })),
});

test('compiled messages match @solana/web3.js golden bytes for every fixture case', () => {
  for (const [name, c] of Object.entries(fixture.cases)) {
    const message = compileLegacyMessage(inputOf(c));
    assert.deepEqual(message.header, c.expected.header, `${name} header`);
    assert.deepEqual(message.accountKeys, c.expected.accountKeys, `${name} account keys`);
    assert.deepEqual(
      message.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, dataHex: hex(ix.data) })),
      c.expected.instructions, `${name} compiled instructions`,
    );
    assert.equal(hex(serializeLegacyMessage(message)), c.expected.messageHex, `${name} serialized bytes`);
  }
  assert.equal(Object.keys(fixture.cases).length, 4);
});

test('fee payer is account 0 and a writable signer even when no instruction names it', () => {
  const c = fixture.cases.buyForeignPayer;
  const message = compileLegacyMessage(inputOf(c));
  assert.equal(message.accountKeys[0], c.feePayer);
  assert.equal(message.header.numRequiredSignatures, 2);
  assert.deepEqual(requiredSigners(message), [c.feePayer, native.buy.accounts.user]);
});

test('duplicate accounts across instructions are merged with the union of their privileges', () => {
  const buy = buildBuy(native.buy.accounts, native.buy.args);
  const sell = buildSell(native.sell.accounts, native.sell.args);
  // tokenProgram is readonly in both; make it writable in one use and check the merged flag.
  const sellWritableToken = { ...sell, keys: sell.keys.map((k) => (k.pubkey === native.sell.accounts.tokenProgram ? { ...k, isWritable: true } : k)) };
  const message = compileLegacyMessage({
    feePayer: native.buy.accounts.user, recentBlockhash: fixture.recentBlockhash, instructions: [buy, sellWritableToken],
  });
  const writableEnd = message.header.numRequiredSignatures
    + (message.accountKeys.length - message.header.numRequiredSignatures - message.header.numReadonlyUnsignedAccounts);
  const tokenIndex = message.accountKeys.indexOf(native.sell.accounts.tokenProgram);
  assert.ok(tokenIndex >= message.header.numRequiredSignatures && tokenIndex < writableEnd, 'merged key lands in the writable non-signer block');
  assert.equal(new Set(message.accountKeys).size, message.accountKeys.length, 'no duplicate account keys');
  assert.equal(message.accountKeys.indexOf(PROGRAM_ID) >= 0, true, 'program id is an account key');
});

test('serialized bytes decode back to the compiled message', () => {
  for (const c of Object.values(fixture.cases)) {
    const message = compileLegacyMessage(inputOf(c));
    const bytes = serializeLegacyMessage(message);
    const decoded = decodeLegacyMessage(bytes);
    assert.deepEqual(decoded.header, message.header);
    assert.deepEqual(decoded.accountKeys, message.accountKeys);
    assert.equal(decoded.recentBlockhash, message.recentBlockhash);
    assert.deepEqual(decoded.instructions.map((ix) => ({ ...ix, data: hex(ix.data) })),
      message.instructions.map((ix) => ({ ...ix, data: hex(ix.data) })));
  }
});

test('decoder rejects versioned, truncated, inconsistent and padded input', () => {
  const bytes = serializeLegacyMessage(compileLegacyMessage(inputOf(fixture.cases.buy)));
  assert.throws(() => decodeLegacyMessage(Uint8Array.from([0x80, ...bytes.subarray(1)])), /versioned/);
  assert.throws(() => decodeLegacyMessage(bytes.subarray(0, bytes.length - 5)), /truncated/);
  assert.throws(() => decodeLegacyMessage(Uint8Array.from([...bytes, 0])), /trailing/);
  const badHeader = Uint8Array.from(bytes);
  badHeader[1] = badHeader[0] + 1; // more readonly signers than signers
  assert.throws(() => decodeLegacyMessage(badHeader), /header is inconsistent/);
  assert.throws(() => decodeLegacyMessage('not bytes'), TypeError);
});

test('compact-u16 matches the Solana short-vec encoding', () => {
  for (const [value, bytes] of [[0, '00'], [1, '01'], [127, '7f'], [128, '8001'], [16383, 'ff7f'], [16384, '808001'], [65535, 'ffff03']]) {
    assert.equal(hex(encodeCompactU16(value)), bytes);
    assert.deepEqual(decodeCompactU16(fromHex(bytes)), { value, size: bytes.length / 2 });
  }
  assert.throws(() => encodeCompactU16(65536), RangeError);
  assert.throws(() => encodeCompactU16(-1), RangeError);
  assert.throws(() => decodeCompactU16(fromHex('808080')), /more than 3 bytes/);
});

test('inputs are validated before any bytes are produced', () => {
  const base = inputOf(fixture.cases.buy);
  assert.throws(() => compileLegacyMessage({ ...base, feePayer: 'nope' }), /feePayer/);
  assert.throws(() => compileLegacyMessage({ ...base, recentBlockhash: 'abc' }), RangeError);
  assert.throws(() => compileLegacyMessage({ ...base, instructions: [] }), /non-empty/);
  assert.throws(() => compileLegacyMessage({ ...base, instructions: [{ ...base.instructions[0], data: 'ff' }] }), /Uint8Array/);
  assert.throws(() => compileLegacyMessage({
    ...base, instructions: [{ ...base.instructions[0], keys: [{ pubkey: PROGRAM_ID, isSigner: 'yes', isWritable: true }] }],
  }), /boolean/);
  const tooMany = Array.from({ length: 257 }, (_, i) => {
    const key = new Uint8Array(32); key[0] = i & 0xff; key[1] = i >> 8;
    return { pubkey: encodeBase58(key), isSigner: false, isWritable: false };
  });
  assert.throws(() => compileLegacyMessage({ ...base, instructions: [{ ...base.instructions[0], keys: tooMany }] }), /at most 256/);
});

test('packet-size helpers count signatures and refuse oversized transactions', () => {
  const message = compileLegacyMessage(inputOf(fixture.cases.buy));
  const expected = 1 + 64 * message.header.numRequiredSignatures + serializeLegacyMessage(message).length;
  assert.equal(signedTransactionSize(message), expected);
  assert.equal(assertFitsPacket(message), expected);
  const padded = { ...message, instructions: [{ ...message.instructions[0], data: new Uint8Array(MAX_TRANSACTION_BYTES) }] };
  assert.throws(() => assertFitsPacket(padded), /limit is 1232/);
});

// Local base58 for the synthetic 257-key case only (beam-native exports the same alphabet logic).
function encodeBase58(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let result = '';
  while (n > 0n) { result = ALPHABET[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = `1${result}`; }
  return result;
}
