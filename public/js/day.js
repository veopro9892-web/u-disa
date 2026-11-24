const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export function businessDay(date = new Date()) {
  const parts = Object.fromEntries(calendar.formatToParts(date).map(p => [p.type, p.value]));
  return [parts.year, parts.month, parts.day].join('-');
}
