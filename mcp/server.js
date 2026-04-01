#!/usr/bin/env node
/**
 * StayPortal MCP Server — Read-only Supabase tools for Oline (Stay Management AI).
 *
 * Tools exposed:
 *   list_properties        — all properties with basic info
 *   get_property_context   — fallback: full context block for a property (access + units)
 *   get_unit_details       — single unit with lock/access data (legacy)
 *   search_property        — fuzzy match by name or address
 *   get_wifi_info          — WiFi SSID, router info for a unit (no password)
 *   get_bedroom_info       — bed count, types, sizes, wardrobe for a unit
 *   get_building_facilities — laundry + trash info for a property
 *   get_property_rules     — pets, parking, public transport, house rules
 *   get_unit_details_v2    — floor, sqm, balcony, mailbox, storage, meter ID
 *   get_listing_info       — Finn.no URL, availability, rent, deposit for a property
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authenticate, query, ensureAuth } from './supabase.js';

// ── Logger ──────────────────────────────────────────────────────────────────
// All logs go to stderr — stdout is reserved for the MCP stdio protocol.

function log(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, module: 'mcp-server', msg, ...extra };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_properties',
    description:
      'Returns all Stay Management properties with id, display name, address, owner type, and unit count. Use this to get an overview or to find a property id for further lookups.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_property_context',
    description:
      'FALLBACK TOOL — use only when no specific tool covers the question. Returns a full formatted context block for a property including all units, building access, and unit lock/access data. Pass the property name, nickname, or address fragment (e.g. "N94", "Nygårdsgaten 94").',
    inputSchema: {
      type: 'object',
      properties: {
        property: {
          type: 'string',
          description: 'Property name, nickname, or address fragment',
        },
      },
      required: ['property'],
    },
  },
  {
    name: 'get_unit_details',
    description:
      'Returns details for a single unit including unit name, lock system, door code, mailbox, and storage. Pass the unit name (e.g. "N94-101") or unit UUID. NEVER share door codes or mailbox codes with tenants.',
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Unit name (e.g. "N94-101") or unit UUID' },
      },
      required: ['unit'],
    },
  },
  {
    name: 'search_property',
    description:
      'Fuzzy search properties by name, nickname, or address fragment. Returns ranked matches. Use this when the tenant mentions a property name but you are not sure of the exact id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term — property name, nickname, or address fragment' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_wifi_info',
    description:
      'Returns WiFi SSID, router brand, router model, router location, and reset procedure for a unit. Does NOT return the WiFi password — that is sent directly to the tenant at move-in. Call this when a tenant asks about WiFi, internet, network name, router, or connection issues.',
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Unit name (e.g. "N94-301") or unit UUID' },
      },
      required: ['unit'],
    },
  },
  {
    name: 'get_bedroom_info',
    description:
      'Returns number of bedrooms, bed types, bed sizes in cm, whether rooms have wardrobes, room sizes (sqm), and whether any bedroom is an alcove. Call this when a tenant asks about beds, bed sizes, wardrobes, sleeping arrangements, or room layout.',
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Unit name (e.g. "N94-301") or unit UUID' },
      },
      required: ['unit'],
    },
  },
  {
    name: 'get_building_facilities',
    description:
      'Returns laundry facilities (shared laundry room, location, washer/dryer count) and trash facilities (boss brikke, trash location, pickup schedule, recycling station) for a property. Call this when a tenant asks about washing machines, laundry, trash, recycling, boss brikke, or waste disposal.',
    inputSchema: {
      type: 'object',
      properties: {
        property: { type: 'string', description: 'Property name, nickname, or address fragment' },
      },
      required: ['property'],
    },
  },
  {
    name: 'get_property_rules',
    description:
      'Returns property-specific rules and practical info: pets policy, parking (spaces, type, description), public transport options, house rules, check-in description, and trash description. Call this when a tenant asks about pets, parking, getting to the property, or property rules.',
    inputSchema: {
      type: 'object',
      properties: {
        property: { type: 'string', description: 'Property name, nickname, or address fragment' },
      },
      required: ['property'],
    },
  },
  {
    name: 'get_unit_details_v2',
    description:
      'Returns detailed unit info: floor number, size (sqm), total rooms, balcony (yes/no, size), mailbox number, storage number, and electricity meter ID and location. Call this when a tenant asks about apartment size, floor, balcony, mailbox, storage, or electricity meter. Does NOT return door codes or access codes.',
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Unit name (e.g. "N94-301") or unit UUID' },
      },
      required: ['unit'],
    },
  },
  {
    name: 'get_listing_info',
    description:
      'Returns listing data for a property: Finn.no URL, video tour URL (Google Drive), availability status, available-from date, rent amounts (tiered), deposit, lease end date, cancellation terms, restrictions, and whether internet is included. Call this when a prospective tenant asks about availability, rent price, deposit, video viewing, video tour, or the Finn.no listing.',
    inputSchema: {
      type: 'object',
      properties: {
        property: { type: 'string', description: 'Property name, nickname, or address fragment' },
      },
      required: ['property'],
    },
  },
];

// ── Shared helpers ──────────────────────────────────────────────────────────

function matchScore(prop, term) {
  const t = term.toLowerCase();
  const fields = [prop.display_name, prop.nickname, prop.address].map((f) =>
    (f || '').toLowerCase(),
  );
  if (fields.some((f) => f === t)) return 100;
  if (fields.some((f) => f.startsWith(t))) return 80;
  if (fields.some((f) => f.includes(t))) return 60;
  return 0;
}

async function resolveProperty(input) {
  log('debug', 'resolveProperty called', { input });
  const allProps = await query('properties', 'select=*');
  log('debug', 'resolveProperty: fetched all properties', { count: allProps.length });

  let prop = allProps.find((p) => p.id === input);
  if (prop) {
    log('info', 'resolveProperty: matched by UUID', { id: prop.id, name: prop.display_name || prop.nickname });
    return prop;
  }

  const scored = allProps
    .map((p) => ({ ...p, score: matchScore(p, input) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  prop = scored[0] || null;

  if (prop) {
    log('info', 'resolveProperty: fuzzy matched', {
      input,
      match: prop.display_name || prop.nickname,
      score: prop.score,
    });
  } else {
    log('warn', 'resolveProperty: no match found', { input, total_props: allProps.length });
  }

  return prop;
}

async function resolveUnit(input) {
  log('debug', 'resolveUnit called', { input });

  // Try UUID first, then exact unit_name match
  let units = await query('units', `select=*&id=eq.${input}`);
  if (units.length) {
    log('info', 'resolveUnit: matched by UUID', { id: units[0].id, unit_name: units[0].unit_name });
    return units[0];
  }

  units = await query('units', `select=*&unit_name=ilike.${encodeURIComponent(input)}`);
  if (units.length) {
    log('info', 'resolveUnit: matched by unit_name', { input, unit_name: units[0].unit_name });
  } else {
    log('warn', 'resolveUnit: no unit found', { input });
  }

  return units[0] || null;
}

// ── Tool implementations ────────────────────────────────────────────────────

async function listProperties() {
  log('info', 'tool:list_properties → start');
  await ensureAuth();
  const props = await query(
    'properties',
    'select=id,display_name,nickname,address,owner_type,onboarding_completed,created_at&order=created_at.asc',
  );
  const units = await query('units', 'select=id,property_id');
  log('debug', 'tool:list_properties → data fetched', { properties: props.length, units: units.length });

  const unitCountByProp = {};
  for (const u of units) {
    unitCountByProp[u.property_id] = (unitCountByProp[u.property_id] || 0) + 1;
  }

  const result = props.map((p) => ({
    id: p.id,
    name: p.display_name || p.nickname || '(unnamed)',
    address: p.address || null,
    owner_type: p.owner_type || null,
    onboarding_completed: p.onboarding_completed || false,
    unit_count: unitCountByProp[p.id] || 0,
  }));
  log('info', 'tool:list_properties → done', { returned: result.length });
  return result;
}

async function searchProperty(queryTerm) {
  log('info', 'tool:search_property → start', { query: queryTerm });
  await ensureAuth();
  const props = await query('properties', 'select=id,display_name,nickname,address,owner_type');
  const results = props
    .map((p) => ({ ...p, score: matchScore(p, queryTerm) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...p }) => ({
      id: p.id,
      name: p.display_name || p.nickname || '(unnamed)',
      address: p.address || null,
      owner_type: p.owner_type || null,
      match_score: score,
    }));
  log('info', 'tool:search_property → done', {
    query: queryTerm,
    hits: results.length,
    top_match: results[0]?.name || null,
  });
  return results;
}

async function getPropertyContext(propertyInput) {
  log('info', 'tool:get_property_context → start', { property: propertyInput });
  await ensureAuth();
  const prop = await resolveProperty(propertyInput);

  if (!prop) {
    log('warn', 'tool:get_property_context → property not found', { property: propertyInput });
    return {
      error: `Property not found: "${propertyInput}". Use list_properties or search_property to find the correct name.`,
    };
  }

  log('debug', 'tool:get_property_context → fetching parallel data', { property_id: prop.id });
  const [units, onboarding, buildingAccess, unitAccess] = await Promise.all([
    query('units', `select=*&property_id=eq.${prop.id}&order=created_at.asc`),
    query('onboarding_progress', `select=*&property_id=eq.${prop.id}`).catch(() => []),
    query('building_access', `select=*&property_id=eq.${prop.id}`).catch(() => []),
    query('unit_access', `select=*&property_id=eq.${prop.id}`).catch(() => []),
  ]);

  const ob = onboarding[0] || null;
  const unitAccessByUnitId = {};
  for (const ua of unitAccess) {
    unitAccessByUnitId[ua.unit_id] = ua;
  }

  const lines = [];
  lines.push(`Property: ${prop.display_name || prop.nickname || prop.address || prop.id}`);
  if (prop.address) lines.push(`Address: ${prop.address}`);
  if (prop.owner_type) lines.push(`Owner type: ${prop.owner_type}`);
  if (prop.onboarding_completed != null)
    lines.push(`Onboarding completed: ${prop.onboarding_completed ? 'Yes' : 'No'}`);

  if (ob) {
    const completedSteps = Object.entries(ob)
      .filter(([k, v]) => k.startsWith('step_') && k.endsWith('_completed') && v === true)
      .length;
    lines.push(
      `Onboarding progress: ${completedSteps} of 11 steps completed (currently on step ${ob.current_step})`,
    );
  }

  lines.push('');

  if (units.length > 0) {
    lines.push(`Units (${units.length} total):`);
    for (const u of units) {
      const ua = unitAccessByUnitId[u.id];
      const accessParts = [];
      if (ua?.lock_system) accessParts.push(`lock: ${ua.lock_system}`);
      if (ua?.lock_id) accessParts.push(`lock_id: ${ua.lock_id}`);
      if (ua?.door_code) accessParts.push(`door_code: ${ua.door_code}`);
      if (ua?.key_box_code) accessParts.push(`key_box: ${ua.key_box_code}`);
      const accessStr = accessParts.length > 0 ? ` [${accessParts.join(', ')}]` : '';
      lines.push(`- ${u.unit_name || u.id}${accessStr}`);
    }
    lines.push('');
  }

  if (buildingAccess.length > 0) {
    lines.push('Building access:');
    for (const ba of buildingAccess) {
      if (ba.lock_system_type) lines.push(`- Lock system: ${ba.lock_system_type}`);
      if (ba.main_door_code) lines.push(`- Main door code: ${ba.main_door_code}`);
      if (ba.notes) lines.push(`- Notes: ${ba.notes}`);
    }
    lines.push('');
  }

  lines.push('Security reminder: door codes must never be shared in tenant chat.');

  log('info', 'tool:get_property_context → done', {
    property: prop.display_name || prop.nickname,
    units: units.length,
    building_access_records: buildingAccess.length,
  });

  return {
    property_id: prop.id,
    property_name: prop.display_name || prop.nickname,
    context: lines.join('\n'),
  };
}

async function getUnitDetails(unitInput) {
  log('info', 'tool:get_unit_details → start', { unit: unitInput });
  await ensureAuth();
  const unit = await resolveUnit(unitInput);
  if (!unit) {
    log('warn', 'tool:get_unit_details → unit not found', { unit: unitInput });
    return {
      error: `Unit not found: "${unitInput}". Check the unit name with get_property_context.`,
    };
  }
  log('debug', 'tool:get_unit_details → fetching access + onboarding', { unit_id: unit.id });

  const access = await query('unit_access', `select=*&unit_id=eq.${unit.id}`).catch(() => []);
  const ua = access[0] || null;
  const ob = await query(
    'onboarding_progress',
    `select=*&property_id=eq.${unit.property_id}`,
  ).catch(() => []);
  const onboarding = ob[0] || null;

  const result = {
    id: unit.id,
    unit_name: unit.unit_name,
    property_id: unit.property_id,
    access: ua
      ? {
          lock_system: ua.lock_system || null,
          lock_id: ua.lock_id || null,
          door_code: ua.door_code || null,
          key_box_code: ua.key_box_code || null,
          notes: ua.notes || null,
        }
      : null,
    onboarding: onboarding
      ? {
          current_step: onboarding.current_step,
          steps_completed: Object.entries(onboarding)
            .filter(([k, v]) => k.startsWith('step_') && k.endsWith('_completed') && v === true)
            .map(([k]) => parseInt(k.replace('step_', '').replace('_completed', ''), 10))
            .sort((a, b) => a - b),
        }
      : null,
  };
  log('info', 'tool:get_unit_details → done', {
    unit: unit.unit_name,
    has_access: !!ua,
    has_onboarding: !!onboarding,
  });
  return result;
}

// ── New tools ───────────────────────────────────────────────────────────────

async function getWifiInfo(unitInput) {
  log('info', 'tool:get_wifi_info → start', { unit: unitInput });
  await ensureAuth();
  const unit = await resolveUnit(unitInput);
  if (!unit) {
    log('warn', 'tool:get_wifi_info → unit not found', { unit: unitInput });
    return { error: `Unit not found: "${unitInput}". Check the unit name.` };
  }

  const wifi = await query(
    'unit_wifi',
    `select=ssid,router_brand,router_model,router_location,reset_procedure,separate_isp&unit_id=eq.${unit.id}`,
  ).catch(() => []);
  const w = wifi[0] || null;

  if (!w) {
    log('warn', 'tool:get_wifi_info → no WiFi record found', { unit: unit.unit_name });
    return {
      error: `No WiFi data found for unit "${unitInput}". Direct tenant to tenant@stay.no.`,
    };
  }

  log('info', 'tool:get_wifi_info → done', { unit: unit.unit_name, ssid: w.ssid });
  return {
    unit: unit.unit_name,
    ssid: w.ssid || null,
    router_brand: w.router_brand || null,
    router_model: w.router_model || null,
    router_location: w.router_location || null,
    reset_procedure: w.reset_procedure || null,
    separate_isp: w.separate_isp || false,
    note: 'WiFi password is NOT included — sent directly to tenant at move-in. Never share in chat.',
  };
}

async function getBedroomInfo(unitInput) {
  log('info', 'tool:get_bedroom_info → start', { unit: unitInput });
  await ensureAuth();
  const unit = await resolveUnit(unitInput);
  if (!unit) {
    log('warn', 'tool:get_bedroom_info → unit not found', { unit: unitInput });
    return { error: `Unit not found: "${unitInput}". Check the unit name.` };
  }

  const bedrooms = await query(
    'bedroom_details',
    `select=bedroom_number,bed_type,bed_size_cm,max_guests,room_sqm,has_wardrobe,room_lock_type,is_alcove&unit_id=eq.${unit.id}&order=bedroom_number.asc`,
  ).catch(() => []);

  if (!bedrooms.length) {
    log('warn', 'tool:get_bedroom_info → no bedroom records found', { unit: unit.unit_name });
    return { error: `No bedroom data found for unit "${unitInput}". Direct tenant to tenant@stay.no.` };
  }

  log('info', 'tool:get_bedroom_info → done', { unit: unit.unit_name, bedrooms: bedrooms.length });
  return {
    unit: unit.unit_name,
    total_bedrooms: bedrooms.length,
    bedrooms: bedrooms.map((b) => ({
      bedroom_number: b.bedroom_number,
      bed_type: b.bed_type || null,
      bed_size_cm: b.bed_size_cm || null,
      max_guests: b.max_guests || null,
      room_sqm: b.room_sqm || null,
      has_wardrobe: b.has_wardrobe || false,
      is_alcove: b.is_alcove || false,
      room_lock_type: b.room_lock_type || null,
    })),
  };
}

async function getBuildingFacilities(propertyInput) {
  log('info', 'tool:get_building_facilities → start', { property: propertyInput });
  await ensureAuth();
  const prop = await resolveProperty(propertyInput);
  if (!prop) {
    log('warn', 'tool:get_building_facilities → property not found', { property: propertyInput });
    return { error: `Property not found: "${propertyInput}". Use search_property.` };
  }

  log('debug', 'tool:get_building_facilities → fetching laundry + trash', { property_id: prop.id });
  const [laundry, trash] = await Promise.all([
    query(
      'building_laundry',
      `select=has_shared_laundry,laundry_location,washer_count,dryer_count&property_id=eq.${prop.id}`,
    ).catch(() => []),
    query(
      'building_trash',
      `select=trash_location,has_boss_brikke,boss_brikke_id,boss_brikke_holder,pickup_schedule,recycling_station_address,trash_type&property_id=eq.${prop.id}`,
    ).catch(() => []),
  ]);

  const l = laundry[0] || null;
  const t = trash[0] || null;

  log('info', 'tool:get_building_facilities → done', {
    property: prop.display_name || prop.nickname,
    has_laundry: !!l,
    has_trash: !!t,
  });

  return {
    property: prop.display_name || prop.nickname,
    laundry: l
      ? {
          has_shared_laundry: l.has_shared_laundry || false,
          location: l.laundry_location || null,
          washer_count: l.washer_count || null,
          dryer_count: l.dryer_count || null,
        }
      : null,
    trash: t
      ? {
          location: t.trash_location || null,
          has_boss_brikke: t.has_boss_brikke || false,
          boss_brikke_id: t.boss_brikke_id || null,
          boss_brikke_holder: t.boss_brikke_holder || null,
          pickup_schedule: t.pickup_schedule || null,
          recycling_station: t.recycling_station_address || null,
          trash_type: t.trash_type || null,
        }
      : null,
  };
}

async function getPropertyRules(propertyInput) {
  log('info', 'tool:get_property_rules → start', { property: propertyInput });
  await ensureAuth();
  const prop = await resolveProperty(propertyInput);
  if (!prop) {
    log('warn', 'tool:get_property_rules → property not found', { property: propertyInput });
    return { error: `Property not found: "${propertyInput}". Use search_property.` };
  }

  const details = await query(
    'property_details',
    `select=pets_allowed,pet_fee,parking_spaces,parking_type,parking_description,house_rules,public_transport,trash_description,checkin_description,outdoor_space&property_id=eq.${prop.id}`,
  ).catch(() => []);
  const d = details[0] || null;

  if (!d) {
    log('warn', 'tool:get_property_rules → no property_details record found', { property: prop.display_name || prop.nickname });
    return {
      property: prop.display_name || prop.nickname,
      note: 'No property rules data available yet. Fall back to universal lease contract rules.',
    };
  }

  log('info', 'tool:get_property_rules → done', {
    property: prop.display_name || prop.nickname,
    pets_allowed: d.pets_allowed,
    parking_spaces: d.parking_spaces,
  });

  return {
    property: prop.display_name || prop.nickname,
    pets_allowed: d.pets_allowed ?? null,
    pet_fee: d.pet_fee || null,
    parking_spaces: d.parking_spaces ?? null,
    parking_type: d.parking_type || null,
    parking_description: d.parking_description || null,
    house_rules: d.house_rules || null,
    public_transport: d.public_transport || null,
    trash_description: d.trash_description || null,
    checkin_description: d.checkin_description || null,
    outdoor_space: d.outdoor_space || null,
  };
}

async function getUnitDetailsV2(unitInput) {
  log('info', 'tool:get_unit_details_v2 → start', { unit: unitInput });
  await ensureAuth();
  const unit = await resolveUnit(unitInput);
  if (!unit) {
    log('warn', 'tool:get_unit_details_v2 → unit not found', { unit: unitInput });
    return { error: `Unit not found: "${unitInput}". Check the unit name.` };
  }

  log('debug', 'tool:get_unit_details_v2 → fetching access + power', { unit_id: unit.id });
  const [access, power] = await Promise.all([
    query(
      'unit_access',
      `select=mailbox_number,storage_number,keys_count&unit_id=eq.${unit.id}`,
    ).catch(() => []),
    query(
      'unit_power',
      `select=meter_id,meter_location,hot_water_meter_id&unit_id=eq.${unit.id}`,
    ).catch(() => []),
  ]);

  const a = access[0] || null;
  const p = power[0] || null;

  const result = {
    unit_name: unit.unit_name,
    floor_number: unit.floor_number || null,
    square_meters: unit.square_meters || null,
    total_rooms: unit.total_rooms || null,
    unit_type: unit.unit_type || null,
    has_balcony: unit.has_balcony || false,
    balcony_sqm: unit.balcony_sqm || null,
    balcony_furnished: unit.balcony_furnished || false,
    mailbox_number: a?.mailbox_number || null,
    storage_number: a?.storage_number || null,
    keys_count: a?.keys_count || null,
    electricity_meter_id: p?.meter_id || null,
    electricity_meter_location: p?.meter_location || null,
    hot_water_meter_id: p?.hot_water_meter_id || null,
  };
  log('info', 'tool:get_unit_details_v2 → done', {
    unit: unit.unit_name,
    floor: result.floor_number,
    sqm: result.square_meters,
    has_balcony: result.has_balcony,
  });
  return result;
}

async function getListingInfo(propertyInput) {
  log('info', 'tool:get_listing_info → start', { property: propertyInput });
  await ensureAuth();
  const prop = await resolveProperty(propertyInput);
  if (!prop) {
    log('warn', 'tool:get_listing_info → property not found', { property: propertyInput });
    return { error: `Property not found: "${propertyInput}". Use search_property.` };
  }

  const listings = await query(
    'temp_property_listings',
    `select=*&property_id=eq.${prop.id}`,
  ).catch(() => []);
  const l = listings[0] || null;

  if (!l) {
    log('warn', 'tool:get_listing_info → no listing record found', { property: prop.display_name || prop.nickname });
    return {
      error: `No listing data for "${propertyInput}". Direct tenant to tenant@stay.no.`,
    };
  }

  log('info', 'tool:get_listing_info → done', {
    property: prop.display_name || prop.nickname,
    is_available: l.is_available,
    available_from: l.available_from,
  });

  return {
    property: prop.display_name || prop.nickname,
    finn_url: l.finn_url || null,
    video_url: l.video_url || null,
    is_available: l.is_available || false,
    available_from: l.available_from || null,
    rent_apr_jul_nok: l.rent_apr_jul_nok || null,
    rent_aug_onwards_nok: l.rent_aug_onwards_nok || null,
    deposit_nok: l.deposit_nok || null,
    lease_end: l.lease_end || null,
    cancellation_terms: l.cancellation_terms || null,
    restrictions: l.restrictions || [],
    internet_included: l.internet_included || false,
    internet_cost_nok: l.internet_cost_nok || null,
  };
}

// ── MCP Server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'stayportal-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('debug', 'list_tools requested', { tool_count: TOOLS.length });
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log('info', 'tool call received', { tool: name, args });
  const t0 = Date.now();

  try {
    let result;

    switch (name) {
      case 'list_properties':
        result = await listProperties();
        break;
      case 'get_property_context':
        result = await getPropertyContext(args.property);
        break;
      case 'get_unit_details':
        result = await getUnitDetails(args.unit);
        break;
      case 'search_property':
        result = await searchProperty(args.query);
        break;
      case 'get_wifi_info':
        result = await getWifiInfo(args.unit);
        break;
      case 'get_bedroom_info':
        result = await getBedroomInfo(args.unit);
        break;
      case 'get_building_facilities':
        result = await getBuildingFacilities(args.property);
        break;
      case 'get_property_rules':
        result = await getPropertyRules(args.property);
        break;
      case 'get_unit_details_v2':
        result = await getUnitDetailsV2(args.unit);
        break;
      case 'get_listing_info':
        result = await getListingInfo(args.property);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    log('info', 'tool call success', { tool: name, ms: Date.now() - t0 });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    log('error', 'tool call error', { tool: name, ms: Date.now() - t0, error: err.message });
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  log('info', 'MCP server starting', { name: 'stayportal-mcp', version: '2.0.0' });
  await authenticate();
  log('info', 'Supabase auth complete — connecting transport');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'MCP server ready', { tools: TOOLS.map((t) => t.name) });
}

main().catch((err) => {
  log('error', 'MCP server fatal error', { error: err.message });
  process.exit(1);
});
