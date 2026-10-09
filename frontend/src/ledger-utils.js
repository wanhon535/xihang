export function money(cents) {
  const n = BigInt(cents || '0');
  const sign = n < 0n ? '-' : '';
  const absolute = n < 0n ? -n : n;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function totalCents(entries) { return entries.reduce((sum, e) => sum + BigInt(e.amountCents), 0n); }
export function filterEntries(entries, filters = {}) {
  const query = (filters.search || '').trim().toLocaleLowerCase();
  // 项目 / 类别支持多选：传数组，空数组表示「全部」；也兼容旧的单个字符串写法。
  const match = (value, filter) => Array.isArray(filter)
    ? (!filter.length || filter.includes(value))
    : (!filter || value === filter);
  return entries.filter(e => (!filters.month || e.date.startsWith(filters.month)) &&
    ['project', 'category', 'paymentStatus'].every(key => match(e[key], filters[key])) &&
    (!query || [e.project,e.category,e.description,e.handler,e.notes,e.attachmentName,e.createdByName,e.updatedByName].join(' ').toLocaleLowerCase().includes(query)));
}
