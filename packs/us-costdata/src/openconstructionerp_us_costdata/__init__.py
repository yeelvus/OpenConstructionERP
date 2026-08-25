"""OpenConstructionERP — US Construction partner pack.

Pre-configured for US general contractors:

* **CSI MasterFormat 2020** — 35 active Divisions of specification structure
* **UniFormat II (ASTM E1557)** — elemental classification for early-stage estimating
* **AIA A201-2017** — General Conditions (incorporated into every project)
* **AIA Owner-Contractor agreement family** — A101 stipulated sum, A102 GMP/CMAR,
  A103 cost-plus, A104 abbreviated, A141 design-build
* **OSHA 29 CFR 1926** — Construction Industry safety regulations
* **IBC 2021** — International Building Code (state amendment overrides supported)
* **City cost index** — regional localization of the cost data the user imports

No commercial cost database is bundled: the pack is the structure that
user-supplied rates are imported into. See ``README.md``.

This package exports a module-level ``MANIFEST`` instance of
:class:`PartnerPackManifest` referenced from ``pyproject.toml``::

    [project.entry-points."openconstructionerp.partner_packs"]
    us-costdata = "openconstructionerp_us_costdata:MANIFEST"

The OCERP core discovers this entry point at boot, validates the
manifest, and applies the partner overrides (branding, locale,
cost regions, validation rule packs, onboarding script).
"""

from __future__ import annotations

from .manifest import MANIFEST

__all__ = ["MANIFEST"]
__version__ = "0.2.0"
