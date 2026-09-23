/** Global e2e setup (run with tsx): seed a SUPER_ADMIN staff account and write its TOTP secret for the admin spec. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createStaff } from '@arkiv/auth';
import { closeAll } from '@arkiv/db';

const email = `e2e-${Date.now().toString(36)}@arkiv.test`;
const password = 'e2e correct horse battery staple';
const s = await createStaff({ email, name: 'E2E Admin', password, roles: ['SUPER_ADMIN'] });
await mkdir(new URL('../../.storage/', import.meta.url), { recursive: true });
await writeFile(new URL('../../.storage/e2e-staff.json', import.meta.url), JSON.stringify({ email, password, secret: s.totpSecret }));
await closeAll();
