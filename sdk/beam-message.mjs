// Development-only, dependency-free compiler from Beam SDK instructions to an
// unsigned legacy Solana `Message`. Construction is kept separate from
// signing and sending: nothing here holds a key, signs, or talks to an RPC.
//
// The account ordering, privilege merging and header rules reproduce
// `Transaction.compileMessage()` from @solana/web3.js 1.98.0, and the golden
// bytes in fixtures/messages.json were produced by that implementation (see
// tools/generate-message-fixtures.mjs). Versioned (v0) messages with address
// lookup tables are out of scope.

import { decodeBase58Pubkey, encodeBase58Pubkey } from './beam-native.mjs';

/** Solana packet payload limit; a serialized transaction may not exceed it. */
export const MAX_TRANSACTION_BYTES = 1232;
const SIGNATURE_BYTES = 64;
const MAX_ACCOUNT_KEYS = 256; // instruction account indexes are u8
const MAX_COMPACT_U16 = 0xffff;

const SORT_OPTIONS = {
  localeMatcher: 'best fit', usage: 'sort', sensitivity: 'variant',
  ignorePunctuation: false, numeric: false, caseFirst: 'lower',
};

function concat(parts) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function encodeCompactU16(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COMPACT_U16) {
    throw new RangeError('compact-u16 value must be an integer in 0..65535');
  }
  const out = [];
  let rem = value;
  for (;;) {
    let byte = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) { out.push(byte); break; }
    byte |= 0x80;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

export function decodeCompactU16(bytes, offset = 0) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= bytes.length) throw new RangeError('truncated compact-u16');
    const byte = bytes[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size === 3) throw new RangeError('compact-u16 uses more than 3 bytes');
  }
  if (value > MAX_COMPACT_U16) throw new RangeError('compact-u16 value exceeds 65535');
  return { value, size };
}

function pubkey(value, name) {
  try { return encodeBase58Pubkey(decodeBase58Pubkey(value)); }
  catch (error) { throw new TypeError(`${name} must be a base58 32-byte public key: ${error.message}`); }
}

function blockhash(value) {
  if (typeof value !== 'string') throw new TypeError('recentBlockhash must be a base58 string');
  const bytes = decodeBase58Pubkey(value); // also 32 bytes
  return { text: encodeBase58Pubkey(bytes), bytes };
}

function checkInstruction(ix, index) {
  if (ix === null || typeof ix !== 'object') throw new TypeError(`instructions[${index}] must be an object`);
  if (!Array.isArray(ix.keys)) throw new TypeError(`instructions[${index}].keys must be an array`);
  if (!(ix.data instanceof Uint8Array)) throw new TypeError(`instructions[${index}].data must be a Uint8Array`);
  const programId = pubkey(ix.programId, `instructions[${index}].programId`);
  const keys = ix.keys.map((meta, k) => {
    if (meta === null || typeof meta !== 'object') throw new TypeError(`instructions[${index}].keys[${k}] must be an object`);
    if (typeof meta.isSigner !== 'boolean' || typeof meta.isWritable !== 'boolean') {
      throw new TypeError(`instructions[${index}].keys[${k}] needs boolean isSigner and isWritable`);
    }
    return { pubkey: pubkey(meta.pubkey, `instructions[${index}].keys[${k}].pubkey`), isSigner: meta.isSigner, isWritable: meta.isWritable };
  });
  return { programId, keys, data: ix.data };
}

/**
 * Compile instructions into an unsigned legacy message.
 *
 * @param {{feePayer: string, recentBlockhash: string, instructions: Array<{programId: string,
 *   keys: Array<{pubkey: string, isSigner: boolean, isWritable: boolean}>, data: Uint8Array}>}} input
 * @returns {{header: {numRequiredSignatures: number, numReadonlySignedAccounts: number,
 *   numReadonlyUnsignedAccounts: number}, accountKeys: string[], recentBlockhash: string,
 *   instructions: Array<{programIdIndex: number, accountKeyIndexes: number[], data: Uint8Array}>}}
 */
export function compileLegacyMessage({ feePayer, recentBlockhash, instructions } = {}) {
  const payer = pubkey(feePayer, 'feePayer');
  const hash = blockhash(recentBlockhash);
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new TypeError('instructions must be a non-empty array');
  }
  const checked = instructions.map(checkInstruction);

  // 1. Collect metas in instruction order, then every distinct program id as a readonly non-signer.
  const metas = [];
  const programIds = [];
  for (const ix of checked) {
    for (const key of ix.keys) metas.push({ ...key });
    if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
  }
  for (const id of programIds) metas.push({ pubkey: id, isSigner: false, isWritable: false });

  // 2. De-duplicate, merging privileges (a key is a signer/writable if any use says so).
  const unique = [];
  for (const meta of metas) {
    const existing = unique.find((u) => u.pubkey === meta.pubkey);
    if (existing) {
      existing.isSigner ||= meta.isSigner;
      existing.isWritable ||= meta.isWritable;
    } else {
      unique.push(meta);
    }
  }

  // 3. Signers first, then writable, then base58 order within a group (web3.js 1.98 rule).
  unique.sort((x, y) => {
    if (x.isSigner !== y.isSigner) return x.isSigner ? -1 : 1;
    if (x.isWritable !== y.isWritable) return x.isWritable ? -1 : 1;
    return x.pubkey.localeCompare(y.pubkey, 'en', SORT_OPTIONS);
  });

  // 4. The fee payer is always account 0, a writable signer.
  const payerIndex = unique.findIndex((u) => u.pubkey === payer);
  const payerMeta = payerIndex >= 0 ? unique.splice(payerIndex, 1)[0] : { pubkey: payer };
  unique.unshift({ pubkey: payerMeta.pubkey, isSigner: true, isWritable: true });

  if (unique.length > MAX_ACCOUNT_KEYS) {
    throw new RangeError(`message references ${unique.length} accounts; legacy messages index at most ${MAX_ACCOUNT_KEYS}`);
  }

  let numRequiredSignatures = 0;
  let numReadonlySignedAccounts = 0;
  let numReadonlyUnsignedAccounts = 0;
  for (const meta of unique) {
    if (meta.isSigner) {
      numRequiredSignatures += 1;
      if (!meta.isWritable) numReadonlySignedAccounts += 1;
    } else if (!meta.isWritable) {
      numReadonlyUnsignedAccounts += 1;
    }
  }

  const accountKeys = unique.map((u) => u.pubkey);
  const indexOf = (key) => accountKeys.indexOf(key);
  return {
    header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
    accountKeys,
    recentBlockhash: hash.text,
    instructions: checked.map((ix) => ({
      programIdIndex: indexOf(ix.programId),
      accountKeyIndexes: ix.keys.map((key) => indexOf(key.pubkey)),
      data: ix.data,
    })),
  };
}

