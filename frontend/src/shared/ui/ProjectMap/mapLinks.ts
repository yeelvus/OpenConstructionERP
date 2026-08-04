// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/** External map deep-links (no MapLibre dependency). */

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

export function googleEarthUrl(lat: number, lng: number): string {
  return `https://earth.google.com/web/@${lat},${lng},500a,35y,0h,0t,0r`;
}
