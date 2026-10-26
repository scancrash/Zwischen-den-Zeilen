// iCalendar (RFC 5545) – wird von Apple Kalender, Google Kalender und Android gelesen.

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Zeilen länger als 75 Oktette werden gefaltet (UTF-8-sicher).
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function eventLines(m, { clubName, baseUrl }) {
  const start = new Date(m.starts_at);
  const end = new Date(start.getTime() + m.duration_min * 60000);
  const title = m.book_title ? `${clubName}: ${m.book_title}` : clubName;
  const desc = [
    m.book_title && `Buch: ${m.book_title}${m.book_author ? ' von ' + m.book_author : ''}`,
    m.notes,
    baseUrl && `Mehr in der App: ${baseUrl}`,
  ].filter(Boolean).join('\n');
  return [
    'BEGIN:VEVENT',
    `UID:buchclub-meeting-${m.id}@buchclub`,
    `DTSTAMP:${fmt(new Date(m.created_at.replace(' ', 'T') + 'Z'))}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(title)}`,
    m.location && `LOCATION:${esc(m.location)}`,
    desc && `DESCRIPTION:${esc(desc)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(title)}`,
    'TRIGGER:-PT2H',
    'END:VALARM',
    'END:VEVENT',
  ].filter(Boolean);
}

export function buildCalendar(meetings, opts) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Buchclub//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(opts.clubName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...meetings.flatMap((m) => eventLines(m, opts)),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
