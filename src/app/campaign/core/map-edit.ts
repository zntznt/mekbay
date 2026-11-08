// SPDX-License-Identifier: GPL-3.0-or-later

import { inMap, MAP_RULE_RANGES, MAX_MAP_SIDE, type MapRuleNum } from './hex-map';
import {
    HEX_DEFAULT, newCampaignMap, newContract, newHexType,
    type CampaignMap, type HexType, type MapEffect, type MapEffectKind, type MapHex, type MapRules, type Publication,
} from './publication.model';

/*
 * Map editing for publications. Every helper returns a new map and leaves its
 * input untouched, so the editor can keep earlier versions for undo and the
 * hex-type index in hex-map.ts (keyed on the hexTypes array) never goes stale.
 */

/** Largest background image stored in a publication, as data-URL characters (about 1 MB). */
export const MAX_MAP_IMAGE_CHARS = 1_000_000;
export const MAX_HEX_TYPES = 50;
export const MAX_EFFECTS = 20;
export const MAX_PAYOUTS = 20;
export const HOLD_TURNS_MAX = 100;
export const FINAL_BSP_MAX = 10000;
export const PAYOUT_SP_MAX = 1_000_000;

export const clampInt = (v: unknown, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(Number(v)) || 0));

/** A fresh map with a landing-zone type and a strategic-point type ready to paint. */
export function starterMap(): CampaignMap {
    const m = newCampaignMap();
    m.hexTypes.push(
        { ...newHexType('Landing zone', '#d9a441'), lz: 'lz', hq: true },
        { ...newHexType('Strategic point', '#b55d4c'), strategic: true, income: 100 },
    );
    return m;
}

// ---------- grid ----------

/** Resize the grid (each side clamped to 1–MAX_MAP_SIDE); hex entries left outside the grid are dropped. */
export function resizeMap(map: CampaignMap, cols: number, rows: number): CampaignMap {
    const next = { ...map, cols: clampInt(cols, 1, MAX_MAP_SIDE), rows: clampInt(rows, 1, MAX_MAP_SIDE) };
    next.hexes = Object.fromEntries(Object.entries(map.hexes).filter(([id]) => /^\d{4}$/.test(id) && inMap(next, id)));
    return next;
}

/** Set fields of one hex; empty fields are removed and an empty hex entry disappears. */
export function setHex(map: CampaignMap, id: string, patch: Partial<MapHex>): CampaignMap {
    if (!/^\d{4}$/.test(id) || !inMap(map, id)) return map;
    const h: MapHex = { ...map.hexes[id], ...patch };
    if (!h.t || h.t === HEX_DEFAULT) delete h.t;
    if (!h.name?.trim()) delete h.name;
    if (!h.end?.trim()) delete h.end;
    const hexes = { ...map.hexes };
    if (Object.keys(h).length) hexes[id] = h;
    else delete hexes[id];
    return { ...map, hexes };
}

/** Paint a hex with a hex type; the default type erases. Unchanged hexes return the same map. */
export function paintHex(map: CampaignMap, id: string, typeId: string): CampaignMap {
    if ((map.hexes[id]?.t || HEX_DEFAULT) === (typeId || HEX_DEFAULT)) return map;
    if (!map.hexTypes.some(t => t.id === typeId)) return map;
    return setHex(map, id, { t: typeId });
}

// ---------- hex types ----------

export function addHexType(map: CampaignMap, t: HexType = newHexType()): CampaignMap {
    if (map.hexTypes.length >= MAX_HEX_TYPES) throw new Error(`At most ${MAX_HEX_TYPES} hex types.`);
    return { ...map, hexTypes: [...map.hexTypes, t] };
}
/** Change a hex type. Hexes and effects refer to it by id, so a rename needs nothing else. */
export function updateHexType(map: CampaignMap, id: string, patch: Partial<Omit<HexType, 'id'>>): CampaignMap {
    return { ...map, hexTypes: map.hexTypes.map(t => (t.id === id ? { ...t, ...patch } : t)) };
}
/** Delete a hex type: its hexes become the default type and effects that target it are removed. */
export function deleteHexType(map: CampaignMap, id: string): CampaignMap {
    if (id === HEX_DEFAULT || map.hexTypes.length <= 1) throw new Error('The default hex type cannot be deleted.');
    const keep = (e: MapEffect) => !((e.kind === 'incomePct' || e.kind === 'cancel') && e.target === id);
    const hexTypes = map.hexTypes.filter(t => t.id !== id).map(t => ({ ...t, effects: t.effects.filter(keep), lzEffects: t.lzEffects.filter(keep) }));
    let next: CampaignMap = { ...map, hexTypes };
    for (const [h, x] of Object.entries(map.hexes)) if (x?.t === id) next = setHex(next, h, { t: HEX_DEFAULT });
    return next;
}

