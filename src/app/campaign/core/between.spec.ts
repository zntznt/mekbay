// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type RunnerEnv } from './campaign.model';
import { goToHall, buyUnit, healLimit, healPilot, reconfigure, repairQuote, repairUnit } from './market';
import { migratePublication, type BriefNode, type Publication } from './publication.model';
import { tableRoller } from './roller';
import { acceptContract, betweenNow, coverage, newCampaign } from './runner';
import { monthPlan, nextItem } from './script';
import { applyTrack, contractConditions, rollComplications, startTrack } from './track';
import { makeEnv } from './testing/fixtures';
import { validate } from './validate';

const TERMS = { basePay: 8, support: 8, transport: 7, salvage: 7, command: 7 }; // Straight/100%

function company(env: RunnerEnv): Campaign {
    const c = newCampaign({ pub: env.pub, name: 'Test Company' });
    buyUnit(c, env, 'Wolverine WVR-6R').pilotId = c.pilots[0].id;
    buyUnit(c, env, 'Locust LCT-1V').pilotId = c.pilots[1].id;
    return c;
}
/** Sign the test contract and set up its first track with every unit. */
function firstTrack(env: RunnerEnv, terms = TERMS) {
    const c = company(env);
    acceptContract(c, env, { contractId: 'ct_glass', terms });
    const d = startTrack(c, env, nextItem(monthPlan(c, env.pub))!);
    d.unitIds = c.units.map(u => u.id);
    return { c, d };
}
const node = (pub: Publication, id: string) => pub.briefs[0].months.flatMap(m => m.nodes).find(n => n.id === id) as Extract<BriefNode, { kind: 'track' }>;
const locustOf = (c: Campaign) => c.units.find(u => u.unit === 'Locust LCT-1V')!;

describe('campaign core: track events between tracks', () => {
    it('keeps machine-readable effects on rolled lines', () => {
        const env = makeEnv();
        const log = tableRoller(env.rng)(env.pub.tables.find(t => t.id === 'tb_events')!, { pub: env.pub, system: env.pub.systems[0], modifier: 0 });
        expect(log.filter(l => l.effect).map(l => l.effect!.kind)).toEqual(['between', 'step', 'amount']);
        expect(log.find(l => l.effect?.kind === 'between')!.text).toContain('no rearm');
    });

    it('rolls complications and the world table once per track', () => {
        const env = makeEnv();
        const { c, d } = firstTrack(env);
        const r = rollComplications(c, env, d, tableRoller(env.rng))!;
        expect(r.band).toBe('House');
        expect(d.complications.some(l => l.text.includes('SP costs +4%'))).toBeTrue();
        expect(() => rollComplications(c, env, d, tableRoller(env.rng))).toThrowError(RuleError, /already rolled/);
    });

    it('applies events: bonus pay, no rearm, support 4 steps lower and +4% costs until the next track', () => {
        const env = makeEnv();
        const { c, d } = firstTrack(env);
        rollComplications(c, env, d, tableRoller(env.rng));
        const locust = locustOf(c);
        const rec = applyTrack(c, env, { winner: 'A', tier: 'success', ammoTons: 2, units: { [locust.id]: { state: 'armor' } } });
        expect(c.ledger.some(e => e.event.startsWith('Track event') && e.cover === 250)).toBeTrue();
        expect(c.ledger.some(e => e.kind === 'rearm' && e.cost)).toBeFalse();
        expect(rec.notes).toContain('Ammunition carries over');
        const b = betweenNow(c)!;
        expect(b).toEqual(jasmine.objectContaining({ supportShift: 4, costPct: 4, block: ['rearm'] }));
        // Straight/100% (step 8) drops to Straight/60% (step 4).
        expect(coverage(c, env.pub)).toBeCloseTo(0.6);
        // 20 t armor: 10 SP × 1.04, rounded up.
        const q = repairQuote(c, env, locust)!;
        expect(q.cost).toBe(11);
        expect(q.cover).toBe(7);

        // The next track closes the window.
        const d2 = startTrack(c, env, nextItem(monthPlan(c, env.pub))!);
        d2.unitIds = c.units.filter(u => u.state === 'ok').map(u => u.id);
        applyTrack(c, env, { winner: 'A', tier: 'success', ammoTons: 1 });
        expect(betweenNow(c)).toBeNull();
        expect(c.ledger.some(e => e.kind === 'rearm' && e.cost === 10)).toBeTrue();
    });

    it('blocks repairs, rearming and healing after a script step with no repair time', () => {
        const env = makeEnv();
        node(env.pub, 'n1').repairTime = 'none';
        const { c } = firstTrack(env);
        const locust = locustOf(c);
        c.pilots[0].wounds = 1;
        const rec = applyTrack(c, env, { winner: 'A', tier: 'success', ammoTons: 1, units: { [locust.id]: { state: 'armor' } } });
        expect(rec.repairTime).toBe('No repairs');
        expect(c.ledger.filter(e => e.kind === 'rearm').map(e => e.cost)).toEqual([0]);
        expect(repairQuote(c, env, locust)!.blocked).toContain('No repairs');
        expect(() => repairUnit(c, env, locust.id)).toThrowError(RuleError, /No repairs/);
        expect(healLimit(c, c.pilots[0], env)).toBe(0);
        expect(() => healPilot(c, env, c.pilots[0].id)).toThrowError(RuleError, /No repairs/);
    });

    it('uses a contract-wide fixed repair time between tracks of a month', () => {
        const env = makeEnv();
        env.pub.contracts[0].repairTime = 'extended';
        const { c } = firstTrack(env);
        const wolv = c.units.find(u => u.unit === 'Wolverine WVR-6R')!;
        applyTrack(c, env, { winner: 'A', tier: 'success', units: { [wolv.id]: { state: 'structure' } } });
        expect(c.contract!.repairTime).toEqual(jasmine.objectContaining({ roll: 0, kind: 'extended' }));
        expect(repairQuote(c, env, wolv)!.exempt).toBeTrue();
    });

    it('prices reconfiguration with the hiring hall rating and needs no contract to move halls', () => {
        const env = makeEnv();
        const c = company(env);
        const tw = buyUnit(c, env, 'Timber Wolf Prime');
        c.setup = false;
        goToHall(c, env, 'hh_test');
        expect(c.hallId).toBe('hh_test');
        const before = c.warchest;
        reconfigure(c, env, tw.id, 'Timber Wolf A');
        // 75 t / 2 = 38, × 50% at a B-rated hall = 19.
        expect(before - c.warchest).toBe(19);
        expect(() => goToHall(c, env, 'hh_missing')).toThrowError(RuleError);
        acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS });
        expect(() => goToHall(c, env, '')).toThrowError(RuleError, /between contracts/);
    });
});

