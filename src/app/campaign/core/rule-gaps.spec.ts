// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type RunnerEnv } from './campaign.model';
import { seededRng } from './dice';
import { buyTofttOption, buyUnit, rollFactionPurchase } from './market';
import { generateOffer, MAX_INPUT_LENGTH, signOffer } from './offer';
import { migratePublication, type AttackerRoll, type Publication } from './publication.model';
import { tableRoller } from './roller';
import { acceptContract, contractLimitCheck, endContractNow, negotiationCheck, newCampaign, payDebt, post } from './runner';
import { monthPlan, nextItem, rollAttacker, rollRandomNode } from './script';
import { applyTrack, startTrack } from './track';
import { makeEnv } from './testing/fixtures';
import { validate } from './validate';

const TERMS = { basePay: 7, support: 8, transport: 7, salvage: 7, command: 7 };

function company(env: RunnerEnv, input: Parameters<typeof newCampaign>[0] = {}): Campaign {
    const c = newCampaign({ pub: env.pub, name: 'Gap Company', ...input });
    buyUnit(c, env, 'Wolverine WVR-6R').pilotId = c.pilots[0].id;
    buyUnit(c, env, 'Locust LCT-1V').pilotId = c.pilots[1].id;
    return c;
}
function atHall(env: RunnerEnv): Campaign {
    env.pub.halls[0].generatorId = 'gn_offer';
    const c = company(env);
    c.hallId = 'hh_test';
    return c;
}
const RAID: AttackerRoll = { type: 'Raid', die: '1D6', min: 2, max: 6, tracks: [] };
const GARRISON: AttackerRoll = { type: 'Garrison', die: '', min: 0, max: 0, tracks: [{ name: 'Strike', attacker: true }, { name: 'Hold', attacker: false }] };

describe('random contracts: Attacker / Defender by contract type', () => {
    it('rolls the die against the range, or decides by track name', () => {
        const rng = seededRng(3);
        for (let i = 0; i < 20; i++) {
            const r = rollAttacker(RAID, 'Strike', rng)!;
            const v = Number(r.text.split('→ ')[1]);
            expect(r.attacks).toBe(v >= 2);
        }
        expect(rollAttacker(GARRISON, 'hold', rng)).toEqual({ attacks: false, text: 'hold' });
        expect(rollAttacker(GARRISON, 'Recon', rng)).toBeNull();
    });

    it('copies the rule onto the generated contract and applies it to rolled tracks', () => {
        for (const seed of [1, 2, 3, 4, 5, 6]) {
            const env = makeEnv(seed);
            env.pub.generators.find(g => g.id === 'gn_offer')!.attackerRolls = [RAID, GARRISON];
            const c = atHall(env);
            const o = generateOffer(c, env);
            expect(o.contract.attackerRoll?.type).toBe(o.contract.type);
            signOffer(c, env, o.contract.terms);
            const w = monthPlan(c, env.pub).waiting;
            expect(w?.type).toBe('random');
            if (w?.type !== 'random') continue;
            const picks = rollRandomNode(c, env, w.key, w.node);
            for (const p of picks) {
                const attacks = /you attack/.test(p.log);
                expect(attacks || /you defend/.test(p.log)).toBeTrue();
                expect(p.attacker === c.contract!.side).toBe(attacks);
                if (o.contract.type === 'Garrison') expect(attacks).toBe(env.pub.tracks.find(t => t.id === p.trackId)!.name === 'Strike');
            }
        }
    });

    it('validates the rules and migrates publications without them', () => {
        const env = makeEnv();
        const gen = env.pub.generators[0];
        gen.attackerRolls = [{ type: '', die: '1Q6', min: 5, max: 2, tracks: [] }];
        const msgs = validate(env.pub).filter(i => i.coll === 'generators').map(i => i.msg).join(' | ');
        expect(msgs).toMatch(/no contract type/);
        expect(msgs).toMatch(/bad die/);
        gen.attackerRolls = Array.from({ length: 5000 }, () => ({ ...RAID }));
        expect(validate(env.pub).filter(i => i.coll === 'generators' && i.level === 'error').length).toBeLessThan(5);
        const old = JSON.parse(JSON.stringify(makeEnv().pub)) as Publication;
        delete (old.generators[0] as Partial<typeof gen>).attackerRolls;
        delete (old.contracts[0] as { attackerRoll?: unknown }).attackerRoll;
        migratePublication(old);
        expect(old.generators[0].attackerRolls).toEqual([]);
        expect(old.contracts[0].attackerRoll).toBeNull();
    });
});

describe('random contracts: generator inputs', () => {
    it('passes the player\'s declared inputs, bounded, with the hall name', () => {
        const env = makeEnv();
        const gen = env.pub.generators.find(g => g.id === 'gn_offer')!;
        gen.inputs.push({ key: 'region', label: 'Region' });
        gen.steps.push({ id: 'o_note', label: 'Frontier note', tableId: 'tb_len', assign: 'note', when: { from: 'region', tag: 'frontier' } });
        const c = atHall(env);
        const o = generateOffer(c, env, { region: 'Frontier', hall: 'Fake Hall', other: 'x' });
        expect(o.log.map(l => l.text)).toContain('Region: Frontier');
        expect(o.log[0].text).toBe('Hiring hall: Test Hall');
        expect(o.log.some(l => l.text.startsWith('Frontier note: 1D6'))).toBeTrue();

        const env2 = makeEnv();
        env2.pub.generators.find(g => g.id === 'gn_offer')!.inputs.push({ key: 'region', label: 'Region' });
        const o2 = generateOffer(atHall(env2), env2, { region: 'y'.repeat(10000) });
        expect(o2.log.find(l => l.text.startsWith('Region'))!.text.length).toBe('Region: '.length + MAX_INPUT_LENGTH);
    });
});

