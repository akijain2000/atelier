-- Migration: create temp_property_listings table (detailed)
-- Run this in Supabase Dashboard → SQL Editor

DROP TABLE IF EXISTS temp_property_listings;

CREATE TABLE IF NOT EXISTS temp_property_listings (

  -- ── Identifiers ──────────────────────────────────────────────────────────
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               UUID REFERENCES properties(id) ON DELETE CASCADE,
  finn_code                 TEXT,                        -- e.g. '457716772'
  finn_url                  TEXT,

  -- ── Listing Metadata ─────────────────────────────────────────────────────
  listing_title             TEXT,                        -- ad headline
  property_type             TEXT,                        -- 'Leilighet', 'Hybel', 'Rekkehus', etc.
  listing_classification    TEXT,                        -- 'Bolig til leie'
  last_updated_at           TIMESTAMPTZ,                 -- when the Finn.no ad was last updated

  -- ── Location ─────────────────────────────────────────────────────────────
  street_address            TEXT,                        -- e.g. 'Nygårdsgaten 94'
  postal_code               TEXT,                        -- e.g. '5008'
  city                      TEXT,                        -- e.g. 'Bergen'
  neighborhood              TEXT,                        -- e.g. 'Nygårdshøyden'
  sub_area                  TEXT,                        -- e.g. 'Bergen Sentrum'
  county                    TEXT,                        -- e.g. 'Vestland'
  municipality              TEXT,                        -- e.g. 'Bergen'
  latitude                  NUMERIC(9,6),
  longitude                 NUMERIC(9,6),

  -- ── Pricing ──────────────────────────────────────────────────────────────
  rent_nok                  INTEGER,                     -- primary / long-term monthly rent
  rent_apr_jul_nok          INTEGER,                     -- promotional period rent (Apr–Jul 2026)
  rent_aug_onwards_nok      INTEGER,                     -- standard rent from Aug 2026 onward
  rent_periods              JSONB,                       -- [{"from":"2026-04-01","to":"2026-07-31","rent":19000}, ...]
  deposit_nok               INTEGER,
  deposit_method            TEXT,                        -- e.g. 'Hybel.no'
  internet_cost_nok         INTEGER,                     -- separate monthly internet fee

  -- ── Physical Attributes ──────────────────────────────────────────────────
  area_sqm                  INTEGER,                     -- usable floor area
  num_rooms                 INTEGER,                     -- total rooms (including sleeping alcoves)
  num_bedrooms              INTEGER,                     -- dedicated bedrooms
  floor_number              INTEGER,                     -- which floor the unit is on
  total_floors              INTEGER,                     -- total floors in the building
  is_furnished              BOOLEAN DEFAULT false,

  -- ── Lease Terms ──────────────────────────────────────────────────────────
  available_from            DATE,
  lease_end                 DATE,
  lease_duration_years      NUMERIC(4,1),
  cancellation_terms        TEXT,                        -- plain-text notice / termination rules

  -- ── Utilities Included in Rent ───────────────────────────────────────────
  water_included            BOOLEAN DEFAULT false,
  sewage_included           BOOLEAN DEFAULT false,
  internet_included         BOOLEAN DEFAULT false,
  heating_included          BOOLEAN DEFAULT false,
  electricity_included      BOOLEAN DEFAULT false,

  -- ── Building Amenities ───────────────────────────────────────────────────
  has_elevator              BOOLEAN DEFAULT false,
  has_balcony               BOOLEAN DEFAULT false,
  has_rooftop_terrace       BOOLEAN DEFAULT false,
  has_parking               BOOLEAN DEFAULT false,       -- street or garage
  parking_type              TEXT,                        -- 'Street', 'Garage', 'None'
  has_storage               BOOLEAN DEFAULT false,
  has_bicycle_storage       BOOLEAN DEFAULT false,
  has_laundry_room          BOOLEAN DEFAULT false,       -- shared laundry

  -- ── Interior Features ────────────────────────────────────────────────────
  has_broadband             BOOLEAN DEFAULT false,
  has_heated_floor          BOOLEAN DEFAULT false,
  has_parquet_flooring      BOOLEAN DEFAULT false,
  heating_type              TEXT,                        -- 'Electric', 'District heating', etc.
  living_room_features      TEXT[],                      -- ['Sofa', 'Dining table', 'TV']
  kitchen_features          TEXT[],                      -- ['Fridge', 'Stove', 'Cooktop', 'Dishwasher']
  bathroom_features         TEXT[],                      -- ['Shower', 'WC', 'Heated floor', 'Tiled']

  -- ── House Rules & Restrictions ───────────────────────────────────────────
  pets_allowed              BOOLEAN DEFAULT false,
  smoking_allowed           BOOLEAN DEFAULT false,
  insurance_required        BOOLEAN DEFAULT false,       -- tenant liability insurance
  restrictions              TEXT[],                      -- free-text list of rules

  -- ── Nearby Amenities ─────────────────────────────────────────────────────
  nearby_institutions       TEXT[],                      -- ['UiB', 'HVL', 'BI Bergen', 'Media City Bergen']
  nearby_landmarks          TEXT[],                      -- ['Nygårdsparken', 'Public transport', 'Cafes']

  -- ── Tags / Search Labels ─────────────────────────────────────────────────
  amenity_tags              TEXT[],                      -- ['Furnished', 'Balcony', 'Broadband', 'Elevator', ...]

  -- ── Media ────────────────────────────────────────────────────────────────
  video_url                 TEXT,
  image_urls                TEXT[],

  -- ── Status ───────────────────────────────────────────────────────────────
  is_available              BOOLEAN DEFAULT true,

  -- ── Full Description ─────────────────────────────────────────────────────
  -- Human-readable summary combining all listing details.
  -- Used for LLM context, embeddings, and full-text search.
  description               TEXT,

  -- ── Timestamps ───────────────────────────────────────────────────────────
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

-- ── Seed: Nygårdsgaten 94 (N94) from Finn.no finnkode=457716772 ──────────────

INSERT INTO temp_property_listings (
  property_id,
  finn_code,
  finn_url,
  listing_title,
  property_type,
  listing_classification,
  last_updated_at,

  street_address,
  postal_code,
  city,
  neighborhood,
  sub_area,
  county,
  municipality,

  rent_nok,
  rent_apr_jul_nok,
  rent_aug_onwards_nok,
  rent_periods,
  deposit_nok,
  deposit_method,
  internet_cost_nok,

  area_sqm,
  num_rooms,
  num_bedrooms,
  floor_number,
  is_furnished,

  available_from,
  lease_end,
  lease_duration_years,
  cancellation_terms,

  water_included,
  sewage_included,
  internet_included,
  heating_included,
  electricity_included,

  has_elevator,
  has_balcony,
  has_rooftop_terrace,
  has_parking,
  parking_type,

  has_broadband,
  has_heated_floor,
  has_parquet_flooring,
  heating_type,
  living_room_features,
  kitchen_features,
  bathroom_features,

  pets_allowed,
  smoking_allowed,
  insurance_required,
  restrictions,

  nearby_institutions,
  nearby_landmarks,
  amenity_tags,

  video_url,
  is_available,

  description
) VALUES (
  'e9397d6a-d151-43da-b4cb-1cd482391b80',
  '457716772',
  'https://www.finn.no/realestate/lettings/ad.html?finnkode=457716772',
  'Møblert 2-roms leilighet på Nygårdshøyden +/- ledig fra 1. april',
  'Leilighet',
  'Bolig til leie',
  '2026-03-30 12:43:00+01',

  'Nygårdsgaten 94',
  '5008',
  'Bergen',
  'Nygårdshøyden',
  'Bergen Sentrum',
  'Vestland',
  'Bergen',

  -- Pricing
  22000,     -- standard long-term rent
  19000,     -- promotional rent Apr–Jul 2026
  22000,     -- standard rent Aug 2026 onward
  '[{"from":"2026-04-01","to":"2026-07-31","rent_nok":19000},{"from":"2026-08-01","to":"2029-07-31","rent_nok":22000}]'::JSONB,
  19600,
  'Hybel.no',
  600,

  -- Physical
  45,
  2,    -- 2 rooms (1 bedroom + 1 sleeping alcove)
  1,    -- 1 dedicated bedroom
  4,    -- 4th floor
  true, -- fully furnished

  -- Lease
  '2026-04-01',
  '2029-07-31',
  3.0,
  'Written notice required by April 30 each year; cancellation takes effect July 31',

  -- Utilities
  true,   -- water included
  true,   -- sewage included
  true,   -- internet included (600 kr/month billed separately)
  false,  -- heating NOT included (electric self-pay)
  false,  -- electricity NOT included (self-pay)

  -- Building amenities
  true,           -- elevator
  true,           -- french balcony
  true,           -- shared rooftop terrace
  true,           -- street parking available
  'Street',

  -- Interior
  true,  -- broadband
  true,  -- heated bathroom floor
  true,  -- parquet flooring
  'Electric',
  ARRAY['Sofa', 'Dining table', 'TV'],
  ARRAY['Combination refrigerator', 'Stove', 'Cooktop'],
  ARRAY['Shower', 'WC', 'Heated floor', 'Tiled'],

  -- Rules
  false,  -- no pets
  false,  -- no smoking
  true,   -- tenant insurance required
  ARRAY['No pets', 'No smoking', 'Contents insurance with liability coverage required'],

  -- Nearby
  ARRAY['UiB (University of Bergen)', 'HVL (Western Norway University of Applied Sciences)', 'BI Bergen', 'Media City Bergen'],
  ARRAY['Nygårdsparken', 'Public transport', 'Shopping', 'Cafes and restaurants'],
  ARRAY['Furnished', 'Balcony', 'Rooftop terrace', 'Broadband', 'Elevator', 'Parquet', 'Modern', 'Central', 'Quiet'],

  'https://drive.google.com/file/d/1-i-B0aCXu7AlW9sPUXmqgxmvo0SK-mtN/view?usp=drive_link',
  true,

  -- description: full plain-text summary for LLM context / embeddings
  'Møblert 2-roms leilighet på Nygårdshøyden, Bergen (Finn.no 457716772). ' ||
  'Adresse: Nygårdsgaten 94, 5008 Bergen. Nabolag: Nygårdshøyden, Bergen Sentrum, Vestland. ' ||
  'Størrelse: 45 m², 2 rom (1 soverom + 1 sovealkov), 4. etasje med heis. Fullt møblert og innflyttingsklar. ' ||
  'Leiepris: 19 000 kr/mnd (1. april–31. juli 2026), deretter 22 000 kr/mnd fra 1. august 2026. ' ||
  'Internett faktureres separat: 600 kr/mnd. Depositum: 19 600 kr via Hybel.no. ' ||
  'Leieperiode: 1. april 2026–31. juli 2029 (3 år). Oppsigelse: skriftlig innen 30. april, virkning 31. juli hvert år. ' ||
  'Inkludert i husleie: vann og avløp. Strøm og oppvarming betales av leietaker (elektrisk oppvarming, varmt gulv på bad). ' ||
  'Bygningsfasiliteter: heis, fransk balkong, felles takterrasse, gateparkering tilgjengelig. ' ||
  'Innredning: stue med sofa, spisebord og TV; kjøkken med kombi kjøleskap, komfyr og koketopp; ' ||
  'flislagt bad med gulvvarme, dusj og WC; parkettgulv i stue og soverom. ' ||
  'Regler: ingen kjæledyr, ingen røyking, innboforsikring med ansvarsdekking påkrevd. ' ||
  'I nærheten: UiB, HVL, BI Bergen, Media City Bergen, Nygårdsparken, kollektivtransport, butikker og kafeer. ' ||
  'Media: videovisitten tilgjengelig via Google Drive.'
)
ON CONFLICT DO NOTHING;
