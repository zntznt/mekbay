// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { RuleError, type Campaign, type RunnerEnv } from './campaign.model';
import { seededRng } from './dice';
import { buyUnit, healLimit, healPilot, hirePilot, reconfigure, repairQuote, repairUnit } from './market';
import { acceptContract, closeContract, endMonth, evaluateVictory, newCampaign, payDebt, post } from './runner';
import { monthPlan, nextItem, type PlanItem } from './script';
import { applyTrack, startTrack, trackForce } from './track';
import { makeEnv } from './testing/fixtures';

const RAISED = { basePay: 8, support: 8, transport: 7, salvage: 7, command: 7 };

/** A Classic company with a Wolverine and a Locust, each crewed by a named pilot. */
function company(env: RunnerEnv, system = GameSystem.CLASSIC): Campaign {
    const c = newCampaign({ pub: env.pub, name: 'Test Company', system });
    const wolv = buyUnit(c, env, 'Wolverine WVR-6R');
    const locust = buyUnit(c, env, 'Locust LCT-1V');
    wolv.pilotId = c.pilots[0].id;
    locust.pilotId = c.pilots[1].id;
    return c;
}
const unitId = (c: Campaign, name: string) => c.units.find(u => u.unit === name)!.id;
function fieldAll(c: Campaign, env: RunnerEnv, item: PlanItem) {
    const d = startTrack(c, env, item);
    d.unitIds = c.units.map(u => u.id);
    return d;
}

describe('campaign runner: ledger', () => {
    it('refuses an unaffordable cost unless debt is allowed', () => {
        const c = newCampaign({});
        expect(() => post(c, { event: 'Too much', cost: 5000 })).toThrowError(RuleError);
        expect(c.warchest).toBe(3000);
        post(c, { event: 'Maintenance', cost: 3200, kind: 'month', allowDebt: true });
        expect(c.warchest).toBe(0);
        expect(c.debt).toBe(200);
    });

    it('pays at least half of every gain into debt', () => {
        const c = newCampaign({});
        post(c, { event: 'Maintenance', cost: 3300, allowDebt: true });
        const e = post(c, { event: 'Combat pay', cover: 101 });
        expect(e.toDebt).toBe(51);
        expect(c.debt).toBe(249);
        expect(c.warchest).toBe(50);
        payDebt(c, 1000);
        expect(c.debt).toBe(199);
        expect(c.warchest).toBe(0);
    });

    it('blocks hiring while in debt', () => {
        const env = makeEnv();
        const c = newCampaign({ pub: env.pub });
        post(c, { event: 'Maintenance', cost: 3100, allowDebt: true });
        expect(() => hirePilot(c, env, { kind: 'named', name: 'Late Hire' })).toThrowError(RuleError, /Warchest Debt/);
    });
});

describe('campaign runner: contract and months', () => {
    it('signs a negotiated contract and posts transport and the first month', () => {
        const env = makeEnv();
        const c = company(env);
        const ct = acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
        expect(ct.month).toBe(1);
        expect(c.setup).toBeFalse();
        // 3,000 − (300 transport − 150 covered) + (550 Base Pay − 500 maintenance)
        expect(c.warchest).toBe(2900);
        expect(c.ledger.map(e => e.kind)).toEqual(['start', 'transport', 'month']);
        expect(c.maintPaid).toBe(c.date);
    });

    it('rejects terms beyond the negotiation budget and leaves the campaign untouched', () => {
        const env = makeEnv();
        const c = company(env);
        expect(() => acceptContract(c, env, { contractId: 'ct_glass', terms: { ...RAISED, basePay: 9 } })).toThrowError(RuleError);
        expect(c.contract).toBeNull();
        expect(c.warchest).toBe(3000);
    });

    it('ticks months until the contract ends', () => {
        const env = makeEnv();
        const c = company(env);
        acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
        const start = c.date;
        endMonth(c, env);
        expect(c.contract!.month).toBe(2);
        expect(c.date).not.toBe(start);
        expect(c.warchest).toBe(2950);
        endMonth(c, env);
        expect(c.contract!.status).toBe('ended');
        expect(c.contract!.endDate).toBe('3151-05');
        expect(() => endMonth(c, env)).toThrowError(RuleError, /close it first/);
        closeContract(c, env, { won: true });
        expect(c.contract).toBeNull();
        expect(c.reputation).toBe(2);
        expect(c.history.length).toBe(1);
    });

    it('charges maintenance between contracts', () => {
        const env = makeEnv();
        const c = company(env);
        endMonth(c, env);
        expect(c.warchest).toBe(2500);
        expect(c.date).toBe('3151-05');
    });
});

