// SPDX-License-Identifier: GPL-3.0-or-later

/** A random source in [0, 1). `Math.random` satisfies it; tests pass a seeded one. */
export type Rng = () => number;

/** Deterministic PRNG (mulberry32). Same seed, same sequence. */
export function seededRng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface ParsedDie {
    n: number;
    sides: number;
    mod: number;
}

export interface RowRange {
    min: number | null;
    max: number | null;
}

/** Die expressions: "1D6", "2D6+1", "3D6", "1D6-2", "D6", "12" (flat). Case-insensitive. */
const MAX_DICE = 100;
const MAX_SIDES = 1000;

export function parseDie(expr: string | null | undefined): ParsedDie | null {
    const s = String(expr ?? '').replace(/\s+/g, '').toUpperCase();
    if (!s) return null;
    const m = /^(\d*)D(\d+)([+-]\d+)?$/.exec(s);
    if (m) {
        const n = Number(m[1] || 1), sides = Number(m[2]);
        // Publications are imported files: bound the dice so a typo can't hang the tab.
        if (n > MAX_DICE || sides > MAX_SIDES) return null;
        return { n, sides, mod: Number(m[3] || 0) };
    }
    if (/^[+-]?\d+$/.test(s)) return { n: 0, sides: 0, mod: Number(s) };
    return null;
}

export function dieRange(expr: string, extraMin = 0, extraMax = 0): { min: number; max: number } | null {
    const d = parseDie(expr);
    if (!d) return null;
    return { min: d.n + d.mod + extraMin, max: d.n * d.sides + d.mod + extraMax };
}

export function roll(expr: string, rng: Rng = Math.random): { total: number; dice: number[] } {
    const d = parseDie(expr);
    if (!d) return { total: NaN, dice: [] };
    const dice: number[] = [];
    for (let i = 0; i < d.n; i++) dice.push(1 + Math.floor(rng() * d.sides));
    return { total: dice.reduce((a, b) => a + b, 0) + d.mod, dice };
}

export function rowLabel(r: RowRange): string {
    if (r.min == null && r.max == null) return '—';
    if (r.min == null) return `${r.max}−`;
    if (r.max == null) return `${r.min}+`;
    if (r.min === r.max) return String(r.min);
    return `${r.min}–${r.max}`;
}

export function parseRowLabel(s: string): RowRange | null {
    const t = String(s).trim().replace(/[–—]/g, '-');
    let m: RegExpExecArray | null;
    if ((m = /^(-?\d+)\+$/.exec(t))) return { min: Number(m[1]), max: null };
    if ((m = /^(-?\d+)-$/.exec(t)) || (m = /^(-?\d+)−$/.exec(t))) return { min: null, max: Number(m[1]) };
    if ((m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(t))) return { min: Number(m[1]), max: Number(m[2]) };
    if ((m = /^(-?\d+)$/.exec(t))) return { min: Number(m[1]), max: Number(m[1]) };
    return null;
}

export function rowMatches(r: RowRange, v: number): boolean {
    return (r.min == null || v >= r.min) && (r.max == null || v <= r.max);
}

/** Values in [lo, hi] matched by no row (gaps) or by several rows (overlaps). */
export function coverage(rows: readonly RowRange[], lo: number, hi: number): { gaps: number[]; overlaps: number[] } {
    const gaps: number[] = [];
    const overlaps: number[] = [];
    for (let v = lo; v <= hi; v++) {
        const hits = rows.filter(r => rowMatches(r, v)).length;
        if (hits === 0) gaps.push(v);
        if (hits > 1) overlaps.push(v);
    }
    return { gaps, overlaps };
}

/** [2,3,4,7] → "2–4, 7". */
export function compressNums(ns: readonly number[]): string {
    if (!ns.length) return '';
    const out: string[] = [];
    let a = ns[0];
    let b = ns[0];
    for (let i = 1; i <= ns.length; i++) {
        if (ns[i] === b + 1) {
            b = ns[i];
            continue;
        }
        out.push(a === b ? `${a}` : `${a}–${b}`);
        a = b = ns[i];
    }
    return out.join(', ');
}
