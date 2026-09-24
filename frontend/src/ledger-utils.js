export function money(cents) {
  const n = BigInt(cents || '0');
  const sign = n < 0n ? '-' : '';
  const absolute = n < 0n ? -n : n;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function totalCents(entries) { return entries.reduce((sum, e) => sum + BigInt(e.amountCents), 0n); }
export function filterEntries(entries, filters = {}) {
  const query = (filters.search || '').trim().toLocaleLowerCase();
  return entries.filter(e => (!filters.month || e.date.startsWith(filters.month)) &&
    ['project', 'category', 'paymentStatus'].every(key => !filters[key] || e[key] === filters[key]) &&
    (!query || [e.project,e.category,e.description,e.handler,e.notes,e.attachmentName,e.createdByName,e.updatedByName].join(' ').toLocaleLowerCase().includes(query)));
}
