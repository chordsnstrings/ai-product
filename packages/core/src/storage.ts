import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@arkiv/shared';

/**
 * Object storage (plan 02 §3 layer 4). Keys are always built server-side:
 *   t/{workspaceId}/...  tenant assets (never CDN-cached under shareable URLs)
 *   q/{workspaceId}/...  quarantine for uploads — never served
 *   g/...                global marketing assets (CDN)
 * Production uses DigitalOcean Spaces (S3 API); dev/test use the local driver with HMAC-signed URLs.
 */
export interface Storage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  /** Short-lived GET URL (default 10 minutes; 24h for export links). */
  signedGetUrl(key: string, ttlSeconds?: number, downloadName?: string): Promise<string>;
  /** Presigned PUT for direct browser uploads into quarantine. */
  signedPutUrl(key: string, contentType: string, ttlSeconds?: number): Promise<string>;
}

const sign = (payload: string) => createHmac('sha256', env().APP_SECRET).update(payload).digest('base64url');

export function verifyLocalSignature(key: string, op: 'get' | 'put', exp: string, sig: string): boolean {
  if (Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(`${op}:${key}:${exp}`));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

class LocalStorage implements Storage {
  constructor(private readonly root: string) {}
  private file(key: string) {
    if (key.includes('..') || path.isAbsolute(key)) throw new Error('invalid storage key');
    return path.join(this.root, key);
  }
  async put(key: string, bytes: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, bytes);
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
  async exists(key: string) {
    try {
      await stat(this.file(key));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    const dir = this.file(prefix);
    let n = 0;
    try {
      const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(path.join(d, e.name));
          else n++;
        }
      };
      await walk(dir);
    } catch {
      return 0;
    }
    await rm(dir, { recursive: true, force: true });
    return n;
  }
  async signedGetUrl(key: string, ttlSeconds = 600, downloadName?: string) {
    const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
    const qs = new URLSearchParams({ key, exp, sig: sign(`get:${key}:${exp}`) });
    if (downloadName) qs.set('dl', downloadName);
    return `${env().APP_URL}/api/files?${qs}`;
  }
  async signedPutUrl(key: string, _contentType: string, ttlSeconds = 900) {
    const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
    return `${env().APP_URL}/api/files/upload?${new URLSearchParams({ key, exp, sig: sign(`put:${key}:${exp}`) })}`;
  }
}

class S3Storage implements Storage {
  private clientP: Promise<{ s3: import('@aws-sdk/client-s3').S3Client; mod: typeof import('@aws-sdk/client-s3') }>;
  constructor(private readonly bucket: string) {
    this.clientP = (async () => {
      const mod = await import('@aws-sdk/client-s3');
      const e = env();
      const s3 = new mod.S3Client({
        region: e.SPACES_REGION,
        endpoint: e.SPACES_ENDPOINT,
        forcePathStyle: false,
        credentials: { accessKeyId: e.SPACES_KEY!, secretAccessKey: e.SPACES_SECRET! },
      });
      return { s3, mod };
    })();
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    const { s3, mod } = await this.clientP;
    await s3.send(new mod.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ACL: 'private' }));
  }
  async get(key: string) {
    const { s3, mod } = await this.clientP;
    const r = await s3.send(new mod.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async exists(key: string) {
    const { s3, mod } = await this.clientP;
    try {
      await s3.send(new mod.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
  async delete(key: string) {
    const { s3, mod } = await this.clientP;
    await s3.send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async deletePrefix(prefix: string) {
    const { s3, mod } = await this.clientP;
    let n = 0;
    // Versioned bucket: delete every version so purged data does not linger (plan 02 §7).
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const r = await s3.send(
        new mod.ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
      );
      const objs = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (objs.length) {
        await s3.send(new mod.DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objs } }));
        n += objs.length;
      }
      keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
      versionMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
    } while (keyMarker);
    return n;
  }
  async signedGetUrl(key: string, ttlSeconds = 600, downloadName?: string) {
    const { s3, mod } = await this.clientP;
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(
      s3,
      new mod.GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replace(/"/g, '')}"` : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }
  async signedPutUrl(key: string, contentType: string, ttlSeconds = 900) {
    const { s3, mod } = await this.clientP;
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(s3, new mod.PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: ttlSeconds });
  }
}

/**
 * Storage errors in this process (plan 05 §22 "Spaces errors"): every failed put/get/delete/sign, reported with
 * the service heartbeat. `exists` answering false is not an error.
 */
const storageErrors = { count: 0, last: null as string | null, lastAt: null as string | null };
export const storageErrorStats = () => ({ ...storageErrors });

class CountingStorage implements Storage {
  constructor(private readonly inner: Storage) {}
  private async track<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      storageErrors.count++;
      storageErrors.last = `${op}: ${(e as Error).message}`.slice(0, 200);
      storageErrors.lastAt = new Date().toISOString();
      throw e;
    }
  }
  put(key: string, bytes: Buffer, contentType: string) {
    return this.track('put', () => this.inner.put(key, bytes, contentType));
  }
  get(key: string) {
    return this.track('get', () => this.inner.get(key));
  }
  exists(key: string) {
    return this.track('exists', () => this.inner.exists(key));
  }
  delete(key: string) {
    return this.track('delete', () => this.inner.delete(key));
  }
  deletePrefix(prefix: string) {
    return this.track('deletePrefix', () => this.inner.deletePrefix(prefix));
  }
  signedGetUrl(key: string, ttlSeconds?: number, downloadName?: string) {
    return this.track('signedGetUrl', () => this.inner.signedGetUrl(key, ttlSeconds, downloadName));
  }
  signedPutUrl(key: string, contentType: string, ttlSeconds?: number) {
    return this.track('signedPutUrl', () => this.inner.signedPutUrl(key, contentType, ttlSeconds));
  }
}

let instance: Storage | undefined;
export function storage(): Storage {
  if (!instance) {
    const e = env();
    instance = new CountingStorage(
      e.STORAGE_DRIVER === 's3'
        ? new S3Storage(e.SPACES_BUCKET ?? (() => { throw new Error('SPACES_BUCKET required'); })())
        : new LocalStorage(path.resolve(process.cwd().replace(/\/(apps|packages)\/[^/]+$/, ''), e.STORAGE_LOCAL_DIR)),
    );
  }
  return instance;
}

export const tenantKey = (workspaceId: string, ...parts: string[]) => ['t', workspaceId, ...parts].join('/');
export const quarantineKey = (workspaceId: string, uploadId: string) => `q/${workspaceId}/${uploadId}`;
