// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { seededRng } from './dice';
import { createFromDraft, runGenerator } from './generator';
import { hexDist, hexId, neighbors, pathLength } from './hex-map';
import { acesAvailable, newAcesState } from './opponent.model';
import { newCampaignMap } from './publication.model';
import { newCampaign } from './runner';
import { validate } from './validate';
import { lookup, makePublication } from './testing/fixtures';

describe('publication validation', () => {
    it('finds no errors in the fixture publication', () => {
        const errors = validate(makePublication(), lookup).filter(x => x.level === 'error');
        expect(errors).toEqual([]);
    });

    it('flags bad contract steps, dangling branches and invalid dice', () => {
        const pub = makePublication();
        pub.contracts[0].terms.command = 1;
        const branch = pub.briefs[0].months[0].nodes[1];
        if (branch.kind === 'branch') branch.of = 'missing';
        pub.tables[0].die = '2X6';
        const msgs = validate(pub, lookup).filter(x => x.level === 'error').map(x => x.msg);
        expect(msgs).toContain('Command Rights: step 1 is not selectable (—) in the Contract Steps Table');
        expect(msgs).toContain('Branch refers to a track that is not earlier in the script');
        expect(msgs).toContain('Die expression "2X6" is not valid');
    });

    it('warns about table gaps', () => {
        const pub = makePublication();
        pub.tables[0].rows = pub.tables[0].rows.slice(0, 1);
        expect(validate(pub).some(x => x.level === 'warn' && x.msg.startsWith('No row for 4–6'))).toBeTrue();
    });

    it('checks unit names only when a lookup is supplied', () => {
        const pub = makePublication();
        pub.contracts[0].tempHires.push({ id: 'th1', name: 'Mystery merc', unit: 'Nonexistent NX-1' });
        expect(validate(pub, lookup).some(x => x.level === 'error' && x.msg.includes('Nonexistent NX-1'))).toBeTrue();
        expect(validate(pub).some(x => x.msg.includes('Nonexistent NX-1'))).toBeFalse();
    });

    it('reports temp-hire room in each system\'s value basis', () => {
        const pub = makePublication();
        pub.contracts[0].tempHires.push({ id: 'th2', name: 'Big hire', unit: 'Timber Wolf Prime' });
        const warns = validate(pub, lookup).filter(x => x.msg.startsWith('Temp hire Big hire')).map(x => x.msg);
        expect(warns.some(m => m.includes('2700 BV'))).toBeTrue();
        expect(warns.some(m => m.includes('PV'))).toBeFalse(); // 54 PV leaves room at Scale 1
    });
});

describe('generators', () => {
    it('produces the same draft from the same seed', () => {
        const pub = makePublication();
        const gen = pub.generators[0];
        const a = runGenerator(gen, { pub, rng: seededRng(9) });
        const b = runGenerator(gen, { pub, rng: seededRng(9) });
        expect(a.draft).toEqual(b.draft);
        expect(a.log.map(l => l.text)).toEqual(b.log.map(l => l.text));
    });

    it('lets earlier tags shift later contract steps', () => {
        const pub = makePublication();
        const { draft } = runGenerator(pub.generators[0], { pub, rng: () => 0.99 });
        expect(draft.type).toBe('Garrison');
        expect(draft.typeDetail).toBe('Garrison duty');
        expect(draft.terms.basePay).toBe(7); // step 8, shifted −1 by the garrison tag
        const { contract, brief } = createFromDraft(pub, draft, 'Rolled contract');
        expect(contract.type).toBe('Garrison');
        expect(contract.terms.basePay).toBe(7);
        expect(contract.briefId).toBe(brief.id);
        expect(pub.contracts).toContain(contract);
    });
});

describe('hex maps', () => {
    it('measures distance on flat-topped, even-columns-down hexes', () => {
        expect(hexDist('0101', '0102')).toBe(1);
        expect(hexDist('0101', '0201')).toBe(1);
        expect(hexDist('0101', '0301')).toBe(2);
        expect(neighbors(newCampaignMap(), hexId(5, 5)).length).toBe(6);
        expect(neighbors(newCampaignMap(), '0101').length).toBe(2);
    });

    it('routes around blocked hexes', () => {
        const map = newCampaignMap();
        expect(pathLength(map, '0505', '0507', 4)).toBe(2);
        const wall = new Set(['0506', '0406', '0606']);
        expect(pathLength(map, '0505', '0507', 2, { blocked: h => wall.has(h) })).toBeNull();
        expect(pathLength(map, '0505', '0507', 6, { blocked: h => wall.has(h) })).toBe(5);
    });
});

describe('opponent module (ACES) types', () => {
    it('creates an empty Alpha Strike ACES state', () => {
        const s = newAcesState(GameSystem.ALPHA_STRIKE);
        expect(s.kind).toBe('aces');
        expect(s.system).toBe(GameSystem.ALPHA_STRIKE);
        expect(s.commandCard).toBeNull();
        expect(s.initiative).toEqual({ lastWinner: null, streak: 0, repeatWinnerPenalty: 0 });
        const c = newCampaign({ system: GameSystem.CLASSIC });
        expect(c.opponent).toBeNull();
        c.opponent = s;
        expect(c.opponent.system).toBe(GameSystem.ALPHA_STRIKE);
    });

    it('has no Classic edition yet', () => {
        expect(acesAvailable(GameSystem.ALPHA_STRIKE)).toBeTrue();
        expect(acesAvailable(GameSystem.CLASSIC)).toBeFalse();
        expect(() => newAcesState(GameSystem.CLASSIC)).toThrowError(/no published edition/);
    });
});
