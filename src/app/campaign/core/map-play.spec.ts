// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type RunnerEnv } from './campaign.model';
import { allHexes, hexIncome, MAX_MAP_SIDE, neighbors, pathLength, reachable, toMove } from './hex-map';
import {
    addEnemy, addGroup, beginMapTurns, chooseMapOrder, deployArrivals, editGroup, endMapTurn, landAt, legalMoves, moveEnemy, moveGroup, reinforceUnit, rollMapInitiative,
    setEnemyLz, setMapWinner, stayEnemy, waitingAtLz,
} from './map-play';
import { buyUnit, hireRecruit, mapRecruit } from './market';
import { migratePublication, type CampaignMap, type Publication } from './publication.model';
import { acceptContract, migrateCampaign, newCampaign } from './runner';
import { applyTrack, cancelTrack, startFinalBattle } from './track';
import { makeEnv, makeMap, makeMapPublication } from './testing/fixtures';
import { validate } from './validate';

const TERMS = { basePay: 8, support: 8, transport: 7, salvage: 7, command: 7 };

/** A company on the Test Atoll contract: Alpha (Wolverine + Locust, moves 4) and Bravo (Atlas, moves 2). */
function onMap(seed = 1): { c: Campaign; env: RunnerEnv; ids: Record<'wolv' | 'locust' | 'atlas', string> } {
    const env = makeEnv(seed, makeMapPublication());
    const c = newCampaign({ pub: env.pub, name: 'Map Company' });
    c.warchest = 100000;
    const ids = {
        wolv: buyUnit(c, env, 'Wolverine WVR-6R').id,
        locust: buyUnit(c, env, 'Locust LCT-1V').id,
        atlas: buyUnit(c, env, 'Atlas AS7-D').id,
    };
    acceptContract(c, env, { contractId: 'ct_atoll', terms: TERMS, override: true });
    return { c, env, ids };
}
function deployed(seed = 1) {
    const x = onMap(seed);
    const { c, env, ids } = x;
    landAt(c, env, '0101');
    setEnemyLz(c, env, '0801');
    const alpha = addGroup(c, env, 'Alpha', [ids.wolv, ids.locust], 5);
    const bravo = addGroup(c, env, 'Bravo', [ids.atlas], 5);
    beginMapTurns(c, env);
    rollMapInitiative(c, env);
    chooseMapOrder(c, env, 'us');
    return { ...x, alpha: alpha.id, bravo: bravo.id };
}
const ms = (c: Campaign) => c.contract!.map!;

describe('campaign map: landing', () => {
    it('lands on a landing zone, rolls its effects once, and keeps the sides apart', () => {
        const { c, env } = onMap();
        expect(ms(c).phase).toBe('landing');
        expect(c.contract!.length).toBe(4);
        expect(() => landAt(c, env, '0503')).toThrowError(RuleError, /not a landing zone/);
        landAt(c, env, '0101');
        expect(ms(c).lzHex).toBe('0101');
        expect(ms(c).owner['0101']).toBe('us');
        const fx = ms(c).lzEffects[0];
        expect(fx.kind).toBe('incomePct');
        expect(fx.roll).toBeGreaterThanOrEqual(1);
        expect(fx.value).toBe(-fx.roll! * 10);
        expect(() => landAt(c, env, '0801')).toThrowError(RuleError, /Already landed/);
        setEnemyLz(c, env, '0801');
        expect(ms(c).owner['0801']).toBe('them');
    });

    it('needs both landing zones and legal formations before the first turn', () => {
        const { c, env, ids } = onMap();
        landAt(c, env, '0101');
        expect(() => beginMapTurns(c, env)).toThrowError(RuleError);
        setEnemyLz(c, env, '0801');
        const g = addGroup(c, env, 'Alpha', [ids.wolv, ids.locust, ids.atlas], 10);
        expect(() => editGroup(c, env, g.id, { unitIds: [ids.wolv, ids.locust, ids.atlas, ids.wolv] })).not.toThrow(); // duplicates collapse
        addGroup(c, env, 'Bravo', []);
        expect(() => addGroup(c, env, 'Charlie', [])).toThrowError(RuleError, /maximum is 2/);
        expect(() => editGroup(c, env, ms(c).groups[1].id, { unitIds: [ids.atlas] })).toThrowError(RuleError, /already in Alpha/);
        beginMapTurns(c, env);
        expect(ms(c).phase).toBe('turns');
        expect(ms(c).groups.every(x => x.hex === '0101')).toBeTrue();
    });
});

