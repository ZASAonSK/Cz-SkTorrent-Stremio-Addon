const { logWarn } = require("./common");

function torrentSedisSeriou(nazovTorrentu, seria) {
    if (
        /S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(nazovTorrentu) ||
        /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(nazovTorrentu) ||
        /\b\d{1,2}\.?\s*[-–]\s*\d{1,2}\.?\s*s[eé]rie/i.test(nazovTorrentu) ||
        /\bs[eé]ri[ae]\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/i.test(nazovTorrentu)
    ) return true;

    const serieMatch = nazovTorrentu.match(/\b(\d+)\.\s*s[eé]rie/i);
    if (serieMatch && parseInt(serieMatch[1], 10) !== seria) {
        logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
        return false;
    }

    const seasonMatch = nazovTorrentu.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1], 10) !== seria) {
        logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
        return false;
    }

    const seMatch = nazovTorrentu.match(/\bS(\d{1,2})[._-]?E\d{1,3}\b/i);
    if (seMatch && parseInt(seMatch[1], 10) !== seria) {
        logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
        return false;
    }

    const xMatch = nazovTorrentu.match(/\b(\d{1,2})x\d{1,3}\b/i);
    if (xMatch && parseInt(xMatch[1], 10) !== seria) {
        logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
        return false;
    }

    const sMatch = nazovTorrentu.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1], 10) !== seria) {
        logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
        return false;
    }
    return true;
}

function torrentSediSEpizodou(nazov, seria, epizoda) {
    const range =
        nazov.match(/\bS(\d{1,2})\s*[-–]\s*S?(\d{1,2})\b/i) ||
        nazov.match(/\bSeason\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
        nazov.match(/\bSeasons\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
        nazov.match(/\b(\d{1,2})\.?\s*[-–]\s*(\d{1,2})\.?\s*s[eé]rie\b/i) ||
        nazov.match(/\bs[eé]ri[ae]\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i);

    if (range) {
        const nums = range.filter(x => x !== undefined && /^\d+$/.test(x));
        if (nums.length >= 2) {
            const a = parseInt(nums[0], 10);
            const b = parseInt(nums[1], 10);
            if (seria >= Math.min(a, b) && seria <= Math.max(a, b)) return true;
        }
    }

    const seriaStr = String(seria).padStart(2, "0");
    const epStr = String(epizoda).padStart(2, "0");
    let toMaZluEpizodu = false;

    const vsetkyE = [...nazov.matchAll(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})\\b`, "gi"))];
    if (vsetkyE.length > 0 && !vsetkyE.some(m => parseInt(m[1]) === parseInt(epizoda))) toMaZluEpizodu = true;

    const vsetkyX = [...nazov.matchAll(new RegExp(`\\b${seria}x(\\d{1,3})\\b`, "gi"))];
    if (vsetkyX.length > 0 && !vsetkyX.some(m => parseInt(m[1]) === parseInt(epizoda))) toMaZluEpizodu = true;

    const jeToRozsahE = nazov.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i);
    if (jeToRozsahE) {
        const zaciatokE = parseInt(jeToRozsahE[1]);
        const koniecE = parseInt(jeToRozsahE[2]);
        if (epizoda >= zaciatokE && epizoda <= koniecE) toMaZluEpizodu = false;
    }

    if (toMaZluEpizodu) {
        logWarn(`[FILTER OUT] ${nazov} | reason=EPISODE_MISMATCH`);
        return false;
    }
    if (new RegExp(`S${seriaStr}[._-]?E${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b${seria}x${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b0*${epizoda}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i").test(nazov)) return true;

    const rozsahEpizod = nazov.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i) ||
        nazov.match(/(?:Dily?|Parts?|Epizody?|Eps?|Ep)[._\s]*(\d{1,3})\s*[-–]\s*(\d{1,3})\b/i);
    if (rozsahEpizod) {
        const zaciatok = parseInt(rozsahEpizod[1] || rozsahEpizod[2]);
        const koniec = parseInt(rozsahEpizod[2] || rozsahEpizod[3]);
        if (epizoda >= zaciatok && epizoda <= koniec) return true;
    }

    return new RegExp(`\\b${seria}\\.\\s*s[eé]rie\\b`, "i").test(nazov) ||
        new RegExp(`\\bs[eé]ri[ae]\\s*${seria}\\b`, "i").test(nazov) ||
        new RegExp(`\\bSeason\\s*${seria}\\b`, "i").test(nazov) ||
        new RegExp(`\\bS${seriaStr}\\b`, "i").test(nazov) ||
        /\b(Pack|Komplet|Complete|Vol|Volume|Part|Časť|Cast|1\.\s*-\s*\d{1,2}\.)\b/i.test(nazov);
}

module.exports = { torrentSediSEpizodou, torrentSedisSeriou };
