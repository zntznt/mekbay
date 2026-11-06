// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Synthetic test fixtures: an invented publication and a handful of units with
 * made-up numbers. Nothing here is taken from a published campaign.
 */

import { GameSystem } from '../../../models/common.model';
import type { RunnerEnv } from '../campaign.model';
import { seededRng } from '../dice';
import { newBrief, newContract, newPublication, newTable, newTrack, type BriefNode, type Publication } from '../publication.model';
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
        id: 'gn_contract', name: 'Contract generator', purpose: 'contract', inputs: [],
        steps: [
            { id: 's_type', label: 'Type', tableId: types.id, assign: 'type' },
            { id: 's_pay', label: 'Pay', tableId: pay.id, assign: 'basePay', shifts: [{ from: 's_type', tag: 'garrison', add: -1 }] },
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
    return pub;
}

export function makeEnv(seed = 1, pub: Publication = makePublication()): RunnerEnv {
    return { pub, units: lookup, rng: seededRng(seed) };
}
