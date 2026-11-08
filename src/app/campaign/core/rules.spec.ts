// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { coverage, compressNums, dieRange, parseDie, roll, seededRng } from './dice';
import {
    bestBasePayTerms, checkNegotiation, combatPay, contractEconomics, handicap, resolveStep, stepLabel, tempHireRoom, trackLimit,
} from './engine';
import { newPilot, pilotStats } from './pilots';
import { defaultTerms, migratePublication } from './publication.model';
import { ALPHA_STRIKE_RULES, CLASSIC_RULES, RULES, rulesFor } from './rules';
import { crewCheck, destroyedSalvageCheck } from './track';
import { lookup, makePublication } from './testing/fixtures';

const u = (name: string) => lookup(name)!;

describe('campaign dice', () => {
    it('parses die expressions', () => {
        expect(parseDie('2D6+1')).toEqual({ n: 2, sides: 6, mod: 1 });
        expect(parseDie('d6')).toEqual({ n: 1, sides: 6, mod: 0 });
        expect(parseDie('12')).toEqual({ n: 0, sides: 0, mod: 12 });
        expect(parseDie('bogus')).toBeNull();
        expect(dieRange('2D6', -1, 2)).toEqual({ min: 1, max: 14 });
    });

    it('rolls deterministically from a seed', () => {
        const a = seededRng(42);
        const b = seededRng(42);
        const seqA = Array.from({ length: 20 }, () => roll('2D6', a).total);
        const seqB = Array.from({ length: 20 }, () => roll('2D6', b).total);
        expect(seqA).toEqual(seqB);
        expect(seqA.every(v => v >= 2 && v <= 12)).toBeTrue();
        expect(Array.from({ length: 20 }, () => roll('2D6', seededRng(43)).total)).not.toEqual(seqA);
    });

    it('maps the extremes of the random source to the die faces', () => {
        expect(roll('2D6', () => 0).total).toBe(2);
        expect(roll('2D6', () => 0.999).total).toBe(12);
    });

    it('reports coverage gaps and overlaps', () => {
        const cov = coverage([{ min: 1, max: 3 }, { min: 3, max: 4 }], 1, 6);
        expect(cov.gaps).toEqual([5, 6]);
        expect(cov.overlaps).toEqual([3]);
        expect(compressNums([2, 3, 4, 7])).toBe('2–4, 7');
    });
});

