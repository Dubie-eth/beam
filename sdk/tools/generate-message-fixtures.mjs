// Generates sdk/fixtures/messages.json: golden unsigned legacy Solana Message
// bytes for Beam SDK instructions, produced by @solana/web3.js so that the
// dependency-free compiler in sdk/beam-message.mjs can be checked against the
// reference implementation byte for byte.
//
// Run from the repository root with web3.js available on NODE_PATH, e.g.
//   mkdir -p /tmp/w3 && (cd /tmp/w3 && npm init -y >/dev/null && npm i @solana/web3.js@1.98.0)
//   NODE_PATH=/tmp/w3/node_modules node sdk/tools/generate-message-fixtures.mjs
// The repository itself keeps no web3.js dependency. Synthetic keys and a
// synthetic blockhash only; nothing here is signed or sent.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildBuy, buildSell, buildCreate } from '../beam-native.mjs';

const require = createRequire(import.meta.url);
const { PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const w3version = require('@solana/web3.js/package.json').version;

const native = JSON.parse(readFileSync(new URL('../fixtures/native-sol.json', import.meta.url)));
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'; // synthetic, 32 bytes
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// web3.js exposes compiled instruction data as a base58 string (any length).
function base58ToBytes(text) {
  let n = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new RangeError('invalid base58');
    n = n * 58n + BigInt(digit);
  }
  const leading = text.match(/^1*/)[0].length;
  const tail = [];
  while (n > 0n) { tail.push(Number(n & 255n)); n >>= 8n; }
  return Uint8Array.from([...Array(leading).fill(0), ...tail.reverse()]);
}

function toW3(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data),
  });
}

function compile(feePayer, instructions) {
  const tx = new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash: BLOCKHASH });
  tx.add(...instructions.map(toW3));
  const message = tx.compileMessage();
  return {
    header: {
      numRequiredSignatures: message.header.numRequiredSignatures,
      numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts,
    },
    accountKeys: message.accountKeys.map((k) => k.toBase58()),
    instructions: message.instructions.map((ci) => ({
      programIdIndex: ci.programIdIndex, accounts: ci.accounts, dataHex: hex(base58ToBytes(ci.data)),
    })),
    messageHex: hex(message.serialize()),
  };
}

const buy = buildBuy(native.buy.accounts, native.buy.args);
const sell = buildSell(native.sell.accounts, native.sell.args);
const create = buildCreate(native.create.accounts, native.create.args);

const cases = {
  // One instruction, fee payer is the instruction's signer.
  buy: { feePayer: native.buy.accounts.user, instructions: [buy] },
  // Two instructions sharing most accounts: exercises de-duplication and privilege merging.
  buyThenSell: { feePayer: native.buy.accounts.user, instructions: [buy, sell] },
  // Fee payer that appears in no instruction: must be prepended as a writable signer.
  buyForeignPayer: { feePayer: '3sJyG8GxbUQm2kzK9eLZMt6b9jJqwAxYzcbgsfHBVvDB', instructions: [buy] },
  // Two signers (mint and user): exercises readonly/writable signer ordering.
  create: { feePayer: native.create.accounts.user, instructions: [create] },
};

const out = {
  generator: `@solana/web3.js ${w3version} Transaction.compileMessage()`,
  sourceFixture: 'fixtures/native-sol.json',
  recentBlockhash: BLOCKHASH,
  fixtureOnly: 'synthetic keys and blockhash; unsigned legacy Message bytes; never a transaction example',
  cases: Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, {
    feePayer: c.feePayer,
    instructions: c.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys, dataHex: hex(ix.data) })),
    expected: compile(c.feePayer, c.instructions),
  }])),
};

writeFileSync(new URL('../fixtures/messages.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote sdk/fixtures/messages.json with ${Object.keys(cases).length} cases (${out.generator})`);