describe('mission brief end nodes', () => {
    it('ends the contract early when the brief reaches a contract end', () => {
        const env = makeEnv();
        env.pub.briefs[0].months[0].nodes.splice(1, 0, { id: 'e1', kind: 'end', scope: 'contract', text: 'Employer withdraws' });
        const c = company(env);
        acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS });
        expect(monthPlan(c, env.pub).ends.map(e => e.id)).toEqual(['e1']);
        startTrack(c, env, nextItem(monthPlan(c, env.pub))!);
        expect(() => endContractNow(c)).toThrowError(RuleError, /track in progress/);
        c.draft = null;
        endContractNow(c, 'Employer withdraws');
        expect(c.contract!.status).toBe('ended');
        expect(() => endContractNow(c)).toThrowError(RuleError);
    });
});

describe('Taking One For the Team and regular military', () => {
    it('a successful track for the other side pays half and earns a purchase option at standard price', () => {
        const env = makeEnv();
        const c = company(env);
        acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS });
        const d = startTrack(c, env, nextItem(monthPlan(c, env.pub))!);
        d.toftt = true;
        const before = c.warchest;
        applyTrack(c, env, { winner: c.contract!.side, tier: 'success', tofttPick: 'Atlas AS7-D', tofttUnits: ['Atlas AS7-D'] });
        expect(c.warchest).toBe(before + 250); // half of 500 at Scale 1
        expect(c.tofttOptions.map(o => [o.unit, o.half])).toEqual([['Atlas AS7-D', false]]);
        c.warchest = 5000;
        buyTofttOption(c, env, c.tofttOptions[0].id);
        expect(c.warchest).toBe(5000 - 1900);
        expect(c.units.some(u => u.unit === 'Atlas AS7-D' && u.source === 'toftt')).toBeTrue();
    });

    it('starts a regular military command with its faction and parent; rolls faction purchases once a month', () => {
        const env = makeEnv();
        env.pub.factions.push({
            id: 'fa_test', name: 'Test House', contracts: [{ contractId: 'ct_glass' }], purchaseTableId: 'tb_market', tankerTableId: '', baTableId: '',
            parents: [{ id: 'pc_1', name: 'First Guards', units: [], scaIds: [] }], singleParent: false,
        });
        const c = company(env, { factionId: 'fa_test', parentId: 'pc_1' });
        expect(c.regular).toEqual({ factionId: 'fa_test', parentId: 'pc_1', rank: 1 });
        const roller = tableRoller(env.rng);
        expect(() => rollFactionPurchase(c, env, roller, { mod: 1 })).toThrowError(RuleError, /rank 2/);
        const log = rollFactionPurchase(c, env, roller);
        expect(log.some(l => l.units?.some(u => u.unit === 'Phoenix Hawk PXH-1'))).toBeTrue();
        expect(() => rollFactionPurchase(c, env, roller)).toThrowError(RuleError, /once|One/);
        // Regular military sign the simple terms only.
        expect(() => acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS })).toThrowError(RuleError, /simple contract terms/);
    });
});

describe('debt, negotiation preview and partial forces', () => {
    it('pays down Warchest Debt from the Warchest', () => {
        const env = makeEnv();
        const c = company(env);
        post(c, { event: 'Big bill', cost: 4000, allowDebt: true });
        expect(c.debt).toBe(1000);
        c.warchest = 600;
        payDebt(c, 5000);
        expect([c.debt, c.warchest]).toEqual([400, 0]);
    });

    it('previews negotiation cost and brings only part of the force', () => {
        const env = makeEnv();
        const c = company(env);
        const ct = env.pub.contracts[0];
        const neg = negotiationCheck(c, ct, { ...TERMS, basePay: 9 }, 1);
        expect(neg.ok).toBeFalse();
        expect(neg.spent).toBe(2);
        const locust = c.units.find(u => u.unit === 'Locust LCT-1V')!;
        const wolv = c.units.find(u => u.unit === 'Wolverine WVR-6R')!;
        expect(contractLimitCheck(c, env.units, 1, [wolv.id]).units).toBe(1);
        acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS, bring: [wolv.id] });
        expect(locust.leftBehind).toBeTrue();
        expect(wolv.leftBehind).toBeUndefined();
    });
});

describe('track result inputs', () => {
    it('records VP, crew-only outcomes and advanced ammunition', () => {
        const env = makeEnv();
        const c = company(env);
        const crewed = buyUnit(c, env, 'Phoenix Hawk PXH-1');
        crewed.crew = { kind: 'regular', wounds: 0 };
        acceptContract(c, env, { contractId: 'ct_glass', terms: TERMS, override: true });
        const d = startTrack(c, env, nextItem(monthPlan(c, env.pub))!);
        d.unitIds = c.units.map(u => u.id);
        const rec = applyTrack(c, env, {
            winner: c.contract!.side, tier: 'success', vpUs: 3, vpThem: 1, advTons: 1,
            units: { [crewed.id]: { crewKilled: true } },
        });
        expect(rec.vp).toBe('3–1');
        expect(crewed.crew.kind).toBe('none');
        expect(c.ledger.find(l => l.kind === 'rearm')?.cost).toBe(100);
    });
});
