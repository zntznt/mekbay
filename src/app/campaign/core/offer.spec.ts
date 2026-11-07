// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type RunnerEnv } from './campaign.model';
import { buyUnit } from './market';
import { declineOffer, generateOffer, offerSource, signOffer } from './offer';
import { migratePublication, type BriefNode, type Publication } from './publication.model';
import { migrateCampaign, newCampaign, waitMonth } from './runner';
import { briefFlow, makeChoice, monthPlan, type FlowNode } from './script';
import { makeEnv } from './testing/fixtures';
import { validate } from './validate';

function atHall(env: RunnerEnv): Campaign {
    env.pub.halls[0].generatorId = 'gn_offer';
    const c = newCampaign({ pub: env.pub, name: 'Offer Company' });
    buyUnit(c, env, 'Wolverine WVR-6R');
    c.hallId = 'hh_test';
    return c;
}
const flat = (nodes: FlowNode[]): FlowNode[] => nodes.flatMap(n => [n, ...(n.branches || []).flatMap(b => flat(b.nodes))]);

describe('random contract offers', () => {
    it('rolls the same offer from the same seed', () => {
        const roll = () => {
            const env = makeEnv(7);
            const o = generateOffer(atHall(env), env);
            return { log: o.log, terms: o.contract.terms, type: o.contract.type, length: o.contract.length, jumps: o.jumps };
        };
        const a = roll();
        expect(roll()).toEqual(a);
        expect(a.length).toBe(2);
        expect(a.jumps).toBe(3);
        // Briefing details are rolled now but flagged to stay hidden until signing.
        expect(a.log.filter(l => l.after).map(l => l.text.split(':')[0])).toEqual(['Tracks per month', 'Track table']);
        expect(a.log[0].text).toBe('Hiring hall: Test Hall');
    });

    it('allows the hall\'s offers per month; declining waits for the next month', () => {
        const env = makeEnv();
        const c = atHall(env);
        expect(offerSource(c, env.pub).why).toBe('');
        generateOffer(c, env);
        expect(() => generateOffer(c, env)).toThrowError(RuleError, /Answer the current offer/);
        declineOffer(c);
        expect(c.offer).toBeNull();
        expect(() => generateOffer(c, env)).toThrowError(RuleError, /no more offers this month/);
        waitMonth(c, env);
        expect(generateOffer(c, env)).toBeTruthy();
        // An unanswered offer lapses with the month.
        waitMonth(c, env);
        expect(c.offer).toBeNull();
    });

    it('needs a hall with a generator and no active contract', () => {
        const env = makeEnv();
        const c = newCampaign({ pub: env.pub });
        expect(offerSource(c, env.pub).why).toMatch(/hiring hall/);
        c.hallId = 'hh_test';
        expect(offerSource(c, env.pub).why).toMatch(/no contract generator/);
    });

    it('signs an offer through the normal negotiation and adds it to the publication', () => {
        const env = makeEnv(3);
        const c = atHall(env);
        const o = generateOffer(c, env);
        const tooMuch = { ...o.contract.terms, basePay: o.contract.terms.basePay + 4 };
        expect(() => signOffer(c, { ...env, pub: structuredClone(env.pub) }, tooMuch)).toThrowError(RuleError);
        expect(c.offer).toBe(o);
        const env2 = { ...env, pub: structuredClone(env.pub) };
        const ac = signOffer(c, env2, { ...o.contract.terms });
        expect(c.offer).toBeNull();
        expect(ac.contractId).toBe(o.contract.id);
        expect(ac.jumps).toBe(3);
        expect(env2.pub.contracts.some(x => x.id === o.contract.id)).toBeTrue();
        // Pattern 1-2: one random track in month 1, two in month 2.
        expect(o.brief.months.map(m => m.nodes.length)).toEqual([1, 2]);
        expect(monthPlan(c, env2.pub).waiting?.type).toBe('random');
    });
});

