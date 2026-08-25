# UK Construction Pack

Pre-configures OpenConstructionERP for United Kingdom contracting: the RICS
measurement rules, the JCT 2024 contract suite, CDM 2015 safety duties and the
Building Safety Act 2022 regime for higher-risk buildings.

## What this pack enables

- Currency GBP and the `uk_vat_20` tax template
- en-GB locale and the United Kingdom estimating methodology
- Seven validation rule packs: `nrm_1_cost_planning`,
  `nrm_2_detailed_measurement`, `nrm_3_maintenance`,
  `jct_2024_contract_clauses`, `bcis_benchmarks`, `cdm_2015` and `bsa_2022`
- The `cwicr-uk-gbp` cost region, which loads on demand
- A six-step onboarding wizard: company profile, measurement standard,
  contract suite, safety regime, cost data and review
- Union flag colours for co-branding

No modules are hidden and no new rule classes ship with the pack; it switches
on rules already present in the core.

## Cost data

**No commercial cost database is bundled.** The UK unit-price and benchmark
datasets sold by subscription are licensed products, and redistributing one
inside an AGPL pack is not something their terms allow.

What the `bcis_benchmarks` rule pack contains is the checks, not the rates:
whether a benchmark source is stated, whether a location factor has been
applied, whether a rate sits inside the expected band. Bring your own rates,
from your cost history, a subscription you hold or a published schedule, and
the pack tells you when they look wrong.

## Standards referenced

- RICS NRM 1 and NRM 2 (2nd edition, 2021), NRM 3 (2014)
- JCT 2024 contract suite
- CDM 2015, the Construction (Design and Management) Regulations
- Building Safety Act 2022, higher-risk building duties

These are referenced for interoperability and compliance checking. Clause and
section numbers are interoperability facts and are used as such; the
publishers' own text and tables are not reproduced here.

## Install

This pack ships inside OpenConstructionERP. Activate it from Modules then
Partner Packs: click Rescan, find "UK Construction Pack", then Activate pack.

To run a workspace that boots straight into it:

```bash
OE_PACK=uk-jct openconstructionerp serve
```

## License

AGPL-3.0-or-later. OpenConstructionERP is authored and owned by
DataDrivenConstruction.