// ---------- effects ----------

/** Fields each effect kind uses, in editing order. */
export const EFFECT_FIELDS: Readonly<Record<MapEffectKind, readonly (keyof MapEffect)[]>> = {
    incomePct: ['target', 'pct', 'die', 'mult', 'sign'],
    maintPct: ['pct', 'die', 'mult'],
    purchase: ['pct', 'die', 'mult'],
    reinforce: ['value'],
    recruit: ['g', 'p', 'skill', 'cost'],
    supportPct: ['value'],
    bsp: ['value', 'note', 'asNote'],
    pilotSpMult: ['value'],
    heal: ['value'],
    cancel: ['target'],
    garrison: [],
    note: ['text'],
};
export const EFFECT_KINDS = Object.keys(EFFECT_FIELDS) as MapEffectKind[];
export function newMapEffect(kind: MapEffectKind): MapEffect {
    switch (kind) {
        case 'incomePct': return { kind, target: '', pct: 10 };
        case 'maintPct':
        case 'purchase': return { kind, pct: 10 };
        case 'recruit': return { kind, g: 4, p: 5, skill: 4, cost: 100 };
        case 'note': return { kind, text: '' };
        case 'cancel': return { kind, target: '' };
        case 'garrison': return { kind };
        default: return { kind, value: 1 };
    }
}
export type EffectList = 'effects' | 'lzEffects';
export function setEffects(map: CampaignMap, typeId: string, list: EffectList, effects: MapEffect[]): CampaignMap {
    if (effects.length > MAX_EFFECTS) throw new Error(`At most ${MAX_EFFECTS} effects per list.`);
    return updateHexType(map, typeId, { [list]: effects });
}

// ---------- rules ----------

/** Set a numeric map rule, rounded and clamped to its range. */
export function setRule(rules: MapRules, key: MapRuleNum, v: unknown): MapRules {
    const [lo, hi] = MAP_RULE_RANGES[key];
    return { ...rules, [key]: clampInt(v, lo, hi) };
}
export function clampPayouts(payouts: MapRules['final']['payouts']): MapRules['final']['payouts'] {
    return payouts.slice(0, MAX_PAYOUTS).map(p => ({ name: String(p.name ?? ''), sp: clampInt(p.sp, 0, PAYOUT_SP_MAX) }));
}

// ---------- background image ----------

/** Why an image can't be stored ('' = it can). */
export function imageProblem(url: string): string {
    if (!url.startsWith('data:image/')) return 'The background must be an embedded image (data:image URL).';
    if (url.length > MAX_MAP_IMAGE_CHARS) return `The image is ${(url.length / 1e6).toFixed(1)} MB; the limit is ${(MAX_MAP_IMAGE_CHARS / 1e6).toFixed(1)} MB.`;
    return '';
}
/** Set or clear (empty url) the background image; throws when it can't be stored. */
export function setImage(map: CampaignMap, url: string): CampaignMap {
    const why = url ? imageProblem(url) : '';
    if (why) throw new Error(why);
    return { ...map, image: url };
}

// ---------- publication ----------

/** The publication with this map added or replaced (by id). */
export function withMap(pub: Publication, map: CampaignMap): Publication {
    const i = pub.maps.findIndex(m => m.id === map.id);
    return { ...pub, maps: i < 0 ? [...pub.maps, map] : pub.maps.map((m, j) => (j === i ? map : m)) };
}
/** Add a contract that plays on the map, unless one already does. */
export function withMapContract(pub: Publication, map: CampaignMap): Publication {
    if (pub.contracts.some(c => c.mapId === map.id)) return pub;
    return { ...pub, contracts: [...pub.contracts, { ...newContract(), name: map.name, mapId: map.id, length: map.rules.turns }] };
}