describe('campaign runner: tracks', () => {
    it('applies a won track: pay, pilot SP, damage, salvage and script branching', () => {
        const env = makeEnv();
        const c = company(env);
        acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
        let plan = monthPlan(c, env.pub);
        expect(plan.waiting?.type).toBe('result');
        const item = nextItem(plan)!;
        expect(item.key).toBe('n1');
        const d = fieldAll(c, env, item);
        const f = trackForce(c, env, d);
        expect(f.ok).toBeTrue();
        expect(f.total).toBe(1530);
        // 32 free BSP plus 1,470 unused BV / 20, capped at 32.
        expect(f.bsp).toEqual(jasmine.objectContaining({ base: 32, conv: 32, total: 64 }));
        // Named pilots carry their names into the MekBay force; regular crews stay unnamed.
        expect(f.groups[0].units.map(u => u.alias)).toEqual(c.pilots.map(p => p.name));
        c.units[1].pilotId = '';
        expect(trackForce(c, env, d).groups[0].units[1].alias).toBeUndefined();
        c.units[1].pilotId = c.pilots[1].id;

        const [p1, p2] = c.pilots;
        const locust = unitId(c, 'Locust LCT-1V');
        const rec = applyTrack(c, env, {
            winner: 'A', tier: 'success', designated: 100, mvp: p1.id,
            units: { [locust]: { state: 'armor' } }, salvage: [{ unit: 'Atlas AS7-D' }],
        });
        expect(rec.combatPay).toBe(500);
        expect(rec.per).toBe(50);
        // 2,900 + (500 − 100 to pilots) + 40% of the Atlas's 950 salvage value
        expect(c.warchest).toBe(2900 + 400 + 380);
        expect(p1.unspent).toBe(150 + 50 + 20);
        expect(p2.unspent).toBe(200);
        expect(c.units.find(u => u.id === locust)!.state).toBe('armor');
        expect(c.contract!.salvagePool.map(s => s.unit)).toEqual(['Atlas AS7-D']);
        expect(c.draft).toBeNull();

        plan = monthPlan(c, env.pub);
        expect(nextItem(plan)!.key).toBe('n2');
    });

    it('loses crippled units to a winning enemy and pays battle-loss compensation', () => {
        const env = makeEnv();
        const c = company(env);
        acceptContract(c, env, { contractId: 'ct_glass', terms: { ...RAISED, support: 13 }, override: true }); // Battle/50%
        const wolv = unitId(c, 'Wolverine WVR-6R');
        const locust = unitId(c, 'Locust LCT-1V');
        fieldAll(c, env, nextItem(monthPlan(c, env.pub))!);
        const before = c.warchest;
        applyTrack(c, env, { winner: 'B', tier: 'unsuccessful', units: { [wolv]: { state: 'crippled' }, [locust]: { state: 'truly' } } });
        const w = c.units.find(u => u.id === wolv)!;
        expect(w.state).toBe('lost');
        expect(w.lostTo).toBe('Glass Harbor');
        // 250 combat pay + 50% of the Locust's 430 purchase price
        expect(c.warchest).toBe(before + 250 + 215);
        expect(nextItem(monthPlan(c, env.pub))!.key).toBe('n3');
        expect(evaluateVictory(c, env.pub).suggested).toBeFalse();
    });

    it('rolls the Repair Time Table deterministically from the seed', () => {
        const run = (seed: number) => {
            const env = makeEnv(seed);
            const c = company(env);
            c.options.repairTimeTable = true;
            acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
            fieldAll(c, env, nextItem(monthPlan(c, env.pub))!);
            return applyTrack(c, env, { winner: 'A', tier: 'success' }).repairTime;
        };
        expect(run(5)).toBeDefined();
        expect(run(5)).toBe(run(5));
    });

    it('rejects a force over the Scale limit', () => {
        const env = makeEnv();
        const c = company(env);
        buyUnit(c, env, 'Atlas AS7-D');
        acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
        const f = trackForce(c, env, fieldAll(c, env, nextItem(monthPlan(c, env.pub))!));
        expect(f.ok).toBeFalse();
        expect(f.errors.join(' ')).toContain('3,430 BV');
    });

    it('budgets BSP in PV for an Alpha Strike company', () => {
        const env = makeEnv();
        const c = company(env, GameSystem.ALPHA_STRIKE);
        acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
        const f = trackForce(c, env, fieldAll(c, env, nextItem(monthPlan(c, env.pub))!));
        expect(f.total).toBe(49);
        // 5 free BSP plus 51 unused PV / 3, capped at 5.
        expect(f.bsp).toEqual(jasmine.objectContaining({ base: 5, conv: 5, total: 10 }));
    });
});

