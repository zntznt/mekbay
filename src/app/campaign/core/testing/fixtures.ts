// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Synthetic test fixtures: an invented publication and a handful of units with
 * made-up numbers. Nothing here is taken from a published campaign.
 */

import { GameSystem } from '../../../models/common.model';
import type { RunnerEnv } from '../campaign.model';
import { seededRng } from '../dice';
import { newBrief, newCampaignMap, newContract, newHexType, newPublication, newTable, newTrack, type BriefNode, type CampaignMap, type Publication } from '../publication.model';
import { unitLookupFrom, type CampaignUnitData } from '../units';

const unit = (name: string, chassis: string, model: string, o: Partial<CampaignUnitData> & { pv: number; sz: number }): CampaignUnitData => ({
    name, chassis, model, type: 'Mek', subtype: 'BattleMek', tons: 50, bv: 1000, techBase: 'Inner Sphere', year: 3025,
    ...o, as: { PV: o.pv, SZ: o.sz, specials: o.as?.specials ?? [] },
});

export const UNITS: CampaignUnitData[] = [
    unit('Locust LCT-1V', 'Locust', 'LCT-1V', { tons: 20, bv: 430, pv: 18, sz: 1 }),
    unit('Wolverine WVR-6R', 'Wolverine', 'WVR-6R', { tons: 55, bv: 1100, pv: 31, sz: 2 }),
    unit('Atlas AS7-D', 'Atlas', 'AS7-D', { tons: 100, bv: 1900, pv: 52, sz: 4 }),
    unit('Timber Wolf Prime', 'Timber Wolf', 'Prime', { tons: 75, bv: 2700, pv: 54, sz: 3, techBase: 'Clan', subtype: 'BattleMek Omni', omni: 1 }),
    unit('Timber Wolf A', 'Timber Wolf', 'A', { tons: 75, bv: 2600, pv: 52, sz: 3, techBase: 'Clan', subtype: 'BattleMek Omni', omni: 1 }),
    unit('Manticore Heavy Tank', 'Manticore Heavy Tank', '', { type: 'Tank', subtype: 'Combat Vehicle', tons: 60, bv: 1000, pv: 30, sz: 3 }),
    unit('Phoenix Hawk PXH-1', 'Phoenix Hawk', 'PXH-1', { tons: 45, bv: 1040, pv: 29, sz: 2, as: { PV: 29, SZ: 2, specials: ['ENE'] } }),
];
export const lookup = unitLookupFrom(UNITS);

/**
 * "Glass Harbor": an invented two-month raid.
 * Month 1: track n1; branch on n1 → A wins: n2, B wins: n3. Month 2: track n4.
 */
