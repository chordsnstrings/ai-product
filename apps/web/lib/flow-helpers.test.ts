import { describe, expect, it } from 'vitest';
import { disputeChoices } from './flow-helpers';

describe('disputed fact choices (plan 03 P4, one tap per fact)', () => {
  it('offers each distinct value once with its source in customer words; prices read as money', () => {
    expect(
      disputeChoices('price', [
        { value: '38', source: 'product_page' },
        { value: '42', source: 'photo_ocr' },
        { value: '38', source: 'json_ld' },
      ]),
    ).toEqual([
      { value: '38', label: '$38.00 · from your page' },
      { value: '42', label: '$42.00 · from your photo' },
    ]);
    expect(disputeChoices('size', [{ value: '30 ml', source: 'shopify' }, { value: '30 ML', source: 'photo_ocr' }, { value: ' ', source: 'import' }])).toEqual([{ value: '30 ml', label: '30 ml · from your store' }]);
  });
});