/** Serialize a compiled legacy message to the bytes that would be signed. */
export function serializeLegacyMessage(message) {
  const { header, accountKeys, recentBlockhash, instructions } = message;
  if (accountKeys.length > MAX_ACCOUNT_KEYS) throw new RangeError('too many account keys');
  const parts = [
    Uint8Array.from([header.numRequiredSignatures, header.numReadonlySignedAccounts, header.numReadonlyUnsignedAccounts]),
    encodeCompactU16(accountKeys.length),
    ...accountKeys.map((key) => decodeBase58Pubkey(key)),
    decodeBase58Pubkey(recentBlockhash),
    encodeCompactU16(instructions.length),
  ];
  for (const ix of instructions) {
    for (const index of [ix.programIdIndex, ...ix.accountKeyIndexes]) {
      if (!Number.isInteger(index) || index < 0 || index >= accountKeys.length) {
        throw new RangeError('instruction references an account index outside accountKeys');
      }
    }
    parts.push(
      Uint8Array.from([ix.programIdIndex]),
      encodeCompactU16(ix.accountKeyIndexes.length), Uint8Array.from(ix.accountKeyIndexes),
      encodeCompactU16(ix.data.length), ix.data,
    );
  }
  return concat(parts);
}

/** Parse serialized legacy message bytes back into the compiled shape (round-trip check). */
export function decodeLegacyMessage(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('message must be bytes');
  if (input.length < 3) throw new RangeError('message is shorter than its header');
  if (input[0] & 0x80) throw new RangeError('versioned messages are not supported; expected a legacy message');
  let offset = 0;
  const header = {
    numRequiredSignatures: input[offset++],
    numReadonlySignedAccounts: input[offset++],
    numReadonlyUnsignedAccounts: input[offset++],
  };
  const take = (length) => {
    if (offset + length > input.length) throw new RangeError('truncated message');
    const slice = input.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const compact = () => { const { value, size } = decodeCompactU16(input, offset); offset += size; return value; };

  const keyCount = compact();
  if (keyCount > MAX_ACCOUNT_KEYS) throw new RangeError('too many account keys');
  const accountKeys = Array.from({ length: keyCount }, () => encodeBase58Pubkey(Uint8Array.from(take(32))));
  if (header.numRequiredSignatures > keyCount
    || header.numReadonlySignedAccounts > header.numRequiredSignatures
    || header.numReadonlyUnsignedAccounts > keyCount - header.numRequiredSignatures) {
    throw new RangeError('message header is inconsistent with its account keys');
  }
  const recentBlockhash = encodeBase58Pubkey(Uint8Array.from(take(32)));
  const instructionCount = compact();
  const instructions = [];
  for (let i = 0; i < instructionCount; i += 1) {
    const programIdIndex = take(1)[0];
    const accountCount = compact();
    const accountKeyIndexes = Array.from(take(accountCount));
    const dataLength = compact();
    const data = Uint8Array.from(take(dataLength));
    for (const index of [programIdIndex, ...accountKeyIndexes]) {
      if (index >= keyCount) throw new RangeError('instruction references an account index outside accountKeys');
    }
    instructions.push({ programIdIndex, accountKeyIndexes, data });
  }
  if (offset !== input.length) throw new RangeError('trailing bytes after the message');
  return { header, accountKeys, recentBlockhash, instructions };
}

/** Public keys that must sign, in signature order (the fee payer is first). */
export function requiredSigners(message) {
  return message.accountKeys.slice(0, message.header.numRequiredSignatures);
}

/**
 * Size of the wire transaction once every required signature is attached:
 * compact-u16 signature count + 64 bytes per signature + the message bytes.
 */
export function signedTransactionSize(message) {
  const sigs = message.header.numRequiredSignatures;
  return encodeCompactU16(sigs).length + sigs * SIGNATURE_BYTES + serializeLegacyMessage(message).length;
}

/** Throws if the eventual signed transaction could not fit in one packet. */
export function assertFitsPacket(message) {
  const size = signedTransactionSize(message);
  if (size > MAX_TRANSACTION_BYTES) {
    throw new RangeError(`signed transaction would be ${size} bytes; the limit is ${MAX_TRANSACTION_BYTES}`);
  }
  return size;
}
