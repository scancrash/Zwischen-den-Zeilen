// Vercel-Einstiegspunkt: vercel.json leitet alle Anfragen, die keine statische Datei in public/ sind, hierher.
import { createApp } from '../server/index.js';
import { connectFromEnv, initSchema } from '../server/db.js';

let ready;

export default async function handler(req, res) {
  // Pro Funktionsinstanz einmal verbinden und das Schema anlegen (idempotent); Fehler werden nicht zwischengespeichert.
  ready ??= connectFromEnv().then(initSchema).then(createApp).catch((e) => {
    ready = undefined;
    throw e;
  });
  try {
    return await (await ready)(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Datenbank nicht erreichbar. Ist DATABASE_URL gesetzt?' }));
  }
}
