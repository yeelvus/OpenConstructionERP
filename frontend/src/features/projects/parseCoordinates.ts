// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Parse human-pasted geographic coordinates into decimal degrees.
 *
 * Supported inputs (lat then lng by default):
 *   - DMS with symbols:  13°35'37.60"N 100°57'48.38"E
 *   - DMS spaced:        13 35 37.60 N, 100 57 48.38 E
 *   - Decimal:           13.59378, 100.96344
 *   - Hemisphere first:  N13°35'37.60" E100°57'48.38"
 *   - Mixed quotes:      13°35′37.60″N 100°57′48.38″E
 *   - Signed decimal:    -33.8688 151.2093
 *
 * Returns null when the string cannot be resolved to a valid WGS84 pair.
 */

export interface ParsedCoordinates {
  lat: number;
  lng: number;
  /** How the pair was recognized (for UI feedback). */
  format: 'dms' | 'decimal' | 'mixed';
}

const HEM_LAT = 'NSns北南';
const HEM_LNG = 'EWew东西東';

/** Normalize fancy degree/prime symbols and whitespace for matching. */
function normalizeCoordText(raw: string): string {
  return raw
    .replace(/\u00a0/g, ' ')
    .replace(/[°º˚]/g, '°')
    .replace(/[′'’‘`´]/g, "'")
    .replace(/[″"”„]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function dmsToDecimal(deg: number, min: number, sec: number, sign: 1 | -1): number {
  return sign * (Math.abs(deg) + min / 60 + sec / 3600);
}

function hemSign(hem: string | undefined, kind: 'lat' | 'lng'): 1 | -1 | null {
  if (!hem) return 1;
  const h = hem.toUpperCase();
  if (kind === 'lat') {
    if (h === 'N' || h === '北') return 1;
    if (h === 'S' || h === '南') return -1;
    return null;
  }
  if (h === 'E' || h === '东' || h === '東') return 1;
  if (h === 'W' || h === '西') return -1;
  return null;
}

function isValidPair(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * One DMS component: optional hemisphere, degrees, optional minutes/seconds,
 * optional trailing hemisphere.
 *
 * Examples matched after normalize:
 *   13°35'37.60"N
 *   N13°35'37.60"
 *   13 35 37.60 N
 *   13°35'N
 *   13°N
 */
const DMS_PART =
  String.raw`([NSnsEWew北南东西東])?\s*` +
  String.raw`(-?\d+(?:\.\d+)?)\s*°?\s*` +
  String.raw`(?:(\d+(?:\.\d+)?)\s*['′]?\s*)?` +
  String.raw`(?:(\d+(?:\.\d+)?)\s*["″]?\s*)?` +
  String.raw`([NSnsEWew北南东西東])?`;

/**
 * Try to parse a single DMS token into decimal degrees.
 * `prefer` constrains which hemisphere letters are accepted.
 */
function parseDmsToken(
  token: string,
  prefer: 'lat' | 'lng' | 'any',
): { value: number; kind: 'lat' | 'lng' | 'unknown' } | null {
  const re = new RegExp(`^${DMS_PART}$`, 'u');
  const m = token.trim().match(re);
  if (!m) return null;

  const hemBefore = m[1];
  const deg = Number(m[2]);
  const min = m[3] != null && m[3] !== '' ? Number(m[3]) : 0;
  const sec = m[4] != null && m[4] !== '' ? Number(m[4]) : 0;
  const hemAfter = m[5];
  const hem = hemAfter || hemBefore;

  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;
  // Degrees with minutes/seconds should be whole numbers (allow float deg only without min/sec).
  if ((m[3] != null || m[4] != null) && !Number.isInteger(Number(m[2])) && Math.abs(deg) > 180) {
    return null;
  }

  let kind: 'lat' | 'lng' | 'unknown' = 'unknown';
  if (hem) {
    const h = hem.toUpperCase();
    if (HEM_LAT.toUpperCase().includes(h) || '北南'.includes(hem)) kind = 'lat';
    else if (HEM_LNG.toUpperCase().includes(h) || '东西東'.includes(hem)) kind = 'lng';
  } else if (prefer === 'lat' || prefer === 'lng') {
    kind = prefer;
  }

  if (prefer !== 'any' && kind !== 'unknown' && kind !== prefer) return null;

  const signKind = kind === 'unknown' ? prefer === 'lng' ? 'lng' : 'lat' : kind;
  const sign = hemSign(hem, signKind === 'lng' ? 'lng' : 'lat');
  if (sign == null) return null;

  // Signed degrees (leading -) win over hemisphere when both appear.
  const effectiveSign: 1 | -1 = deg < 0 ? -1 : sign;
  const value = dmsToDecimal(Math.abs(deg), min, sec, effectiveSign);

  if (signKind === 'lat' && (value < -90 || value > 90)) return null;
  if (signKind === 'lng' && (value < -180 || value > 180)) return null;

  return { value, kind };
}

/** Split a full string into two coordinate tokens (lat / lng). */
function splitPairTokens(text: string): [string, string] | null {
  const n = normalizeCoordText(text);
  if (!n) return null;

  // Prefer comma / semicolon / | as separators between lat and lng.
  const sepSplit = n.split(/\s*[,;|]\s*/).filter(Boolean);
  if (sepSplit.length === 2) return [sepSplit[0], sepSplit[1]];

  // Hemisphere-terminated pair: ...N ...E  or  ...S ...W
  const hemPair = n.match(
    new RegExp(
      `^(${DMS_PART})\\s+(${DMS_PART})$`,
      'u',
    ),
  );
  if (hemPair) return [hemPair[1], hemPair[2 + 5]]; // fragile — rebuild below

  // Two hemisphere markers → split after the first trailing hem letter.
  const hemPositions: number[] = [];
  for (let i = 0; i < n.length; i++) {
    if ('NSEW北南东西東nsew'.includes(n[i])) hemPositions.push(i);
  }
  if (hemPositions.length >= 2) {
    const mid = hemPositions[0] + 1;
    const a = n.slice(0, mid).trim();
    const b = n.slice(mid).trim();
    if (a && b) return [a, b];
  }

  // Decimal pair separated by whitespace: "13.59 100.96"
  const decPair = n.match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/);
  if (decPair) return [decPair[1], decPair[2]];

  // Space-separated DMS without clear hem mid-split: look for two degree marks.
  const degIdx: number[] = [];
  for (let i = 0; i < n.length; i++) {
    if (n[i] === '°') degIdx.push(i);
  }
  if (degIdx.length >= 2) {
    // Find space between the two ° groups that is a good split.
    const afterFirst = degIdx[0];
    // Walk forward past first component's min/sec to a space before second number block.
    const rest = n.slice(afterFirst + 1);
    const m = rest.match(/^[\d.'"\s]*[NSns北南]?\s+/);
    if (m) {
      const splitAt = afterFirst + 1 + m[0].length;
      const a = n.slice(0, splitAt).trim();
      const b = n.slice(splitAt).trim();
      if (a && b) return [a, b];
    }
  }

  return null;
}

function parseDecimalToken(token: string): number | null {
  const t = token.trim().replace(/[°]/g, '');
  // Pure number, optional hemisphere suffix/prefix.
  const m = t.match(/^([NSnsEWew北南东西東])?\s*(-?\d+(?:\.\d+)?)\s*([NSnsEWew北南东西東])?$/u);
  if (!m) return null;
  const hem = m[3] || m[1];
  let v = Number(m[2]);
  if (!Number.isFinite(v)) return null;
  if (hem) {
    const h = hem.toUpperCase();
    if (h === 'S' || h === '南' || h === 'W' || h === '西') v = -Math.abs(v);
    else if (h === 'N' || h === '北' || h === 'E' || h === '东' || h === '東') v = Math.abs(v);
  }
  return v;
}

/**
 * Parse free-text coordinates. Accepts a full pair string.
 * Also accepts a single field value that already contains both lat and lng
 * (e.g. user pasted the whole string into the latitude box).
 */
export function parseCoordinates(raw: string): ParsedCoordinates | null {
  if (raw == null) return null;
  const text = normalizeCoordText(String(raw));
  if (!text) return null;

  // Fast path: pure decimal pair
  const dec = text.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (dec) {
    const lat = Number(dec[1]);
    const lng = Number(dec[2]);
    if (isValidPair(lat, lng)) return { lat, lng, format: 'decimal' };
  }

  const tokens = splitPairTokens(text);
  if (!tokens) {
    // Maybe a single DMS with hem that isn't a pair — not useful alone.
    return null;
  }

  const [t0, t1] = tokens;

  // Try DMS on both tokens first.
  const d0 = parseDmsToken(t0, 'any');
  const d1 = parseDmsToken(t1, 'any');

  if (d0 && d1) {
    let lat: number | null = null;
    let lng: number | null = null;
    const hasMinOrSec = (tok: string) => /['"′″]|\d+\s+\d+/.test(tok) || /°\s*\d/.test(tok);

    if (d0.kind === 'lat' && d1.kind === 'lng') {
      lat = d0.value;
      lng = d1.value;
    } else if (d0.kind === 'lng' && d1.kind === 'lat') {
      lat = d1.value;
      lng = d0.value;
    } else if (d0.kind === 'lat' && d1.kind === 'unknown') {
      lat = d0.value;
      lng = d1.value;
    } else if (d0.kind === 'lng' && d1.kind === 'unknown') {
      lng = d0.value;
      lat = d1.value;
    } else if (d0.kind === 'unknown' && d1.kind === 'lat') {
      lat = d1.value;
      lng = d0.value;
    } else if (d0.kind === 'unknown' && d1.kind === 'lng') {
      lng = d1.value;
      lat = d0.value;
    } else {
      // Both unknown (or same kind): assume lat, lng order.
      lat = d0.value;
      lng = d1.value;
    }

    if (lat != null && lng != null && isValidPair(lat, lng)) {
      const format =
        hasMinOrSec(t0) || hasMinOrSec(t1) || d0.kind !== 'unknown' || d1.kind !== 'unknown'
          ? 'dms'
          : 'decimal';
      return { lat, lng, format };
    }
  }

  // Decimal tokens (possibly with hem letter).
  const v0 = parseDecimalToken(t0);
  const v1 = parseDecimalToken(t1);
  if (v0 != null && v1 != null && isValidPair(v0, v1)) {
    return { lat: v0, lng: v1, format: 'decimal' };
  }

  // Mixed: one DMS one decimal.
  if (d0 && v1 != null) {
    const lat = d0.kind === 'lng' ? v1 : d0.value;
    const lng = d0.kind === 'lng' ? d0.value : v1;
    if (isValidPair(lat, lng)) return { lat, lng, format: 'mixed' };
  }
  if (d1 && v0 != null) {
    let la = v0;
    let ln = d1.value;
    if (d1.kind === 'lat') {
      la = d1.value;
      ln = v0;
    } else if (d1.kind === 'lng') {
      la = v0;
      ln = d1.value;
    }
    if (isValidPair(la, ln)) return { lat: la, lng: ln, format: 'mixed' };
  }

  return null;
}

/**
 * True when the string looks like it may contain a full coordinate pair
 * (so we should try parseCoordinates on paste into a single field).
 */
export function looksLikeCoordinatePair(raw: string): boolean {
  const t = normalizeCoordText(raw);
  if (!t) return false;
  // Degree symbols are a strong signal (DMS from GPS / Google Earth).
  if ((t.match(/°/g) || []).length >= 1 && /\d/.test(t)) return true;
  // Two numbers separated by comma / semicolon.
  if (/^-?\d+(\.\d+)?\s*[,;]\s*-?\d+(\.\d+)?$/.test(t)) return true;
  // Space-separated pure decimals.
  if (/^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$/.test(t)) return true;
  // Hemisphere letters as standalone tokens (not letters inside words).
  const hems = t.match(/(?:^|[\s,;|°'"0-9])([NSnsEWew北南东西東])(?=$|[\s,;|°'"0-9])/g);
  if (hems && hems.length >= 2 && /\d/.test(t)) return true;
  // Already a known-good parse.
  return parseCoordinates(t) != null;
}

/** Format decimal degrees back to a compact DMS string (for display). */
export function formatDms(lat: number, lng: number, precision = 2): string {
  const fmt = (v: number, pos: string, neg: string) => {
    const hem = v >= 0 ? pos : neg;
    const abs = Math.abs(v);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    let m = Math.floor(mFloat);
    let s = (mFloat - m) * 60;
    // Carry rounding
    const sFixed = Number(s.toFixed(precision));
    if (sFixed >= 60) {
      s = 0;
      m += 1;
    } else {
      s = sFixed;
    }
    if (m >= 60) {
      m = 0;
    }
    const sStr = s.toFixed(precision);
    return `${d}°${m}'${sStr}"${hem}`;
  };
  return `${fmt(lat, 'N', 'S')} ${fmt(lng, 'E', 'W')}`;
}
