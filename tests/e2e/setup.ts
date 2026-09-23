/** Global e2e setup (run with tsx): seed a SUPER_ADMIN staff account and write its TOTP secret for the admin spec. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createStaff } from '@arkiv/auth';
import { closeAll, ownerPool } from '@arkiv/db';

const email = `e2e-${Date.now().toString(36)}@arkiv.test`;
const password = 'e2e correct horse battery staple';
const s = await createStaff({ email, name: 'E2E Admin', password, roles: ['SUPER_ADMIN'] });
await mkdir(new URL('../../.storage/', import.meta.url), { recursive: true });
await writeFile(new URL('../../.storage/e2e-staff.json', import.meta.url), JSON.stringify({ email, password, secret: s.totpSecret }));
// A previous interrupted run must not leave a kill switch on (e.g. read-only would block the funnel spec).
await ownerPool()`update feature_flags set enabled = false where key like 'kill.%'`;
await closeAll();