export function makePublication(): Publication {
    const pub = newPublication();
    pub.title = 'Test publication';
    pub.systems = [GameSystem.CLASSIC, GameSystem.ALPHA_STRIKE];

    const strike = { ...newTrack(), id: 'tr_strike', name: 'Strike', generalRef: 'strike' };
    const hold = { ...newTrack(), id: 'tr_hold', name: 'Hold', generalRef: 'defend', salvage: 'none' };
    pub.tracks.push(strike, hold);

    const ct = { ...newContract(), id: 'ct_glass', name: 'Glass Harbor', employer: 'Test Employer', length: 2 };
    ct.location.planet = 'Testworld';
    const brief = { ...newBrief(), id: 'mb_glass', name: 'Glass Harbor brief', intensity: { min: 3, max: 3 } };
    brief.sides[0].contractId = ct.id;
    ct.briefId = brief.id;
    const track = (id: string, trackId: string): BriefNode => ({ id, kind: 'track', trackId, attacker: 'A', label: '', optional: false });
    brief.months = [
        {
            id: 'mo1', note: '', nodes: [
                track('n1', strike.id),
                { id: 'b1', kind: 'branch', of: 'n1', cases: [{ when: 'A', nodes: [track('n2', strike.id)] }, { when: 'B', nodes: [track('n3', hold.id)] }] },
            ],
        },
        { id: 'mo2', note: '', nodes: [track('n4', hold.id)] },
    ];
    brief.victoryConds.A = [{ kind: 'winCount', n: 2, nodes: [] }];
    pub.contracts.push(ct);
    pub.briefs.push(brief);

    // A contract-type table for the generator test.
    const types = { ...newTable(), id: 'tb_type', name: 'Contract type', die: '1D6' };
    types.rows = [
        { min: 1, max: 3, tag: 'Raid', cells: { r: { kind: 'text', text: 'Objective Raid' } } },
        { min: 4, max: 6, tag: 'Garrison', cells: { r: { kind: 'text', text: 'Garrison duty' } } },
    ];
    const pay = { ...newTable(), id: 'tb_pay', name: 'Base Pay', die: '1D6' };
    pay.rows = [
        { min: 1, max: 3, cells: { r: { kind: 'step', term: 'basePay', mode: 'set', value: 6 } } },
        { min: 4, max: 6, cells: { r: { kind: 'step', term: 'basePay', mode: 'set', value: 8 } } },
    ];
    pub.tables.push(types, pay);
    pub.generators.push({
        id: 'gn_contract', name: 'Contract generator', purpose: 'contract', inputs: [], attackerRolls: [],
        steps: [
            { id: 's_type', label: 'Type', tableId: types.id, assign: 'type' },
            { id: 's_pay', label: 'Pay', tableId: pay.id, assign: 'basePay', shifts: [{ from: 's_type', tag: 'garrison', add: -1 }] },
        ],
    });

    // A random-contract generator: type and pay as above, length and tracks known at signing;
    // the monthly track pattern and the track table are briefing details.
    const text = (id: string, name: string, value: string) => ({
        ...newTable(), id, name, die: '1D6', rows: [{ min: 1, max: 6, cells: { r: { kind: 'text' as const, text: value } } }],
    });
    const raidTracks = { ...newTable(), id: 'tb_raid_tracks', name: 'Raid tracks', die: '1D6' };
    raidTracks.rows = [
        { min: 1, max: 3, cells: { r: { kind: 'track', trackId: strike.id, attacker: 'A' } } },
        { min: 4, max: 6, cells: { r: { kind: 'track', trackId: hold.id, attacker: 'B' } } },
    ];
    pub.tables.push(text('tb_len', 'Length', '2 months'), text('tb_jumps', 'Jumps', '3'), text('tb_pattern', 'Pattern', '1-2'), raidTracks);
    pub.generators.push({
        id: 'gn_offer', name: 'Hall offers', purpose: 'contract', inputs: [{ key: 'hall', label: 'Hiring hall' }], attackerRolls: [],
        steps: [
            { id: 'o_type', label: 'Type', tableId: types.id, assign: 'type', dieMods: [{ from: 'hall', tag: 'test hall', add: -1 }] },
            { id: 'o_pay', label: 'Base Pay', tableId: pay.id, assign: 'basePay' },
            { id: 'o_len', label: 'Length', tableId: 'tb_len', assign: 'length' },
            { id: 'o_jumps', label: 'Jumps', tableId: 'tb_jumps', assign: 'jumps' },
            { id: 'o_pattern', label: 'Tracks per month', tableId: 'tb_pattern', assign: 'intensity', after: true },
            { id: 'o_table', label: 'Track table', tableId: raidTracks.id, noRoll: true, assign: 'trackTable', after: true },
        ],
    });

    // Between-track market: a contract purchase table, a scrapyard, a vehicle sponsor and one command ability.
    const units = (unit: string) => [{ min: 1, max: 6, cells: { r: { kind: 'units' as const, units: [{ unit }] } } }];
    const market = { ...newTable(), id: 'tb_market', name: 'Harbor market', purpose: 'purchase', die: '1D6', rows: units('Phoenix Hawk PXH-1') };
    const scrap = { ...newTable(), id: 'tb_scrap', name: 'Harbor scrapyard', purpose: 'scrapyard', die: '1D6', rows: units('Locust LCT-1V') };
    pub.tables.push(market, scrap);
    ct.purchase = { tableId: market.id, gateDie: '2D6', gate: [{ min: 2, count: 1 }], freq: 'month', note: '' };
    pub.sponsors.push({ id: 'sp_works', name: 'Test Works', scope: ['Vehicle'], discountPct: 10, deliveryInTerritory: 1, deliveryNear: 2, nearJumps: 3, purchaseTableId: '' });
    pub.scas.push({ id: 'sca_test', name: 'Test Ability' });

    // Track events: one complications roll applies every column; the hot spot's world table raises SP costs.
    const events = {
        ...newTable(), id: 'tb_events', name: 'Harbor complications', die: '1D6',
        columns: [{ key: 'a', label: 'Ammo' }, { key: 'b', label: 'Logistics' }, { key: 'c', label: 'Trade' }],
        rows: [{
            min: 1, max: 20, cells: {
                a: { kind: 'between' as const, block: ['rearm' as const], costPct: 0, note: '' },
                b: { kind: 'step' as const, term: 'support' as const, mode: 'shift' as const, value: -4 },
                c: { kind: 'amount' as const, currency: 'SP' as const, value: 250, perScale: true, note: '' },
            },
        }],
    };
    const world = {
        ...newTable(), id: 'tb_world', name: 'Testworld ruler', die: '1D6',
        rows: [{ min: 1, max: 6, cells: { r: { kind: 'between' as const, block: [], costPct: 4, note: '' } } }],
    };
    pub.tables.push(events, world);
    brief.complications.tableId = events.id;
    pub.halls.push({
        id: 'hh_test', name: 'Test Hall', systemId: '', support: 'B', reducedMaintenance: true, generatorId: '', systemTableId: '',
        purchaseTableIds: [], tempHireTableId: '', boardTableId: '', pilotIds: [], upgradeIds: [], offersPerMonth: 1,
    });
    pub.hotSpots.push({
        id: 'hs_glass', name: 'Testworld', contractIds: [ct.id], briefIds: [brief.id], tableIds: [], availability: { from: '', to: '' },
        venues: [], hallId: 'hh_test', worldTableId: world.id, facts: [{ label: 'Ruler', value: 'Rank 5' }],
    });
    return pub;
}