describe('ruleset seam', () => {
    it('is keyed by GameSystem', () => {
        expect(rulesFor(GameSystem.CLASSIC)).toBe(CLASSIC_RULES);
        expect(rulesFor(GameSystem.ALPHA_STRIKE)).toBe(ALPHA_STRIKE_RULES);
        expect(Object.keys(RULES).sort()).toEqual([GameSystem.ALPHA_STRIKE, GameSystem.CLASSIC].sort());
    });

    it('uses BV for Classic and PV for Alpha Strike', () => {
        const wolv = u('Wolverine WVR-6R');
        expect(CLASSIC_RULES.valueLabel).toBe('BV');
        expect(CLASSIC_RULES.unitValue(wolv)).toBe(1100);
        expect(CLASSIC_RULES.purchasePrice(wolv)).toBe(1100);
        expect(CLASSIC_RULES.sellingPrice(wolv)).toBe(550);
        expect(ALPHA_STRIKE_RULES.valueLabel).toBe('PV');
        expect(ALPHA_STRIKE_RULES.unitValue(wolv)).toBe(31);
        expect(ALPHA_STRIKE_RULES.purchasePrice(wolv)).toBe(31 * 40);
        expect(ALPHA_STRIKE_RULES.sellingPrice(wolv)).toBe(31 * 20);
    });

    it('scales track limits and temp-hire room per system', () => {
        expect(trackLimit(2, GameSystem.CLASSIC)).toBe(6000);
        expect(trackLimit(1, GameSystem.CLASSIC, true)).toBe(3500);
        expect(trackLimit(2, GameSystem.ALPHA_STRIKE)).toBe(200);
        expect(trackLimit(1, GameSystem.ALPHA_STRIKE, true)).toBe(110);
        expect(tempHireRoom(1500, 1, GameSystem.CLASSIC)).toBe(1500);
        expect(tempHireRoom(40, 1, GameSystem.ALPHA_STRIKE)).toBe(60);
    });

    it('computes skill handicap from each system\'s ladder', () => {
        expect(handicap({ gunnery: 3, piloting: 4 }, GameSystem.CLASSIC)).toBe(12 + 4);
        expect(handicap({ asSkill: 3 }, GameSystem.ALPHA_STRIKE)).toBe(16);
        // Edge and Edge Abilities are shared; SPAs count as Edge Ability levels (R-19).
        expect(handicap({ edge: 3, edgeAbilities: 1, spas: 1 }, GameSystem.CLASSIC)).toBe(5 + 8);
    });

    it('converts pilot skills across systems', () => {
        const pl = newPilot('Crossover');
        pl.cols.gunnery = 300; // G3, P5 on the Classic ladder
        expect(pilotStats(pl, GameSystem.CLASSIC, GameSystem.CLASSIC)).toEqual(jasmine.objectContaining({ g: 3, p: 5, handicap: 12 }));
        // A Classic pilot fielded in Alpha Strike uses floor((G + P) / 2).
        expect(pilotStats(pl, GameSystem.ALPHA_STRIKE, GameSystem.CLASSIC)).toEqual(jasmine.objectContaining({ skill: 4, handicap: 0 }));
        const asPl = newPilot('AS native');
        asPl.cols.asSkill = 400; // Skill 3
        // An Alpha Strike pilot fielded in Classic uses G = Skill, P = Skill + 1.
        expect(pilotStats(asPl, GameSystem.CLASSIC, GameSystem.ALPHA_STRIKE)).toEqual(jasmine.objectContaining({ g: 3, p: 4, handicap: 16 }));
    });

    it('prices repairs per system', () => {
        const wolv = u('Wolverine WVR-6R');
        const off = { sizeRepairs: false };
        const on = { sizeRepairs: true };
        expect(CLASSIC_RULES.baseRepairCost(wolv, 'structure', on).cost).toBe(110); // Classic ignores the AS option
        expect(ALPHA_STRIKE_RULES.baseRepairCost(wolv, 'structure', off).cost).toBe(110);
        expect(ALPHA_STRIKE_RULES.baseRepairCost(wolv, 'structure', on).cost).toBe(80);
        expect(CLASSIC_RULES.reconfigureCost(u('Timber Wolf Prime'), on)).toBe(38);
        expect(ALPHA_STRIKE_RULES.reconfigureCost(u('Timber Wolf Prime'), on)).toBe(30);
    });

    it('prices rearming per system', () => {
        const units = [u('Wolverine WVR-6R'), u('Phoenix Hawk PXH-1')];
        expect(CLASSIC_RULES.rearmCost({ units, ammoTons: 2, advancedAmmoTons: 1, alternateMunitions: 0 })).toBe(120);
        // Energy-only (ENE) units need no rearming in Alpha Strike.
        expect(ALPHA_STRIKE_RULES.rearmCost({ units, ammoTons: 2, advancedAmmoTons: 1, alternateMunitions: 1 })).toBe(40);
    });

    it('limits healing per system', () => {
        expect(CLASSIC_RULES.healing).toEqual({ boxesPerMonth: 2, boxesPerInjury: 1, boxesBetweenTracks: 1 });
        expect(ALPHA_STRIKE_RULES.healing).toEqual({ boxesPerMonth: 3, boxesPerInjury: 3, boxesBetweenTracks: null });
    });

    it('runs destroyed-unit checks only where the system has them', () => {
        expect(destroyedSalvageCheck(GameSystem.CLASSIC, u('Atlas AS7-D'))).toBeNull();
        expect(crewCheck(GameSystem.CLASSIC)).toBeNull();
        expect(destroyedSalvageCheck(GameSystem.ALPHA_STRIKE, u('Atlas AS7-D'), () => 0)).toEqual(jasmine.objectContaining({ tn: 4, roll: 2, ok: false }));
        expect(destroyedSalvageCheck(GameSystem.ALPHA_STRIKE, u('Manticore Heavy Tank'), () => 0.99)).toEqual(jasmine.objectContaining({ tn: 6, roll: 12, ok: true }));
        expect(crewCheck(GameSystem.ALPHA_STRIKE, () => 0)?.result).toBe('killed');
        expect(crewCheck(GameSystem.ALPHA_STRIKE, () => 0.3)?.result).toBe('wounded');
        expect(crewCheck(GameSystem.ALPHA_STRIKE, () => 0.99)?.result).toBe('ok');
    });

    it('sets the AS play width by Scale and none for Classic', () => {
        expect(CLASSIC_RULES.playWidth).toBeNull();
        expect([1, 2, 4].map(s => ALPHA_STRIKE_RULES.playWidth!(s))).toEqual([36, 48, 60]);
    });
});

