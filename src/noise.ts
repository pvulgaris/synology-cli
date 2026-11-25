/**
 * The Noise handshake DSM 7's web UI performs at login, and the per-request
 * `X-SYNO-HASH` header it enables.
 *
 * Without it DSM grants a limited session: reads and some writes work, but
 * administrator Core APIs (Task Scheduler, Terminal) answer 105 even for an
 * administrator. See "Full-access sessions" in docs/dsm-api-quirks.md.
 *
 * Only the initiator side of Noise_IK_25519_ChaChaPoly_BLAKE2b is implemented,
 * with an empty prologue, which is all a DSM login needs:
 * https://noiseprotocol.org/noise.html
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

const PROTOCOL = "Noise_IK_25519_ChaChaPoly_BLAKE2b";
const HASH = "blake2b512";
const HASH_LEN = 64;
const KEY_LEN = 32;
const TAG_LEN = 16;

/** DSM's cookie and header encoding: base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

const hash = (...parts: Uint8Array[]) => {
  const h = createHash(HASH);
  for (const p of parts) h.update(p);
  return h.digest();
};
const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const h = createHmac(HASH, key);
  for (const p of parts) h.update(p);
  return h.digest();
};

function hkdf(ck: Buffer, ikm: Uint8Array): [Buffer, Buffer] {
  const temp = hmac(ck, ikm);
  const one = hmac(temp, Buffer.from([1]));
  return [one, hmac(temp, one, Buffer.from([2]))];
}

/** ChaChaPoly nonce: 32 zero bits, then the counter as 64-bit little-endian. */
function iv(n: bigint): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64LE(n, 4);
  return out;
}

export function encrypt(key: Buffer, n: bigint, ad: Uint8Array, plain: Uint8Array): Buffer {
  const c = createCipheriv("chacha20-poly1305", key, iv(n), { authTagLength: TAG_LEN });
  c.setAAD(ad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function decrypt(key: Buffer, n: bigint, ad: Uint8Array, data: Buffer): Buffer {
  const d = createDecipheriv("chacha20-poly1305", key, iv(n), { authTagLength: TAG_LEN });
  d.setAAD(ad, { plaintextLength: data.length - TAG_LEN });
  d.setAuthTag(data.subarray(data.length - TAG_LEN));
  return Buffer.concat([d.update(data.subarray(0, data.length - TAG_LEN)), d.final()]);
}

// PKCS#8 and SPKI prefixes for a raw 32-byte X25519 key.
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

const privateKey = (raw: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
const publicKey = (raw: Uint8Array) =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const rawPublic = (key: KeyObject) =>
  createPublicKey(key).export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
const dh = (priv: KeyObject, pubRaw: Uint8Array) =>
  diffieHellman({ privateKey: priv, publicKey: publicKey(pubRaw) });

const newPrivate = () => generateKeyPairSync("x25519").privateKey;

/** The state a request hash needs once the handshake has finished. */
export interface NoiseSession {
  /** The initiator's sending key. */
  key: Buffer;
  handshakeHash: Buffer;
}

/** The initiator mid-handshake: message 1 is written, message 2 not yet read. */
export class NoiseInitiator {
  private ck: Buffer;
  private h: Buffer;
  private k: Buffer | null = null;
  private n = 0n;
  private readonly s: KeyObject;
  private readonly e: KeyObject;
  readonly message1: Buffer;

  /** `keys` fixes the static and ephemeral keys, for test vectors only. */
  constructor(
    responderStatic: Uint8Array,
    payload: Uint8Array,
    keys: { s?: Uint8Array; e?: Uint8Array } = {}
  ) {
    const name = Buffer.from(PROTOCOL);
    this.h = name.length <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)]) : hash(name);
    this.ck = this.h;
    this.mixHash(Buffer.alloc(0)); // empty prologue
    this.mixHash(responderStatic); // IK pre-message: <- s
    this.s = keys.s ? privateKey(keys.s) : newPrivate();
    this.e = keys.e ? privateKey(keys.e) : newPrivate();

    // -> e, es, s, ss
    const ePub = rawPublic(this.e);
    this.mixHash(ePub);
    this.mixKey(dh(this.e, responderStatic));
    const sEnc = this.encryptAndHash(rawPublic(this.s));
    this.mixKey(dh(this.s, responderStatic));
    this.message1 = Buffer.concat([ePub, sEnc, this.encryptAndHash(payload)]);
  }

  /** Read message 2 (<- e, ee, se) and split out the sending key. */
  finish(message2: Uint8Array): NoiseSession {
    const msg = Buffer.from(message2);
    const re = msg.subarray(0, KEY_LEN);
    this.mixHash(re);
    this.mixKey(dh(this.e, re));
    this.mixKey(dh(this.s, re));
    this.decryptAndHash(msg.subarray(KEY_LEN));
    const [send] = hkdf(this.ck, Buffer.alloc(0));
    return { key: send.subarray(0, KEY_LEN), handshakeHash: this.h };
  }

  private mixHash(data: Uint8Array) {
    this.h = hash(this.h, data);
  }
  private mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf(this.ck, ikm);
    this.ck = ck;
    this.k = k.subarray(0, KEY_LEN);
    this.n = 0n;
  }
  private encryptAndHash(plain: Uint8Array): Buffer {
    const out = this.k ? encrypt(this.k, this.n++, this.h, plain) : Buffer.from(plain);
    this.mixHash(out);
    return out;
  }
  private decryptAndHash(data: Buffer): Buffer {
    const out = this.k ? decrypt(this.k, this.n++, this.h, data) : data;
    this.mixHash(data);
    return out;
  }
}

/** `X-SYNO-HASH` for one request. DSM refuses a nonce it has already seen. */
export function requestHash(session: NoiseSession, nonce: bigint): string {
  const tag = encrypt(session.key, nonce, Buffer.alloc(0), Buffer.alloc(0));
  return `${b64url(session.handshakeHash).slice(0, 8)}${b64url(tag)}.${b64url(Buffer.from(String(nonce)))}`;
}