describe('brief flow', () => {
    const track = (id: string, trackId: string): BriefNode => ({ id, kind: 'track', trackId, attacker: 'A', label: '', optional: false });
    function withChoice(pub: Publication) {
        pub.briefs[0].months[1].nodes = [
            { id: 'ch', kind: 'choice', side: 'A', options: [{ label: 'Push on', nodes: [track('n5', 'tr_strike')] }, { label: 'Dig in', nodes: [track('n6', 'tr_hold')] }] },
        ];
        return pub;
    }
    function signed(env: RunnerEnv) {
        const c = newCampaign({ pub: env.pub });
        buyUnit(c, env, 'Wolverine WVR-6R');
        c.contract = { ...newActive(), briefId: 'mb_glass', contractId: 'ct_glass' };
        return c;
    }
    const newActive = () => ({
        id: 'cc', contractId: '', briefId: '', name: 'Glass Harbor', number: '', employer: '', side: 'A' as const,
        terms: { basePay: 7, support: 8, transport: 7, salvage: 7, command: 7 }, offered: { basePay: 7, support: 8, transport: 7, salvage: 7, command: 7 },
        scale: 1, length: 2, month: 1, startDate: '3151-04', results: {}, rolls: {}, choices: {}, loops: {}, tracksThisMonth: 0, trackIds: [],
        buildings: 0, exchangeCredit: 0, salvagePool: [], variantId: '', piracy: false, jumps: null, status: 'active' as const, toftt: false,
    });

    it('shows both outcomes of a branch until the source track is played', () => {
        const env = makeEnv();
        const c = signed(env);
        const [m1] = briefFlow(c, env.pub);
        expect(m1.current).toBeTrue();
        expect(m1.nodes[0].state).toBe('next');
        const br = m1.nodes[1];
        expect(br.text).toBe('After Strike');
        expect(br.branches!.map(b => [b.label, b.taken])).toEqual([['If you win', null], ['If you lose', null]]);
    });

    it('follows the loss path and marks the other branch as not taken', () => {
        const env = makeEnv();
        const c = signed(env);
        c.contract!.results['n1'] = 'B';
        const [m1] = briefFlow(c, env.pub);
        expect(m1.nodes[0].state).toBe('lost');
        const [win, loss] = m1.nodes[1].branches!;
        expect(win.taken).toBeFalse();
        expect(win.nodes[0].state).toBe('off');
        expect(loss.taken).toBeTrue();
        expect(loss.nodes[0].state).toBe('next');
        expect(loss.nodes[0].text).toBe('Hold');
    });

    it('waits at a choice, then follows the chosen option', () => {
        const env = makeEnv(1, withChoice(makeEnv().pub));
        const c = signed(env);
        c.contract!.results = { n1: 'A', n2: 'A' };
        c.contract!.month = 2;
        let m2 = briefFlow(c, env.pub)[1];
        expect(m2.nodes[0].state).toBe('waiting');
        expect(m2.nodes[0].text).toBe('You choose');
        makeChoice(c, 'ch', 1);
        m2 = briefFlow(c, env.pub)[1];
        expect(m2.nodes[0].branches!.map(b => b.taken)).toEqual([false, true]);
        expect(flat(m2.nodes).find(n => n.key === 'n6')!.state).toBe('next');
        expect(flat(m2.nodes).find(n => n.key === 'n5')!.state).toBe('off');
    });

    it('caps the nodes it renders from an imported script', () => {
        const env = makeEnv();
        const deep: BriefNode[] = [];
        let list = deep;
        for (let i = 0; i < 200; i++) {
            const next: BriefNode[] = [track(`d${i}`, 'tr_strike')];
            list.push({ id: `c${i}`, kind: 'choice', side: 'A', options: [{ label: 'x', nodes: next }] });
            list = next;
        }
        env.pub.briefs[0].months[0].nodes = deep;
        const c = signed(env);
        expect(flat(briefFlow(c, env.pub)[0].nodes).length).toBeLessThan(60);
    });
});

describe('offer fields: validation and migration', () => {
    it('validates offers per month and briefing-detail steps', () => {
        const pub = makeEnv().pub;
        pub.halls[0].offersPerMonth = 0;
        pub.generators[1].steps[1].after = true;
        pub.tracks[0].situation = 42 as unknown as string;
        const msgs = validate(pub).filter(x => x.level === 'error').map(x => x.msg);
        expect(msgs).toContain('Offers per month must be a whole number from 1 to 12');
        expect(msgs).toContain('Base Pay: "basePay" is negotiated before signing, so it cannot be a briefing detail');
        expect(msgs).toContain('Situation must be text');
    });

    it('loads an older publication and campaign without the new fields', () => {
        const pub = makeEnv().pub;
        delete (pub.halls[0] as Partial<typeof pub.halls[0]>).offersPerMonth;
        expect(migratePublication(pub).halls[0].offersPerMonth).toBe(1);
        expect(validate(pub).filter(x => x.level === 'error')).toEqual([]);
        const c = newCampaign({ pub }) as Partial<Campaign>;
        delete c.offer;
        delete c.offers;
        const m = migrateCampaign(c as Campaign);
        expect(m.offer).toBeNull();
        expect(m.offers).toEqual({ date: '', n: 0 });
    });
});