/**
 * "Test Atoll": an invented 8×6 campaign map. Landing zones at 0101 (west) and
 * 0801 (east); a town (0302) whose income a west landing cuts by 1D6 × 10%;
 * a strategic point (0503); a fort (0402) that garrisons; water at 0303/0403.
 */
export function makeMap(): CampaignMap {
    const m = newCampaignMap();
    const ty = (id: string, name: string, o: Partial<CampaignMap['hexTypes'][number]>) => ({ ...newHexType(name), id, ...o });
    m.id = 'mp_atoll';
    m.name = 'Test Atoll';
    m.cols = 8;
    m.rows = 6;
    m.hexTypes[0].trackId = 'tr_strike';
    m.hexTypes.push(
        ty('hx_base', 'Base', { lz: 'base', hq: true, trackId: 'tr_hold', lzEffects: [{ kind: 'incomePct', target: 'hx_town', die: '1D6', mult: 10, sign: -1 }] }),
        ty('hx_town', 'Town', { income: 300, trackId: 'tr_strike' }),
        ty('hx_point', 'Point', { income: 100, strategic: true, trackId: 'tr_hold' }),
        ty('hx_fort', 'Fort', { income: 50, trackId: 'tr_hold', effects: [{ kind: 'garrison' }] }),
    );
    m.hexes = {
        '0101': { t: 'hx_base', end: 'west' }, '0801': { t: 'hx_base', end: 'east' },
        '0302': { t: 'hx_town', name: 'Port' }, '0503': { t: 'hx_point' }, '0402': { t: 'hx_fort' },
        '0303': { t: 'hx_water' }, '0403': { t: 'hx_water' },
    };
    Object.assign(m.rules, { turns: 4, maxGroups: 2, groupSize: 3, bspPerScale: 10, reinforcements: 1 });
    m.rules.final.trackId = 'tr_hold';
    return m;
}
/** The test publication plus a contract played on the Test Atoll map. */
export function makeMapPublication(): Publication {
    const pub = makePublication();
    pub.maps.push(makeMap());
    pub.contracts.push({ ...newContract(), id: 'ct_atoll', name: 'Atoll campaign', employer: 'Test Employer', length: 4, mapId: 'mp_atoll' });
    return pub;
}

export function makeEnv(seed = 1, pub: Publication = makePublication()): RunnerEnv {
    return { pub, units: lookup, rng: seededRng(seed) };
}
