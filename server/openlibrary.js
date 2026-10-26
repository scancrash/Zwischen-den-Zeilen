// Buchsuche über Open Library (kostenlos, ohne API-Key). Fallback: Google Books.
const OL = process.env.OPENLIBRARY_URL || 'https://openlibrary.org';
const GB = process.env.GOOGLE_BOOKS_URL || 'https://www.googleapis.com/books/v1';

async function getJson(url, ms = 8000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { 'User-Agent': 'Buchclub-App/1.0 (private book club)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchOpenLibrary(q) {
  const fields = 'key,title,author_name,first_publish_year,cover_i,number_of_pages_median';
  const data = await getJson(`${OL}/search.json?q=${encodeURIComponent(q)}&limit=12&fields=${fields}`);
  return (data.docs || []).map((d) => ({
    source_key: `ol:${d.key}`,
    title: d.title,
    author: (d.author_name || []).slice(0, 2).join(', '),
    year: d.first_publish_year || null,
    pages: d.number_of_pages_median || null,
    cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
  }));
}

async function searchGoogleBooks(q) {
  const data = await getJson(`${GB}/volumes?q=${encodeURIComponent(q)}&maxResults=12&printType=books`);
  return (data.items || []).map((i) => {
    const v = i.volumeInfo || {};
    return {
      source_key: `gb:${i.id}`,
      title: v.title,
      author: (v.authors || []).slice(0, 2).join(', '),
      year: parseInt(v.publishedDate, 10) || null,
      pages: v.pageCount || null,
      cover_url: (v.imageLinks?.thumbnail || '').replace('http://', 'https://'),
      description: v.description || '',
    };
  });
}

export async function searchBooks(q) {
  try {
    const r = await searchOpenLibrary(q);
    if (r.length) return r;
  } catch { /* fällt auf Google Books zurück */ }
  return searchGoogleBooks(q);
}

// Beschreibung nachladen (best effort) – für Open-Library-Treffer.
export async function fetchDescription(sourceKey) {
  if (!sourceKey?.startsWith('ol:/works/')) return '';
  try {
    const w = await getJson(`${OL}${sourceKey.slice(3)}.json`, 5000);
    const d = typeof w.description === 'string' ? w.description : w.description?.value;
    return (d || '').slice(0, 2000);
  } catch {
    return '';
  }
}
