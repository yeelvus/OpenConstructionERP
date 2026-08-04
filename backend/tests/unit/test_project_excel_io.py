# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
"""Unit tests for portfolio project Excel import helpers."""

from app.modules.projects.excel_io import (
    build_template_workbook,
    match_column,
    parse_lat_lng_pair,
    parse_rows_from_excel,
    project_to_export_row,
    row_to_project_create,
)


def test_match_column_zh_en():
    assert match_column("name") == "name"
    assert match_column("名称") == "name"
    assert match_column("项目名称") == "name"
    assert match_column("纬度") == "lat"
    assert match_column("经度") == "lng"
    assert match_column("项目编号") == "project_code"


def test_parse_dms_pair():
    lat, lng = parse_lat_lng_pair("""13°35'37.60"N 100°57'48.38"E""", "")
    assert lat is not None and lng is not None
    assert abs(lat - (13 + 35 / 60 + 37.6 / 3600)) < 1e-6
    assert abs(lng - (100 + 57 / 60 + 48.38 / 3600)) < 1e-6


def test_row_to_project_create_address():
    p = row_to_project_create(
        {
            "name": "Site A",
            "currency": "thb",
            "city": "Chonburi",
            "country": "Thailand",
            "lat": "13.59378",
            "lng": "100.96344",
        }
    )
    assert p.name == "Site A"
    assert p.currency == "THB"
    assert p.address is not None
    assert p.address["city"] == "Chonburi"
    assert abs(float(p.address["lat"]) - 13.59378) < 1e-5


def test_template_roundtrip_headers():
    data = build_template_workbook()
    rows = parse_rows_from_excel(data)
    assert len(rows) >= 1
    assert "name" in rows[0]


def test_excel_datetime_normalized_to_iso_date():
    from datetime import datetime

    p = row_to_project_create(
        {
            "name": "Dated Site",
            "planned_start_date": datetime(2026, 5, 26, 0, 0, 0),
            "planned_end_date": "2026-04-11 00:00:00",
        }
    )
    assert p.planned_start_date == "2026-05-26"
    assert p.planned_end_date == "2026-04-11"


def test_export_row_flattens_address():
    class P:
        name = "X"
        project_code = "C1"
        description = ""
        region = "China"
        classification_standard = ""
        currency = "CNY"
        locale = "zh"
        country_code = "CN"
        project_type = None
        phase = None
        client_id = None
        contract_value = None
        budget_estimate = None
        contingency_pct = None
        gross_floor_area = None
        planned_start_date = None
        planned_end_date = None
        default_vat_rate = None
        address = {"city": "Handan", "lat": 36.6, "lng": 114.5}

    row = project_to_export_row(P())
    assert row["name"] == "X"
    assert row["city"] == "Handan"
    assert row["lat"] == 36.6