describe('campaign map: movement', () => {
    it('lists legal moves with their path cost, slowest Mech setting the pace', () => {
        const { c, env, alpha, bravo } = deployed();
        const map = makeMap();
        const fast = legalMoves(c, env, alpha);
        const slow = legalMoves(c, env, bravo);
        expect(Math.max(...fast.values())).toBe(4);
        expect(Math.max(...slow.values())).toBe(2);
        expect(fast.has('0303')).toBeFalse(); // water
        expect(fast.get('0302')).toBe(pathLength(map, '0101', '0302', 4)!);
        expect(slow.size).toBeLessThan(fast.size);
        expect(() => moveGroup(c, env, bravo, '0503')).toThrowError(RuleError, /out of reach/);
    });

    it('stops at enemy formations: they can be attacked but not passed', () => {
        const { c, env, alpha } = deployed();
        const [a, b] = neighbors(makeMap(), '0101');
        addEnemy(c, env, 'Red', a);
        addEnemy(c, env, 'Blue', b);
        expect([...legalMoves(c, env, alpha).keys()].sort()).toEqual([a, b].sort());
    });

    it('captures a named hex by ending a move there, once per turn', () => {
        const { c, env, alpha } = deployed();
        expect(moveGroup(c, env, alpha, '0302')).toEqual({ moved: jasmine.any(Number) } as never);
        expect(ms(c).owner['0302']).toBe('us');
        expect(() => moveGroup(c, env, alpha, '0301')).toThrowError(RuleError, /already moved/);
        expect(legalMoves(c, env, alpha).size).toBe(0);
    });
});

describe('campaign map: end of turn', () => {
    it('pays hex income with landing effects, keeps the date for a half-month turn, and resets movement', () => {
        const { c, env, alpha } = deployed();
        moveGroup(c, env, alpha, '0302');
        const pct = ms(c).lzEffects[0].value!;
        const inc = hexIncome(c, env.pub);
        expect(inc.total).toBe(Math.round(300 * (1 + pct / 100)));
        const before = c.warchest;
        const date = c.date;
        const r = endMapTurn(c, env);
        expect(r.income).toBe(inc.total);
        expect(c.ledger.some(l => l.event.startsWith('Hexes held') && l.cover === inc.total)).toBeTrue();
        expect(c.warchest).toBeGreaterThan(before - 2000); // income in, next turn's maintenance out
        expect(c.contract!.month).toBe(2);
        expect(c.date).toBe(date); // 2 map turns per month
        expect(ms(c).groups.every(g => !g.moved)).toBeTrue();
    });

    it('ends the map after the last turn and plays the final battle to close the contract', () => {
        const { c, env } = deployed();
        c.contract!.month = c.contract!.length;
        const r = endMapTurn(c, env);
        expect(r.ended?.by).toBe('turns');
        expect(ms(c).phase).toBe('ended');
        expect(() => startFinalBattle(c, env)).toThrowError(RuleError, /who won/);
        setMapWinner(c, env, 'us');
        const d = startFinalBattle(c, env)!;
        expect(d.mapBattle?.final).toBeTrue();
        expect(d.mapBattle?.ourRole).toBe('defender');
        expect(d.unitIds.length).toBe(3);
        applyTrack(c, env, { winner: c.contract!.side, tier: 'success' });
        expect(c.contract!.status).toBe('ended');
        expect(ms(c).finalDone).toBeTrue();
    });

    it('sends a strategic reinforcement to the landing zone next turn', () => {
        const { c, env, ids, bravo } = deployed();
        c.units.find(u => u.id === ids.atlas)!.state = 'destroyed';
        reinforceUnit(c, env, ids.atlas);
        expect(ms(c).reinforcements).toBe(0);
        expect(ms(c).groups.find(g => g.id === bravo)!.unitIds).toEqual([]);
        expect(() => editGroup(c, env, bravo, { unitIds: [ids.atlas] })).toThrowError(RuleError, /arrives/);
        expect(() => reinforceUnit(c, env, ids.atlas)).toThrowError(RuleError);
    });
});