describe('campaign runner: repairs and healing per system', () => {
    function damaged(system: GameSystem, opts: { sizeRepairs?: boolean } = {}) {
        const env = makeEnv();
        const c = newCampaign({ pub: env.pub, system });
        c.options.asSizeRepairs = !!opts.sizeRepairs;
        const add = (name: string, state: 'structure' | 'crippled' | 'destroyed') => {
            const cu = buyUnit(c, env, name);
            cu.state = state;
            return cu;
        };
        return {
            env, c,
            wolv: add('Wolverine WVR-6R', 'structure'),
            wolf: add('Timber Wolf Prime', 'crippled'),
            tank: add('Manticore Heavy Tank', 'destroyed'),
        };
    }

    it('prices Classic repairs by tonnage with Clan and vehicle modifiers', () => {
        const { env, c, wolv, wolf, tank } = damaged(GameSystem.CLASSIC);
        expect(repairQuote(c, env, wolv)!.cost).toBe(110);
        expect(repairQuote(c, env, wolf)!.cost).toBe(338); // 75 t × 3 × 1.5, rounded up (R-16)
        expect(repairQuote(c, env, tank)!.cost).toBe(150);
        // Omni units with structure damage are ready for the next track.
        wolf.state = 'structure';
        expect(repairQuote(c, env, wolf)!.exempt).toBeTrue();
        c.modifiers.mechBay = true;
        expect(repairQuote(c, env, wolv)!.cost).toBe(88);
    });

    it('prices Alpha Strike repairs by tonnage, or by Size with the option', () => {
        const plain = damaged(GameSystem.ALPHA_STRIKE);
        expect(repairQuote(plain.c, plain.env, plain.wolv)!.cost).toBe(110);
        const sized = damaged(GameSystem.ALPHA_STRIKE, { sizeRepairs: true });
        expect(repairQuote(sized.c, sized.env, sized.wolv)!.cost).toBe(80);
        expect(repairQuote(sized.c, sized.env, sized.wolf)!.cost).toBe(270);
    });

    it('repairs against the warchest and support coverage', () => {
        const env = makeEnv();
        const c = company(env);
        acceptContract(c, env, { contractId: 'ct_glass', terms: RAISED });
        const locust = unitId(c, 'Locust LCT-1V');
        fieldAll(c, env, nextItem(monthPlan(c, env.pub))!);
        applyTrack(c, env, { winner: 'A', tier: 'none', units: { [locust]: { state: 'structure' } } });
        const before = c.warchest;
        const q = repairUnit(c, env, locust);
        // Straight/100% support covers the whole 40 SP.
        expect(q.cost).toBe(40);
        expect(q.cover).toBe(40);
        expect(c.warchest).toBe(before);
        expect(c.units.find(u => u.id === locust)!.state).toBe('ok');
    });

    it('reconfigures an Omni within its chassis', () => {
        const env = makeEnv();
        const c = newCampaign({ pub: env.pub });
        const cu = buyUnit(c, env, 'Timber Wolf Prime');
        c.setup = false;
        reconfigure(c, env, cu.id, 'Timber Wolf A');
        expect(cu.unit).toBe('Timber Wolf A');
        expect(c.warchest).toBe(3000 - 38);
        expect(() => reconfigure(c, env, cu.id, 'Atlas AS7-D')).toThrowError(RuleError);
    });

    it('heals Classic wounds two boxes per month', () => {
        const env = makeEnv();
        const c = newCampaign({ pub: env.pub });
        const pl = c.pilots[0];
        pl.wounds = 3;
        expect(healLimit(c, pl, env)).toBe(2);
        healPilot(c, env, pl.id, 1);
        expect(c.warchest).toBe(2970);
        expect(() => healPilot(c, env, pl.id, 2)).toThrowError(RuleError);
        healPilot(c, env, pl.id, 1);
        expect(pl.wounds).toBe(1);
        expect(healLimit(c, pl, env)).toBe(0);
    });

    it('heals Alpha Strike wounds one whole injury at a time', () => {
        const env = { ...makeEnv(), rng: seededRng(3) };
        const c = newCampaign({ pub: env.pub, system: GameSystem.ALPHA_STRIKE });
        const pl = c.pilots[0];
        pl.wounds = 3;
        healPilot(c, env, pl.id, 1);
        expect(pl.wounds).toBe(0);
        expect(c.warchest).toBe(3000 - 90);
    });
});
