// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Test-only aggregator. Re-exports every per-locale resource as a single
 * ``fallbackResources`` object so existing tests (notably
 * ``boqResourceTypes.test.ts``) can iterate all 30 locales without
 * duplicating the imports.
 *
 * This file reads ``./locales/*``; it does not generate them. A locale added
 * under that directory has to be added here by hand or it is invisible to
 * every test that iterates this object, which is how Kyrgyz went unchecked.
 *
 * IMPORTANT: this file is intentionally NOT imported from runtime code.
 * The application boots from ``./locales/en`` and lazy-loads other
 * locales on demand (see ``./i18n.ts``). Static imports here force the
 * test bundle to include every locale; tree-shaking removes the entire
 * file from the production bundle because nothing in the entrypoint
 * chain imports it.
 */
import en from './locales/en';
import de from './locales/de';
import fr from './locales/fr';
import es from './locales/es';
import esMX from './locales/es-MX';
import esCL from './locales/es-CL';
import esCO from './locales/es-CO';
import pt from './locales/pt';
import ptBR from './locales/pt-BR';
import ru from './locales/ru';
import zh from './locales/zh';
import ar from './locales/ar';
import hi from './locales/hi';
import tr from './locales/tr';
import it from './locales/it';
import nl from './locales/nl';
import pl from './locales/pl';
import cs from './locales/cs';
import ja from './locales/ja';
import ko from './locales/ko';
import sv from './locales/sv';
import no from './locales/no';
import da from './locales/da';
import fi from './locales/fi';
import bg from './locales/bg';
import hr from './locales/hr';
import id from './locales/id';
import ro from './locales/ro';
import th from './locales/th';
import vi from './locales/vi';
import mn from './locales/mn';
import ky from './locales/ky';
import et from './locales/et';
import bn from './locales/bn';
import kk from './locales/kk';
import fil from './locales/fil';
import ur from './locales/ur';
import fa from './locales/fa';
import he from './locales/he';

export const fallbackResources = {
  en,
  de,
  fr,
  es,
  'es-MX': esMX,
  'es-CL': esCL,
  'es-CO': esCO,
  pt,
  'pt-BR': ptBR,
  ru,
  zh,
  ar,
  hi,
  tr,
  it,
  nl,
  pl,
  cs,
  ja,
  ko,
  sv,
  no,
  da,
  fi,
  bg,
  hr,
  id,
  ro,
  th,
  vi,
  mn,
  ky,
  et,
  bn,
  kk,
  fil,
  ur,
  fa,
  he,
};
