import { describe, expect, it } from 'vitest';
import { splitConfirm } from './confirm';

describe('splitConfirm', () => {
  it('titles the sheet with the question and puts the explanation in the body', () => {
    expect(splitConfirm('Disconnect Meta? We’ll delete the access token. Past data stays in your archive.')).toEqual({ title: 'Disconnect Meta?', body: 'We’ll delete the access token. Past data stays in your archive.' });
  });

  it('keeps a bare question or statement as the title', () => {
    expect(splitConfirm('Leave this workspace?')).toEqual({ title: 'Leave this workspace?' });
    expect(splitConfirm('Remove this passkey')).toEqual({ title: 'Remove this passkey' });
    expect(splitConfirm('  Archive this test?  ')).toEqual({ title: 'Archive this test?' });
  });
});
