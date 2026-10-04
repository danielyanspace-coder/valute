#!/usr/bin/env node
// Deposit wallet tool. Run it OFFLINE on your own computer, never on the server.
//
//   node scripts/tron-wallet.mjs new            new 24-word seed + xpub for .env
//   node scripts/tron-wallet.mjs xpub           xpub from an existing seed (typed in)
//   node scripts/tron-wallet.mjs addresses XPUB [count]   addresses the server will issue
//
// Path: m/44'/195'/0'/0/i (TronLink, Trust Wallet, Ledger use the same one).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createInterface } from 'node:readline/promises';

const ACCOUNT = "m/44'/195'/0'";
const b58 = createBase58check(sha256);

function address(publicKey) {
  const raw = secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1);
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(keccak_256(raw).subarray(12), 1);
  return b58.encode(payload);
}

function printAddresses(xpub, count) {
  const external = HDKey.fromExtendedKey(xpub).deriveChild(0);
  for (let i = 0; i < count; i++) console.log(`  #${i}  ${address(external.deriveChild(i).publicKey)}`);
}

function fromMnemonic(mnemonic) {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(words, wordlist)) throw new Error('Seed phrase is invalid (typo or wrong word count).');
  return HDKey.fromMasterSeed(mnemonicToSeedSync(words)).derive(ACCOUNT).publicExtendedKey;
}

function printXpub(xpub) {
  console.log('\nTRON_XPUB (put into the server .env, it cannot spend funds):\n');
  console.log(`TRON_XPUB=${xpub}\n`);
  console.log('First deposit addresses (user #1, #2, #3 will get these):');
  printAddresses(xpub, 3);
  console.log('\nCheck: import the seed into TronLink, address #0 must be the same.\n');
}

const [cmd, arg, count] = process.argv.slice(2);

if (cmd === 'new') {
  const mnemonic = generateMnemonic(wordlist, 256);
  console.log('\nSEED PHRASE (24 words). Write it on paper, two copies, in different places.');
  console.log('Do not photograph it, do not store it in chats, notes or cloud.\n');
  mnemonic.split(' ').forEach((w, i) => console.log(`  ${String(i + 1).padStart(2)}. ${w}`));
  printXpub(fromMnemonic(mnemonic));
  console.log('Close this terminal and clear its history when done.\n');
} else if (cmd === 'xpub') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const mnemonic = await rl.question('Seed phrase (words separated by spaces): ');
  rl.close();
  printXpub(fromMnemonic(mnemonic));
} else if (cmd === 'addresses' && arg) {
  printAddresses(arg, Number(count) || 10);
} else {
  console.log('Usage: node scripts/tron-wallet.mjs new | xpub | addresses <xpub> [count]');
  process.exit(1);
}
