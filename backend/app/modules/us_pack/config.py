# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Regional configuration for the United States."""

from typing import Any

PACK_CONFIG: dict[str, Any] = {
    # ── Identity ─────────────────────────────────────────────────────────────
    "region_code": "US",
    "countries": ["US"],
    "default_currency": "USD",
    "default_locale": "en-US",
    "measurement_system": "imperial",
    "paper_size": "Letter",
    "date_format": "MM/DD/YYYY",
    "number_format": "1,234.56",
    # ── Standards ────────────────────────────────────────────────────────────
    # Division numbers are interoperability facts. The "scope" strings are our
    # own descriptions of the work each division covers - the proprietary
    # division titles must never be bundled (licensing denylist); users who
    # hold a licence import the official tables themselves.
    "standards": [
        {
            "code": "US_DIVISIONS",
            "name": "US specification division numbering",
            "description": "Division numbering for commercial/institutional construction",
            "divisions": [
                {"number": "00", "scope": "Bidding and contract-formation documents"},
                {"number": "01", "scope": "General project requirements and temporary provisions"},
                {"number": "02", "scope": "Demolition, site assessment and existing structures"},
                {"number": "03", "scope": "Cast-in-place and precast concrete work"},
                {"number": "04", "scope": "Brick, block and stone work"},
                {"number": "05", "scope": "Structural and miscellaneous metal work"},
                {"number": "06", "scope": "Carpentry, millwork and composite framing"},
                {"number": "07", "scope": "Roofing, waterproofing and insulation"},
                {"number": "08", "scope": "Doors, windows and glazed assemblies"},
                {"number": "09", "scope": "Interior finishing: drywall, flooring, painting"},
                {"number": "10", "scope": "Built-in specialty items and signage"},
                {"number": "11", "scope": "Fixed building equipment"},
                {"number": "12", "scope": "Furniture, casework and window treatments"},
                {"number": "13", "scope": "Pre-engineered and special-purpose structures"},
                {"number": "14", "scope": "Elevators, escalators and lifts"},
                {"number": "21", "scope": "Sprinkler and fire-suppression systems"},
                {"number": "22", "scope": "Piping systems and sanitary fixtures"},
                {"number": "23", "scope": "Heating, cooling and ventilation systems"},
                {"number": "25", "scope": "Building automation and controls integration"},
                {"number": "26", "scope": "Power distribution and lighting systems"},
                {"number": "27", "scope": "Voice, data and network cabling"},
                {"number": "28", "scope": "Fire alarm, access control and surveillance"},
                {"number": "31", "scope": "Excavation, grading and earth support"},
                {"number": "32", "scope": "Paving, landscaping and site amenities"},
                {"number": "33", "scope": "Site water, sewer, storm and power services"},
                {"number": "34", "scope": "Rail, transit and transportation infrastructure"},
                {"number": "35", "scope": "Marine, dredging and waterfront work"},
                {"number": "40", "scope": "Industrial process piping and interconnections"},
                {"number": "41", "scope": "Bulk material handling and processing plant"},
                {"number": "42", "scope": "Industrial process thermal equipment"},
                {"number": "43", "scope": "Industrial gas and liquid handling plant"},
                {"number": "44", "scope": "Emissions, effluent and waste treatment plant"},
                {"number": "45", "scope": "Manufacturing plant for specific industries"},
                {"number": "46", "scope": "Water and wastewater treatment plant"},
                {"number": "48", "scope": "On-site power generation plant"},
            ],
        },
        {
            "code": "US_ELEMENTAL",
            "name": "US elemental classification",
            "description": "Elemental classification for preliminary estimates (element names per NIST SP 841)",
        },
    ],
    # ── Contract types ───────────────────────────────────────────────────────
    "contract_types": [
        {
            "code": "AIA_A101",
            "name": "AIA A101 - Stipulated Sum",
            "description": "Standard owner-contractor agreement (fixed price)",
        },
        {
            "code": "AIA_A102",
            "name": "AIA A102 - Cost Plus Fee with GMP",
            "description": "Cost-plus with guaranteed maximum price",
        },
        {
            "code": "AIA_A201",
            "name": "AIA A201 - General Conditions",
            "description": "General conditions of the contract for construction",
        },
        {
            "code": "ConsensusDocs_200",
            "name": "ConsensusDocs 200 - Standard Agreement",
            "description": "Multi-party consensus-based standard agreement",
        },
    ],
    # ── Payment application format ───────────────────────────────────────────
    # Named generically: the well-known proprietary form identifiers are
    # trademarks and must not appear in code, UI or API (licensing denylist).
    # The field list below is arithmetic, which is not protectable.
    "payment_application": {
        "format": "US_PAY_APPLICATION",
        "name": "Application and Certificate for Payment",
        "description": (
            "Progress payment application with a schedule-of-values continuation sheet and a summary certificate"
        ),
        "fields": [
            "application_number",
            "period_to",
            "contract_sum",
            "change_orders",
            "adjusted_contract_sum",
            "completed_stored_previous",
            "completed_stored_this_period",
            "total_completed_stored",
            "retainage",
            "total_earned_less_retainage",
            "less_previous_certificates",
            "current_payment_due",
            "balance_to_finish",
        ],
    },
    # ── Tax rules ────────────────────────────────────────────────────────────
    "tax_rules": [
        {
            "code": "US_SALES_TAX",
            "name": "State & Local Sales Tax",
            "type": "sales_tax",
            "description": "Combined state + local sales tax (varies by jurisdiction)",
            "note": "Construction materials taxability varies by state",
            "examples": [
                {"state": "NY", "combined_rate_pct": "8.875", "note": "NYC rate"},
                {"state": "CA", "combined_rate_pct": "7.250", "note": "State minimum"},
                {"state": "TX", "combined_rate_pct": "6.250", "note": "State rate"},
                {"state": "FL", "combined_rate_pct": "6.000", "note": "State rate"},
                {"state": "WA", "combined_rate_pct": "6.500", "note": "State rate"},
            ],
        },
        {
            "code": "US_USE_TAX",
            "name": "Use Tax",
            "type": "use_tax",
            "description": "Applies to out-of-state purchases; same rate as sales tax",
        },
    ],
    # ── Federal holidays reference ───────────────────────────────────────────
    "holidays_reference": [
        {"name": "New Year's Day", "date_rule": "January 1"},
        {"name": "Martin Luther King Jr. Day", "date_rule": "Third Monday in January"},
        {"name": "Presidents' Day", "date_rule": "Third Monday in February"},
        {"name": "Memorial Day", "date_rule": "Last Monday in May"},
        {"name": "Juneteenth", "date_rule": "June 19"},
        {"name": "Independence Day", "date_rule": "July 4"},
        {"name": "Labor Day", "date_rule": "First Monday in September"},
        {"name": "Columbus Day", "date_rule": "Second Monday in October"},
        {"name": "Veterans Day", "date_rule": "November 11"},
        {"name": "Thanksgiving Day", "date_rule": "Fourth Thursday in November"},
        {"name": "Christmas Day", "date_rule": "December 25"},
    ],
    # ── Cost database integration stubs ──────────────────────────────────────
    "cost_database_integrations": [
        {
            "code": "us_commercial_cost_data",
            "name": "US commercial cost database",
            "description": "US construction cost data with city cost indices",
            "api_base_url": "",
            "enabled": False,
            "note": "Requires a commercial US cost-data subscription and API key",
        },
    ],
    # ── Units (imperial defaults) ────────────────────────────────────────────
    "default_units": {
        "length": "ft",
        "area": "sf",
        "volume": "cf",
        "weight": "lbs",
        "temperature": "°F",
        "pressure": "psi",
    },
    # ── VAT rates (Wave 25) ──────────────────────────────────────────────────
    # US has no federal VAT - per-state sales tax is modelled in tax_rules.
    # Empty dict is the explicit signal that this pack opts out of VAT.
    "vat_rates": {},
}
