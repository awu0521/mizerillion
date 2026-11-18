// Display names players pick from. One rule everywhere: trimmed, single spaces, 1-40 characters,
// no control characters, unique ignoring case.
export function cleanName(v) {
  if (typeof v !== 'string') return { error: 'Type a name.' };
  const name = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Type a name.' };
  if (Array.from(name).length > 40) return { error: 'Names can be at most 40 characters.' };
  return { name };
}
