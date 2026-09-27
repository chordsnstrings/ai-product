import { writeFile } from 'node:fs/promises';
import { productPhoto } from '@arkiv/core/testing';

await writeFile(new URL('./fixtures/serum.jpg', import.meta.url), await productPhoto('DEW SERUM', '#E8DCC8'));
