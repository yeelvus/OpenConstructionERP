# Locale wording-harmonisation artefacts

These two files are a one-off analysis produced on 2026-08-08 while auditing
whether the application locales (`frontend/src/app/locales/*.ts`, not the
marketing-site JSON locales) render the same English source string the same
way at every key that shares it.

- `locale_renderings_2026-08-08.json` is the evidence base: for every locale,
  every key whose English source string also appears at another key, paired
  with what that locale actually wrote at each occurrence.
- `harmonisation_proposal_2026-08-08.json` is the proposal built from that
  evidence. Its `decisions` section (668 entries) picks a wording where the
  two occurrences already agreed or the choice was mechanical. Its
  `deferred` section (65 entries across 21 locales) lists the cases left for
  a human or a follow-up task because picking correctly required judgment
  the original heuristic could not make safely in every language.

No code in this repository generates either file; they were produced
out-of-band and are checked in here as a record, not as build output.

**Review status.** This proposal is unreviewed by a native reader of each
language, with one exception: task #61 worked through the 65 `deferred`
entries and applied a resolution to every one directly in the locale files,
using the wording the file's own surrounding usage already established (or
picking the grammatically correct variant where one candidate was outright
wrong). Everything in `decisions` remains unapplied and unreviewed.
