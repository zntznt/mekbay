// SPDX-License-Identifier: GPL-3.0-or-later

import { describeEffect, hexType, MAX_MAP_SIDE } from './hex-map';
import {
    addHexType, deleteHexType, imageProblem, MAX_MAP_IMAGE_CHARS, paintHex, resizeMap, setHex, setImage, setRule, starterMap, updateHexType, withMap, withMapContract,
} from './map-edit';
import { HEX_DEFAULT, migratePublication, newHexType, newPublication } from './publication.model';
import { makeMap, makeMapPublication } from './testing/fixtures';
import { validate } from './validate';

describe('map editing', () => {
    it('paints and erases hexes without touching the input map', () => {
        const m = makeMap();
        const p = paintHex(m, '0505', 'hx_town');
        expect(p.hexes['0505']).toEqual({ t: 'hx_town' });
        expect(m.hexes['0505']).toBeUndefined();
        expect(paintHex(p, '0505', 'hx_town')).toBe(p);
        expect(paintHex(p, '0505', 'hx_missing')).toBe(p);
        expect(paintHex(p, '0909', 'hx_town')).toBe(p); // outside the 8×6 grid
        const erased = paintHex(p, '0505', HEX_DEFAULT);
        expect('0505' in erased.hexes).toBeFalse();
        const named = paintHex(setHex(p, '0505', { name: 'Ridge' }), '0505', HEX_DEFAULT);
        expect(named.hexes['0505']).toEqual({ name: 'Ridge' });
        expect(setHex(named, '0505', { name: ' ' }).hexes['0505']).toBeUndefined();
    });

    it('clamps resizing and drops hexes outside the new grid', () => {
        const m = { ...makeMap(), hexes: { ...makeMap().hexes, junk: { t: 'hx_town' } } };
        const small = resizeMap(m, 4, 2);
        expect([small.cols, small.rows]).toEqual([4, 2]);
        expect(Object.keys(small.hexes).sort()).toEqual(['0101', '0302', '0402']);
        const big = resizeMap(m, 500, 0);
        expect([big.cols, big.rows]).toEqual([MAX_MAP_SIDE, 1]);
        expect(resizeMap(m, NaN, 3.6).cols).toBe(1);
        expect(resizeMap(m, NaN, 3.6).rows).toBe(4);
    });

    it('renames a hex type in place and deletes one with its references', () => {
        let m = makeMap();
        m = updateHexType(m, 'hx_town', { name: 'City' });
        expect(hexType(m, '0302').name).toBe('City');
        expect(describeEffect(m, m.hexTypes.find(t => t.id === 'hx_base')!.lzEffects[0])).toContain('City income');
        m = deleteHexType(m, 'hx_town');
        expect(m.hexTypes.some(t => t.id === 'hx_town')).toBeFalse();
        expect(m.hexes['0302']).toEqual({ name: 'Port' });
        expect(m.hexTypes.find(t => t.id === 'hx_base')!.lzEffects).toEqual([]);
        expect(() => deleteHexType(m, HEX_DEFAULT)).toThrow();
        const pub = withMap(makeMapPublication(), m);
        expect(validate(pub).filter(i => i.level === 'error')).toEqual([]);
        expect(() => { let x = m; for (let i = 0; i < 60; i++) x = addHexType(x, newHexType()); }).toThrowError(/At most/);
    });

    it('keeps numeric rules inside the ranges validation checks', () => {
        const r = makeMap().rules;
        expect(setRule(r, 'turns', 0).turns).toBe(1);
        expect(setRule(r, 'turns', 1e9).turns).toBe(100);
        expect(setRule(r, 'maxGroups', '3.4').maxGroups).toBe(3);
        expect(setRule(r, 'heavyMove', -2).heavyMove).toBe(0);
        expect(setRule(r, 'turnsPerMonth', 'x').turnsPerMonth).toBe(1);
        const pub = makeMapPublication();
        pub.maps[0].rules.turns = 0;
        expect(validate(pub).some(i => i.level === 'error' && i.msg.includes('turns'))).toBeTrue();
        pub.maps[0].rules = setRule(pub.maps[0].rules, 'turns', 0);
        expect(validate(pub).some(i => i.level === 'error' && i.coll === 'maps')).toBeFalse();
    });

    it('rejects background images over the size cap or not embedded', () => {
        const m = makeMap();
        const ok = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
        expect(setImage(m, ok).image).toBe(ok);
        expect(setImage(setImage(m, ok), '').image).toBe('');
        const big = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_MAP_IMAGE_CHARS);
        expect(imageProblem(big)).toMatch(/limit/);
        expect(() => setImage(m, big)).toThrowError(/limit/);
        expect(() => setImage(m, 'https://example.com/map.png')).toThrowError(/embedded/);
    });

    it('round-trips a new map through save, export and import with validation', () => {
        let m = starterMap();
        const lz = m.hexTypes.find(t => t.lz)!.id;
        const sp = m.hexTypes.find(t => t.strategic)!.id;
        m = setHex(paintHex(m, '0101', lz), '0101', { end: 'north' });
        m = setHex(paintHex(m, '1114', lz), '1114', { end: 'south', name: 'Far camp' });
        m = paintHex(m, '0607', sp);
        let pub = withMapContract(withMap(newPublication(), m), m);
        expect(withMapContract(pub, m)).toBe(pub);
        expect(pub.contracts[0].mapId).toBe(m.id);
        const errors = validate(pub).filter(i => i.level === 'error');
        expect(errors).toEqual([]);
        const back = migratePublication(JSON.parse(JSON.stringify(pub)));
        expect(back.maps[0]).toEqual(m);
        expect(validate(back).filter(i => i.level === 'error')).toEqual([]);
        // replacing by id keeps one copy
        pub = withMap(pub, { ...m, name: 'Renamed' });
        expect(pub.maps.length).toBe(1);
        expect(pub.maps[0].name).toBe('Renamed');
    });
});
