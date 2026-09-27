/**
 * "Remove x? They lose access immediately." → a confirmation sheet titled with the question and the rest as its
 * body. Text without a question (or ending in one) is the title alone.
 */
export function splitConfirm(text: string): { title: string; body?: string } {
  const t = text.trim();
  const i = t.indexOf('?');
  if (i < 0 || i === t.length - 1) return { title: t };
  const body = t.slice(i + 1).trim();
  return body ? { title: t.slice(0, i + 1), body } : { title: t.slice(0, i + 1) };
}