describe('campaign core: contract conditions', () => {
    it('lists location, world facts, hall, repair time and event tables', () => {
        const env = makeEnv();
        env.pub.contracts[0].repairTime = 'hasty';
        const c = company(env);
        goToHall(c, env, 'hh_test');
        expect(contractConditions(c, env.pub)).toEqual([{ label: 'Hiring hall', value: 'Test Hall, support B (repairs ×0.5)' }]);
        acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS });
        const m = new Map(contractConditions(c, env.pub).map(x => [x.label, x.value]));
        expect(m.get('Location')).toBe('Testworld');
        expect(m.get('Ruler')).toBe('Rank 5');
        expect(m.get('Repair time')).toBe('Hasty repairs');
        expect(m.get('Track events')).toBe('Harbor complications · Testworld ruler');
        expect(m.get('Hiring hall')).toContain('between contracts');
    });
});

describe('campaign core: publication data for events', () => {
    it('fills new fields on old publications', () => {
        const pub = makeEnv().pub as unknown as Record<string, { [k: string]: unknown }[]>;
        delete pub['contracts'][0]['repairTime'];
        delete pub['hotSpots'][0]['worldTableId'];
        delete pub['hotSpots'][0]['facts'];
        const m = migratePublication(pub as unknown as Publication);
        expect(m.contracts[0].repairTime).toBe('');
        expect(m.hotSpots[0].worldTableId).toBe('');
        expect(m.hotSpots[0].facts).toEqual([]);
    });

    it('flags unknown repair times and between-tracks blocks', () => {
        const env = makeEnv();
        env.pub.contracts[0].repairTime = 'toString' as never;
        node(env.pub, 'n1').repairTime = 'later' as never;
        const ev = env.pub.tables.find(t => t.id === 'tb_events')!;
        ev.rows[0].cells['a'] = { kind: 'between', block: ['salvage' as never], costPct: 0, note: '' };
        const msgs = validate(env.pub, env.units).filter(i => i.level === 'error').map(i => i.msg);
        expect(msgs).toContain('Unknown repair time "toString"');
        expect(msgs).toContain('Track step: unknown repair time "later"');
        expect(msgs.some(m => m.startsWith('Between-tracks result'))).toBeTrue();
        expect(validate(makeEnv().pub, env.units).filter(i => i.level === 'error')).toEqual([]);
    });
});