describe('campaign map: battles become tracks', () => {
    it('a defence the defender wins sends the attackers back where they came from', () => {
        const { c, env, alpha } = deployed();
        moveGroup(c, env, alpha, '0302');
        addEnemy(c, env, 'Red', '0402');
        expect(toMove(ms(c))).toBe('them'); // one formation left each: the move passes
        const r = moveEnemy(c, env, ms(c).enemy[0].id, '0302');
        expect(r?.battle.ourRole).toBe('defender');
        expect(c.draft?.trackId).toBe('tr_strike'); // the town's scenario
        expect(c.draft?.bspBase).toBe(5);
        expect(ms(c).battle).not.toBeNull();
        const rec = applyTrack(c, env, { winner: c.contract!.side, tier: 'success' });
        expect(ms(c).enemy[0].hex).toBe('0402');
        expect(ms(c).owner['0302']).toBe('us');
        expect(ms(c).battle).toBeNull();
        expect(rec.notes).toContain('repulsed');
    });

    it('an attack the attacker wins takes the hex and pushes the enemy out', () => {
        const { c, env, alpha } = deployed();
        addEnemy(c, env, 'Red', '0302');
        const r = moveGroup(c, env, alpha, '0302') as { battle: { ourRole: string } };
        expect(r.battle.ourRole).toBe('attacker');
        expect(() => moveGroup(c, env, alpha, '0201')).toThrowError(RuleError, /battle in progress/);
        applyTrack(c, env, { winner: c.contract!.side, tier: 'success' });
        expect(ms(c).owner['0302']).toBe('us');
        expect(ms(c).groups.find(g => g.id === alpha)!.hex).toBe('0302');
        expect(ms(c).enemy[0].hex).not.toBe('0302');
        expect(ms(c).groups.find(g => g.id === alpha)!.moved).toBeTrue();
    });

    it('cancelling the battle undoes the move', () => {
        const { c, env, alpha } = deployed();
        addEnemy(c, env, 'Red', '0302');
        moveGroup(c, env, alpha, '0302');
        cancelTrack(c);
        expect(ms(c).battle).toBeNull();
        expect(ms(c).groups.find(g => g.id === alpha)!.hex).toBe('0101');
        expect(legalMoves(c, env, alpha).size).toBeGreaterThan(0);
    });
});

