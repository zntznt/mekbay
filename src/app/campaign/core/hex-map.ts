// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import type { Campaign, EnemyMarker, MapGroup, MapState, RunnerEnv } from './campaign.model';
import { roll, type Rng } from './dice';
import { byId, HEX_DEFAULT, type CampaignMap, type HexType, type MapEffect, type MapEffectKind, type Publication } from './publication.model';
import { isMovementHeavy, rulesFor } from './rules';
import { isMek, type CampaignUnitData } from './units';

/*
 * Hex maps for operational campaigns. Ids are "CCRR" (column, row), 1-based.
 * Flat-topped hexes, even columns shifted down (odd-q offset on 0-based
 * columns). Distance is cube distance; paths are BFS.
 */

// ---------- geometry ----------

export const hexId = (col: number, row: number): string => `${String(col).padStart(2, '0')}${String(row).padStart(2, '0')}`;
export const parseHex = (id: string): { col: number; row: number } => ({ col: Number(String(id).slice(0, 2)), row: Number(String(id).slice(2, 4)) });

function cube(id: string): { q: number; r: number; s: number } {
    const { col, row } = parseHex(id);
    const x = col - 1;
    const y = row - 1;
    const q = x;
    const r = y - (x - (x & 1)) / 2;
    return { q, r, s: -q - r };
}
export function hexDist(a: string, b: string): number {
    const A = cube(a);
    const B = cube(b);
    return (Math.abs(A.q - B.q) + Math.abs(A.r - B.r) + Math.abs(A.s - B.s)) / 2;
}
export function inMap(map: Pick<CampaignMap, 'cols' | 'rows'>, id: string): boolean {
    const { col, row } = parseHex(id);
    return col >= 1 && row >= 1 && col <= map.cols && row <= map.rows;
}
export function neighbors(map: Pick<CampaignMap, 'cols' | 'rows'>, id: string): string[] {
    const { col, row } = parseHex(id);
    const out: string[] = [];
    for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
            if (!dc && !dr) continue;
            const n = hexId(col + dc, row + dr);
            if (inMap(map, n) && hexDist(id, n) === 1) out.push(n);
        }
    }
    return out;
}
export function allHexes(map: Pick<CampaignMap, 'cols' | 'rows'>): string[] {
    const out: string[] = [];
    for (let c = 1; c <= map.cols; c++) for (let r = 1; r <= map.rows; r++) out.push(hexId(c, r));
    return out;
}
const SQ3 = Math.sqrt(3);
export function hexCenter(id: string, size: number): { x: number; y: number } {
    const { col, row } = parseHex(id);
    const x = col - 1;
    const y = row - 1;
    return { x: size + 1.5 * size * x, y: SQ3 * size * (y + 0.5 * (x & 1)) + (SQ3 / 2) * size };
}
export function hexPoints(cx: number, cy: number, size: number): string {
    return Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return `${(cx + size * Math.cos(a)).toFixed(1)},${(cy + size * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
}
export function mapPixelSize(map: Pick<CampaignMap, 'cols' | 'rows'>, size: number): { w: number; h: number } {
    return { w: size * (1.5 * (map.cols - 1) + 2), h: SQ3 * size * (map.rows + 0.5) };
}
export function hexType(map: CampaignMap, id: string): HexType {
    const t = map.hexes[id]?.t || HEX_DEFAULT;
    return map.hexTypes.find(x => x.id === t) || map.hexTypes[0];
}
export const hexName = (map: CampaignMap, id: string): string => map.hexes[id]?.name || '';
export const isNamed = (map: CampaignMap, id: string): boolean => (map.hexes[id]?.t || HEX_DEFAULT) !== HEX_DEFAULT;

export interface PathOptions {
    /** Hexes that can't be entered or passed. */
    blocked?: (id: string) => boolean;
    /** Hexes that can be the destination but not passed through. */
    stopOnly?: (id: string) => boolean;
}
/** Shortest path length from a to b within maxSteps, or null. */
export function pathLength(map: CampaignMap, a: string, b: string, maxSteps: number, opts: PathOptions = {}): number | null {
    const blocked = opts.blocked ?? (() => false);
    const stopOnly = opts.stopOnly ?? (() => false);
    if (a === b) return 0;
    const seen = new Set([a]);
    let frontier = [a];
    for (let step = 1; step <= maxSteps; step++) {
        const next: string[] = [];
        for (const h of frontier) {
            for (const n of neighbors(map, h)) {
                if (seen.has(n)) continue;
                seen.add(n);
                if (hexType(map, n).impassable) continue;
                if (n === b) return step;
                if (blocked(n) || stopOnly(n)) continue;
                next.push(n);
            }
        }
        frontier = next;
    }
    return null;
}

// ---------- map state ----------

export const mapOf = (c: Campaign, pub: Publication): CampaignMap | undefined =>
    c.contract?.map ? byId(pub, 'maps', c.contract.map.mapId) : undefined;

export function newMapState(map: CampaignMap): MapState {
    return {
        mapId: map.id, phase: 'landing', owner: {}, groups: [], enemy: [], lzHex: '', lzGroup: '', enemyLz: '', lzEffects: [],
        reinforcements: Number(map.rules.reinforcements) || 0, hold: { us: 0, them: 0 }, battles: 0, battle: null, fought: {},
        ended: null, finalDone: false, notes: [],
    };
}

export interface ActiveEffect extends MapEffect {
    from: string;
    typeId?: string;
    typeName?: string;
    lz?: boolean;
}
/** Effects in force for our side: hexes we hold, plus rolled landing-zone effects. */
export function activeEffects(c: Campaign, pub: Publication): ActiveEffect[] {
    const ms = c.contract?.map;
    const map = mapOf(c, pub);
    if (!ms || !map) return [];
    const out: ActiveEffect[] = [];
    for (const [h, side] of Object.entries(ms.owner)) {
        if (side !== 'us') continue;
        const t = hexType(map, h);
        for (const e of t.effects || []) out.push({ ...e, from: h, typeId: t.id, typeName: t.name });
    }
    for (const e of ms.lzEffects) out.push({ ...e, from: ms.lzHex, lz: true });
    return out;
}
export const effectsOf = (c: Campaign, pub: Publication, kind: MapEffectKind): ActiveEffect[] =>
    activeEffects(c, pub).filter(e => e.kind === kind);

const groupUnits = (c: Campaign, env: RunnerEnv, g: MapGroup): CampaignUnitData[] =>
    g.unitIds
        .map(id => c.units.find(u => u.id === id))
        .map(cu => (cu ? env.units(cu.unit) : undefined))
        .filter((u): u is CampaignUnitData => !!u);

/** Formation movement: the slowest 'Mech sets the pace. */
export function groupMove(c: Campaign, env: RunnerEnv, g: MapGroup): number {
    const R = mapOf(c, env.pub)!.rules;
    const heavy = isMovementHeavy(groupUnits(c, env, g), rulesFor(c.system), R);
    return heavy ? Number(R.heavyMove ?? 2) : Number(R.lightMove ?? 4);
}
export function groupAt(ms: MapState, hex: string): MapGroup | undefined {
    return ms.groups.find(g => g.hex === hex && g.unitIds.length);
}
export function enemyAt(ms: MapState, hex: string): EnemyMarker | undefined {
    return ms.enemy.find(e => e.hex === hex && !e.gone);
}
export function groupChecks(c: Campaign, env: RunnerEnv): string[] {
    const ms = c.contract?.map;
    const map = mapOf(c, env.pub);
    if (!ms || !map || !c.contract) return [];
    const R = map.rules;
    const out: string[] = [];
    const pool = (Number(R.bspPerScale) || 0) * c.contract.scale;
    const live = ms.groups.filter(g => g.unitIds.length);
    if (live.length > R.maxGroups) out.push(`${live.length} formations; the maximum is ${R.maxGroups}.`);
    for (const g of live) {
        if (g.unitIds.length > R.groupSize) out.push(`${g.name}: ${g.unitIds.length} units; the maximum is ${R.groupSize}.`);
        const meks = groupUnits(c, env, g).filter(isMek).length;
        if (meks < (R.minMechs ?? 1)) out.push(`${g.name} needs at least ${R.minMechs ?? 1} 'Mech.`);
        if (pool && (Number(g.bsp) || 0) < 1) out.push(`${g.name} needs at least 1 BSP.`);
    }
    const sum = live.reduce((s, g) => s + (Number(g.bsp) || 0), 0);
    if (pool && sum !== pool) out.push(`Formation BSP total ${sum}; the force has ${pool} to divide.`);
    return out;
}
/** Adjacent unoccupied, passable hex closest to a base (for withdrawals). */
export function withdrawHex(map: CampaignMap, ms: MapState, from: string, base: string): string | null {
    const occupied = (h: string) => !!groupAt(ms, h) || !!enemyAt(ms, h);
    const cands = neighbors(map, from).filter(h => !hexType(map, h).impassable && !occupied(h));
    if (!cands.length) return null;
    cands.sort((a, b) => hexDist(a, base || from) - hexDist(b, base || from));
    return cands[0];
}
/** Income per map turn from the hexes we hold, with percentage effects on target hex types. */
export function hexIncome(c: Campaign, pub: Publication) {
    const ms = c.contract?.map;
    const map = mapOf(c, pub);
    const lines: { hex: string; name: string; base: number; pct: number; value: number }[] = [];
    if (!ms || !map) return { total: 0, lines };
    const eff = activeEffects(c, pub);
    let total = 0;
    for (const [h, side] of Object.entries(ms.owner)) {
        if (side !== 'us') continue;
        const t = hexType(map, h);
        if (!t.income) continue;
        const pct = eff.filter(e => e.kind === 'incomePct' && e.target === t.id).reduce((s, e) => s + Number(e.value ?? e.pct ?? 0), 0);
        const v = Math.round(t.income * (1 + pct / 100));
        total += v;
        lines.push({ hex: h, name: hexName(map, h) || t.name, base: t.income, pct, value: v });
    }
    return { total, lines };
}
/** Resolve dice in landing-zone effects once, at landing. */
export function resolveLzEffects(t: HexType, rng: Rng = Math.random): MapEffect[] {
    return (t.lzEffects || []).map(e => {
        const x: MapEffect = { ...e };
        if (e.kind === 'incomePct' && e.die) {
            const r = roll(e.die, rng).total;
            x.roll = r;
            x.value = (e.sign ?? -1) * r * (Number(e.mult) || 10);
        } else if (e.kind === 'incomePct') {
            x.value = Number(e.pct) || 0;
        }
        return x;
    });
}
export function describeEffect(map: CampaignMap, e: MapEffect, system: GameSystem = GameSystem.CLASSIC): string {
    const tn = (id: string | undefined) => map.hexTypes.find(t => t.id === id)?.name || 'hexes';
    const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
    switch (e.kind) {
        case 'incomePct': {
            const amount = e.value != null ? `${signed(e.value)}%` : e.die ? `${(e.sign ?? -1) < 0 ? '−' : '+'}${e.die} × ${e.mult}%` : `${signed(e.pct ?? 0)}%`;
            return `${tn(e.target)} income ${amount}${e.roll ? ` (rolled ${e.roll})` : ''}`;
        }
        case 'maintPct': return `Maintenance +${e.die ? `${e.die} × ${e.mult}%` : `${e.pct}%`} each turn`;
        case 'purchase': return `'Mech purchases allowed, +${e.die ? `${e.die} × ${e.mult}%` : `${e.pct}%`} premium`;
        case 'reinforce': return `+${e.value} strategic reinforcement`;
        case 'recruit': return `Hire pilots at ${rulesFor(system).skillLabel({ gunnery: e.g ?? 4, piloting: e.p ?? 5, skill: e.skill ?? 4 })} (${e.cost} SP)`;
        case 'supportPct': return `Support +${e.value}%`;
        case 'bsp': {
            const note = system === GameSystem.ALPHA_STRIKE ? e.asNote : e.note;
            return `+${e.value} BSP${note ? ` (${note})` : ''}`;
        }
        case 'pilotSpMult': return `Pilot SP allocation ×${e.value}`;
        case 'heal': return `+${e.value} wound healed per turn`;
        case 'cancel': return `Cancels one opponent ${tn(e.target)}`;
        case 'garrison': return 'Garrison: may call unmoved formations in range to defend';
        case 'note': return e.text || '';
    }
}
