const { escapeRegExp, logWarn, normalizeTorrentName, odstranDiakritiku } = require("./common");

function ziskajMovieTarget(metaInfo, zakladneNazvy = []) {
  const kandidati = [
    metaInfo?.titleOriginal,
    metaInfo?.titleCz,
    ...(Array.isArray(zakladneNazvy) ? zakladneNazvy : [])
  ].filter(Boolean);

  for (const raw of kandidati) {
    const normalized = normalizeTorrentName(raw)
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const match = normalized.match(/^(.*?)(?:\s+(\d+))?$/);
    if (!match) continue;

    const baseTitle = (match[1] || '').trim();
    const sequelNumber = match[2] ? parseInt(match[2], 10) : null;
    if (baseTitle) return { baseTitle, sequelNumber };
  }
  return { baseTitle: null, sequelNumber: null };
}

// Spolocna normalizacia (lomka "/" sa meni na medzeru)
function normalizeText(s) {
  return odstranDiakritiku(String(s || ''))
    .toLowerCase()
    .replace(/stiahni si/gi, ' ')
    .replace(/[._\-()[\]{}:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Zo vsetkych titulov spravi zoznam {base, seq}
function zostavBases(targets) {
  const bases = [];
  const seen = new Set();
  for (const t of targets) {
    const clean = t.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
    const m = clean.match(/^(.*?)(?:\s+(\d+))?$/);
    if (m && m[1] && m[1].trim()) {
      const base = m[1].trim();
      const seq = m[2] ? parseInt(m[2], 10) : null;
      const key = base + '|' + seq;
      if (!seen.has(key)) {
        seen.add(key);
        bases.push({ base, seq });
      }
    }
  }
  return bases;
}

function movieTorrentMatches(torrentName, metaInfo, zakladneNazvy = []) {
  const name = normalizeText(torrentName);
  const targets = [
    metaInfo?.titleOriginal,
    metaInfo?.titleCz,
    ...(Array.isArray(zakladneNazvy) ? zakladneNazvy : [])
  ].filter(Boolean).map(normalizeText);

  if (targets.length === 0) return true;

  const bases = zostavBases(targets);
  if (bases.length === 0) return true;

  // Skusa VSETKY tituly, nie len prvy
  const hit = bases.find(b => new RegExp(`\\b${escapeRegExp(b.base)}\\b`, 'i').test(name));
  if (!hit) {
    logWarn(`[FILTER OUT] ${torrentName} | reason=BASE_MISMATCH | bases=${bases.map(b => b.base).join(' ; ')} | name="${name}"`);
    return false;
  }
  const sequelNumber = hit.seq;

  const pack = /\b(komplet|pack|kolekce|kolekcia|collection|saga|trilogy|quadrilogy)\b/i.test(name);
  const rawName = odstranDiakritiku(String(torrentName || '')).toLowerCase();
  const range = (sequelNumber !== null) ? rawName.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/) : null;

  if (metaInfo?.yearStart && !pack && !range) {
    const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map(m => parseInt(m[0], 10));
    const allowedYears = [metaInfo.yearStart - 1, metaInfo.yearStart, metaInfo.yearStart + 1];
    if (years.length > 0 && !years.some(year => allowedYears.includes(year))) {
      logWarn(`[FILTER OUT] ${torrentName} | reason=YEAR_MISMATCH`);
      return false;
    }

    if (years.length === 0 && sequelNumber === null) {
      const jeKolekcia = /\b(komplet|bijak|kolekce|kolekcia|collection|saga|trilogy|desnej)\b/i.test(name);
      if (jeKolekcia) {
        logWarn(`[FILTER OUT] ${torrentName} | reason=COLLECTION_NO_YEAR`);
        return false;
      }
    }
  }

  if (sequelNumber !== null) {
    if (pack) return true;
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      if (sequelNumber >= lo && sequelNumber <= hi) return true;
    }
    const digitMatches = [...name.matchAll(/\b(\d{1,2})\b/g)].map(m => parseInt(m[1], 10));
    if (digitMatches.includes(sequelNumber)) return true;
    if (sequelNumber === 2 && /\bii\b/i.test(name)) return true;

    logWarn(`[FILTER OUT] ${torrentName} | reason=SEQUEL_MISMATCH`);
    return false;
  }

  if (pack) {
    logWarn(`[FILTER OUT] ${torrentName} | reason=PACK_NO_SEQUEL`);
    return false;
  }

  return true;
}

function vyfiltrujMovieTorrenty(torrenty, metaInfo, zakladneNazvy = []) {
  const before = torrenty.length;
  const filtered = torrenty.filter(t => movieTorrentMatches(t.name, metaInfo, zakladneNazvy));
  logWarn(`MOVIE FILTER: ${before} -> ${filtered.length}`);
  return filtered;
}

function romanToInt(str) {
  const map = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
  return map[str.toLowerCase()] || null;
}

function movieFileMatches(filePath, meta, zakladneNazvy = []) {
  const name = normalizeText(filePath);
  const targets = [
    meta?.titleOriginal,
    meta?.titleCz,
    ...(Array.isArray(zakladneNazvy) ? zakladneNazvy : [])
  ].filter(Boolean).map(normalizeText);

  const bases = zostavBases(targets);
  if (bases.length === 0) return false;

  const hit = bases.find(b => new RegExp(`\\b${escapeRegExp(b.base)}\\b`, 'i').test(name));
  if (!hit) return false;
  const sequelNumber = hit.seq;

  if (sequelNumber !== null) {
    const nums = [...name.matchAll(/\b(\d{1,2})\b/g)].map(m => parseInt(m[1], 10));
    if (nums.includes(sequelNumber)) return true;

    const romanMatches = [...name.matchAll(/\b(x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/gi)];
    for (const rm of romanMatches) {
      if (romanToInt(rm[1]) === sequelNumber) return true;
    }
    return false;
  }

  if (meta?.yearStart) {
    const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map(m => parseInt(m[0], 10));
    const allowedYears = [meta.yearStart - 1, meta.yearStart, meta.yearStart + 1];
    if (years.length > 0 && !years.some(year => allowedYears.includes(year))) return false;
  }

  return true;
}

module.exports = { movieFileMatches, movieTorrentMatches, vyfiltrujMovieTorrenty, ziskajMovieTarget };