describe('campaign map: imported data', () => {
    it('bounds the grid and the path search whatever the map claims', () => {
        const huge: CampaignMap = { ...makeMap(), cols: 1e9, rows: 1e9 };
        expect(allHexes(huge).length).toBe(MAX_MAP_SIDE * MAX_MAP_SIDE);
        const t0 = Date.now();
        const r = reachable(huge, '5050', Number.MAX_SAFE_INTEGER);
        expect(r.size).toBeLessThan(MAX_MAP_SIDE * MAX_MAP_SIDE);
        expect(pathLength(makeMap(), '0101', '0301', 1e12, { blocked: () => true })).toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('validates map size, rule numbers and junk hexes with one issue each', () => {
        const pub = makeMapPublication();
        const m = pub.maps[0];
        expect(validate(pub).filter(i => i.coll === 'maps' && i.level === 'error')).toEqual([]);
        m.cols = 500;
        m.rules.lightMove = 1e9;
        m.image = 'https://example.com/x.png';
        for (let i = 0; i < 5000; i++) m.hexes[`x${i}`] = { t: 'hx_town' };
        m.hexes['0102'] = { t: 'hx_nope' };
        const issues = validate(pub).filter(i => i.coll === 'maps');
        const msgs = issues.map(i => i.msg);
        expect(msgs.some(x => /Map size/.test(x))).toBeTrue();
        expect(msgs.some(x => /lightMove/.test(x))).toBeTrue();
        expect(msgs.some(x => /data:image/.test(x))).toBeTrue();
        expect(msgs.filter(x => /ignored/.test(x)).length).toBe(1);
        expect(msgs.filter(x => /missing hex type/.test(x)).length).toBe(1);
        expect(issues.length).toBeLessThan(15);
    });

    it('migrates maps and map states written before these fields existed', () => {
        const pub = { ...makeMapPublication() } as Publication;
        const raw = pub.maps[0] as Partial<CampaignMap>;
        delete raw.cols;
        raw.hexTypes = [];
        raw.rules = { turns: 3 } as CampaignMap['rules'];
        migratePublication(pub);
        const m = pub.maps[0];
        expect(m.cols).toBe(11);
        expect(m.hexTypes.length).toBe(1);
        expect(m.rules.turns).toBe(3);
        expect(m.rules.lightMove).toBe(4);
        expect(m.rules.final.payouts).toEqual([]);

        const { c } = onMap();
        const old = c.contract!.map as unknown as Record<string, unknown>;
        old['phase'] = 'formations';
        for (const k of ['enemy', 'hold', 'fought', 'notes', 'lzEffects', 'battle']) delete old[k];
        migrateCampaign(c);
        expect(ms(c).phase).toBe('landing');
        expect(ms(c).enemy).toEqual([]);
        expect(ms(c).hold).toEqual({ us: 0, them: 0 });
        expect(ms(c).battle).toBeNull();
    });
});

describe('campaign map: move order', () => {
    it('needs Initiative and the winner\'s choice before anything moves', () => {
        const { c, env, ids } = onMap();
        landAt(c, env, '0101');
        setEnemyLz(c, env, '0801');
        const g = addGroup(c, env, 'Alpha', [ids.wolv], 10);
        beginMapTurns(c, env);
        expect(() => moveGroup(c, env, g.id, '0201')).toThrowError(RuleError, /Initiative/);
        const o = rollMapInitiative(c, env);
        expect(o.rolls.us).not.toBe(o.rolls.them);
        expect(o.winner).toBe(o.rolls.us > o.rolls.them ? 'us' : 'them');
        expect(() => rollMapInitiative(c, env)).toThrowError(RuleError, /already/);
        expect(() => moveGroup(c, env, g.id, '0201')).toThrowError(RuleError, /chooses/);
        chooseMapOrder(c, env, 'them');
        addEnemy(c, env, 'Red');
        expect(toMove(ms(c))).toBe('them');
        expect(() => moveGroup(c, env, g.id, '0201')).toThrowError(RuleError, /opponent's move/);
    });

    it('alternates, lets the side with more formations move two for one, and resets each turn', () => {
        const { c, env, alpha } = deployed();
        for (const n of ['Red', 'Blue', 'Green']) addEnemy(c, env, n);
        const [red, blue] = ms(c).enemy.map(e => e.id);
        expect(toMove(ms(c))).toBe('us'); // 2 against 3: one move each until it evens out
        moveGroup(c, env, alpha, '0201');
        expect(toMove(ms(c))).toBe('them');
        stayEnemy(c, env, red);
        expect(toMove(ms(c))).toBe('them'); // 3 left against 1: two moves
        stayEnemy(c, env, blue);
        expect(toMove(ms(c))).toBe('us');
        expect(() => stayEnemy(c, env, ms(c).enemy[2].id)).toThrowError(RuleError, /your move/);
        endMapTurn(c, env);
        expect(ms(c).order).toBeNull();
    });

    it('an attack on a formation that had not moved gives the attacker the next move', () => {
        const { c, env, alpha } = deployed();
        addEnemy(c, env, 'Red', '0302');
        addEnemy(c, env, 'Blue');
        moveGroup(c, env, alpha, '0302');
        applyTrack(c, env, { winner: c.contract!.side, tier: 'success' });
        expect(toMove(ms(c))).toBe('us');
    });
});

describe('campaign map: units arriving mid-map and recruits', () => {
    it('units bought on the map wait at the landing zone, then form up or join a formation there', () => {
        const { c, env, bravo, alpha } = deployed();
        env.pub.maps[0].rules.purchaseNeedsHex = false;
        const cu = buyUnit(c, env, 'Wolverine WVR-6R');
        expect(waitingAtLz(c, env)).toEqual([]); // arrives next map turn
        endMapTurn(c, env);
        expect(waitingAtLz(c, env).map(u => u.id)).toEqual([cu.id]);
        expect(() => deployArrivals(c, env, [cu.id])).toThrowError(RuleError, /slots are taken/);
        rollMapInitiative(c, env);
        chooseMapOrder(c, env, 'us');
        moveGroup(c, env, alpha, '0201');
        expect(() => deployArrivals(c, env, [cu.id], alpha)).toThrowError(RuleError, /landing zone/);
        deployArrivals(c, env, [cu.id], bravo);
        expect(ms(c).groups.find(g => g.id === bravo)!.unitIds).toContain(cu.id);
        expect(waitingAtLz(c, env)).toEqual([]);
    });

    it('recruits crews where a held hex allows it', () => {
        const { c, env, ids } = deployed();
        env.pub.maps[0].hexTypes.find(t => t.id === 'hx_fort')!.effects.push({ kind: 'recruit', g: 4, p: 5, skill: 4, cost: 100 });
        expect(mapRecruit(c, env)!.options).toEqual([]);
        ms(c).owner['0402'] = 'us';
        expect(mapRecruit(c, env)!.options.length).toBe(1);
        const before = c.warchest;
        hireRecruit(c, env, ids.locust, 0);
        expect(c.units.find(u => u.id === ids.locust)!.crew).toEqual(jasmine.objectContaining({ kind: 'fixed', g: 4, p: 5 }));
        expect(c.warchest).toBe(before - 100);
    });
});
