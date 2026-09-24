import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/**
 * Test-only software authenticator (ES256, "none" attestation, user verified) so passkey flows can be
 * exercised end to end without a browser. Not exported from the package entry point.
 */
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.concat([Buffer.from([(major << 5) | 25]), u16(n)]);
  return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(n)]);
}
/** Minimal CBOR encoder: integers, byte and text strings, maps. */
export function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported ${typeof v}`);
}

export class SoftAuthenticator {
  private readonly key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = randomBytes(16);
  private counter = 0;
  constructor(private readonly rpId: string, private readonly origin: string) {}

  get id() {
    return this.credentialId.toString('base64url');
  }

  register(challenge: string): RegistrationResponseJSON {
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const flags = 0x01 | 0x04 | 0x40; // user present, user verified, attested credential data
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([flags]), u32(this.counter), Buffer.alloc(16), u16(this.credentialId.length), this.credentialId, cose]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: this.origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
    };
  }

  authenticate(challenge: string, opts: { origin?: string } = {}): AuthenticationResponseJSON {
    this.counter += 1;
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x01 | 0x04]), u32(this.counter)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: opts.origin ?? this.origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.key.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') },
    };
  }
}
