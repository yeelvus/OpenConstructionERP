// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Resolving the user-visible strings a module manifest declares.
 *
 * `ModuleManifest.name`, `.description` and `ModuleRoute.title` are i18n keys.
 * A module that ships outside this repository may still carry an English
 * literal there, and that literal has to keep rendering as itself, so every
 * consumer asks the same question in the same place instead of re-deciding
 * locally: the registry page, the header title and the gate test all call in
 * here, which is what keeps them from drifting apart.
 */

/** Translate function shape, narrowed to what a manifest string needs. */
export type Translate = (key: string, options: { defaultValue: string }) => string;

/**
 * True when a manifest string is an i18n key rather than a display literal.
 *
 * Decided by shape, not by prefix. A key is dotted, lower-case and has no
 * whitespace (`gaeb.title`, `nav.5d_cost_model`, `modules.pdf_takeoff.name`);
 * a display name carries capitals, spaces or both (`PDF Takeoff Viewer`). A
 * list of allowed prefixes has to grow every time a module picks a new
 * namespace and can never cover one we have not seen, which is precisely the
 * third-party case this contract exists for.
 */
export function isModuleI18nKey(value: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(value);
}

/**
 * The text to show for a manifest string in the current language.
 *
 * A key nothing answers renders as the key itself. That looks wrong on screen
 * on purpose: it is greppable and it points at the module that owes the
 * translation. Handing back a prettified module id instead would hide the gap,
 * and on a misread literal it would replace text the module author wrote.
 */
export function translateManifestText(t: Translate, value: string): string {
  return isModuleI18nKey(value) ? t(value, { defaultValue: value }) : value;
}