describe('contract math', () => {
    it('resolves em-dash steps toward 7', () => {
        expect(stepLabel('command', 1)).toBe('—');
        expect(resolveStep('command', 1)).toBe(3);
        expect(resolveStep('command', 9)).toBe(8);
    });

    it('checks negotiation currency and per-Scale raises (R-2)', () => {
        const offered = defaultTerms();
        expect(checkNegotiation(offered, { ...offered, basePay: 8 }, { reputation: 1, scale: 1 }).ok).toBeTrue();
        const tooFar = checkNegotiation(offered, { ...offered, basePay: 9 }, { reputation: 1, scale: 1 });
        expect(tooFar.ok).toBeFalse();
        expect(tooFar.errors.length).toBe(2);
        // Dropping two steps elsewhere buys one more raise.
        expect(checkNegotiation(offered, { ...offered, basePay: 8, salvage: 5 }, { reputation: 0, scale: 1 }).ok).toBeTrue();
        expect(checkNegotiation(offered, { ...offered, basePay: 8 }, { nonNegotiable: true }).ok).toBeFalse();
        expect(bestBasePayTerms(offered, { reputation: 1, scale: 1 }).basePay).toBe(8);
    });

    it('estimates contract economics', () => {
        const e = contractEconomics({ terms: { ...defaultTerms(), basePay: 8 }, scale: 1, months: 2, tracks: 3 });
        // Transport 300 at 50% cover, +50 per month, 3 × 500 combat pay.
        expect(e.net).toBe(-150 + 2 * 50 + 1500);
        expect(combatPay('allObjectives', 2)).toBe(1500);
        expect(combatPay('success', 1, { o: { combatPayMult: 0.25 } })).toBe(125);
    });
});

describe('imported-data guards', () => {
    it('rejects absurd dice instead of looping over them', () => {
        expect(parseDie('100000000D6')).toBeNull();
        expect(parseDie('2D100000')).toBeNull();
        expect(parseDie('2D6+1')).toEqual({ n: 2, sides: 6, mod: 1 });
    });
    it('resolves a non-numeric step without hanging', () => {
        expect(resolveStep('basePay', NaN)).toBe(7);
        expect(resolveStep('basePay', 3.6)).toBe(resolveStep('basePay', 3));
    });
});

describe('workshop publication migration', () => {
    it('renames legacy unitId to unit', () => {
        const pub = makePublication() as unknown as Record<string, unknown>;
        (pub['pilots'] as unknown[]) = [{ id: 'np_x', name: 'X', unitId: 'BMLocust_LCT1V' }];
        const out = migratePublication(pub as never);
        expect((out.pilots[0] as unknown as Record<string, unknown>)['unit']).toBe('BMLocust_LCT1V');
        expect('unitId' in (out.pilots[0] as object)).toBeFalse();
    });
});
