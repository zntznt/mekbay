// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type RandomPick, type RunnerEnv, type Winner } from './campaign.model';
import { roll, rowMatches } from './dice';
import { byId, type BriefNode, type Publication, type Side, type TableResult } from './publication.model';

/*
 * Mission-brief script: walks the current month's nodes, resolving branches
 * from recorded track winners, and stops at the first node that needs input
 * (an unplayed branch source, an unrolled random node, a choice, a loop decision).
 */

export interface PlanItem {
    key: string;
    nodeId: string;
    ancestors: string[];
    trackId: string;
    attacker: Side;
    label: string;
    optional: boolean;
    done: boolean;
    winner: Winner | undefined;
    rolled?: string;
}
export type PlanWait =
    | { type: 'result'; node: BriefNode; key: string; of?: string }
    | { type: 'random'; node: Extract<BriefNode, { kind: 'random' }>; key: string }
    | { type: 'choice'; node: Extract<BriefNode, { kind: 'choice' }>; key: string }
    | { type: 'loop'; node: Extract<BriefNode, { kind: 'loop' }>; key: string; n: number };
export interface MonthPlan {
    items: PlanItem[];
    waiting: PlanWait | null;
    notes: string[];
    ends: Extract<BriefNode, { kind: 'end' }>[];
}

export function monthPlan(c: Campaign, pub: Publication, monthIndex: number | null = null): MonthPlan {
    const ct = c.contract;
    const out: MonthPlan = { items: [], waiting: null, notes: [], ends: [] };
    if (!ct) return out;
    const brief = byId(pub, 'briefs', ct.briefId);
    const month = brief?.months[(monthIndex ?? ct.month) - 1];
    if (!month) return out;
    if (month.note) out.notes.push(month.note);
    const winnerOf = (id: string): Winner | undefined => ct.results[id];
    let blocked = false;
    const walk = (nodes: readonly BriefNode[] | undefined, prefix: string, ancestors: string[]): void => {
        for (const n of nodes || []) {
            if (blocked) return;
            const key = prefix + n.id;
            switch (n.kind) {
                case 'track': {
                    const w = winnerOf(key);
                    out.items.push({ key, nodeId: n.id, ancestors, trackId: n.trackId, attacker: n.attacker, label: n.label, optional: !!n.optional, done: w !== undefined, winner: w });
                    break;
                }
                case 'branch': {
                    const w = winnerOf(n.of);
                    if (w === undefined) {
                        blocked = true;
                        out.waiting = { type: 'result', node: n, key, of: n.of };
                        return;
                    }
                    const cs = n.cases.find(x => x.when === w);
                    if (cs) walk(cs.nodes, prefix, [...ancestors, key]);
                    break;
                }
                case 'lookup': {
                    const ws = n.keys.map(winnerOf);
                    if (ws.some(w => w === undefined)) {
                        blocked = true;
                        out.waiting = { type: 'result', node: n, key };
                        return;
                    }
                    const cs = n.cases.find(x => x.match.every((m, i) => m === ws[i]));
                    if (cs) walk(cs.nodes, prefix, [...ancestors, key]);
                    break;
                }
                case 'random': {
                    const picks = ct.rolls[key];
                    if (!picks) {
                        blocked = true;
                        out.waiting = { type: 'random', node: n, key };
                        return;
                    }
                    picks.forEach((x, i) => {
                        const k2 = `${key}#${i}`;
                        const w = winnerOf(k2);
                        out.items.push({ key: k2, nodeId: n.id, ancestors: [...ancestors, key], trackId: x.trackId, attacker: x.attacker || 'A', label: x.label || '', optional: false, done: w !== undefined, winner: w, rolled: x.log });
                    });
                    break;
                }
                case 'choice': {
                    const ch = ct.choices[key];
                    if (ch === undefined) {
                        blocked = true;
                        out.waiting = { type: 'choice', node: n, key };
                        return;
                    }
                    walk(n.options[ch]?.nodes, prefix, [...ancestors, key]);
                    break;
                }
                case 'loop': {
                    const st = ct.loops[key] || { n: 1, stopped: false };
                    for (let i = 0; i < st.n && !blocked; i++) walk(n.nodes, `${key}#${i}/`, [...ancestors, key]);
                    if (blocked) return;
                    const allDone = out.items.filter(x => x.key.startsWith(key + '#')).every(x => x.done);
                    if (allDone && !st.stopped && st.n < (n.max || 1)) {
                        blocked = true;
                        out.waiting = { type: 'loop', node: n, key, n: st.n };
                        return;
                    }
                    break;
                }
                case 'end':
                    out.ends.push(n);
                    break;
                case 'note':
                    out.notes.push(n.text);
                    break;
            }
        }
    };
    walk(month.nodes, '', []);
    return out;
}
export function nextItem(plan: MonthPlan): PlanItem | null {
    return plan.items.find(x => !x.done) || null;
}
export function monthComplete(plan: MonthPlan): boolean {
    return !plan.waiting && plan.items.every(x => x.done || x.optional);
}

/** Roll a random-track node on its table: rows whose result is a track (directly, by side, or via roll again). */
export function rollRandomNode(c: Campaign, env: RunnerEnv, key: string, node: Extract<BriefNode, { kind: 'random' }>): RandomPick[] {
    const ct = c.contract;
    if (!ct) throw new RuleError('No active contract.');
    const t = byId(env.pub, 'tables', node.tableId);
    if (!t) throw new RuleError('Random track node has no table.');
    const rng = env.rng ?? Math.random;
    const picks: RandomPick[] = [];
    const col = t.columns[0]?.key;
    const pushTrack = (res: TableResult | undefined, v: number) => {
        if (res?.kind === 'track') picks.push({ trackId: res.trackId, attacker: res.attacker || 'A', log: `${t.die} → ${v}` });
    };
    const once = (depth = 0): void => {
        const v = roll(t.die, rng).total;
        const res = col ? t.rows.find(x => rowMatches(x, v))?.cells?.[col] : undefined;
        if (!res) return;
        if (res.kind === 'track') pushTrack(res, v);
        else if (res.kind === 'rollAgain' && depth < 3) for (let i = 0; i < res.times; i++) once(depth + 1);
        else if (res.kind === 'bySide') pushTrack(ct.side === 'B' ? res.rb : res.ra, v);
    };
    for (let i = 0; i < (node.rolls || 1); i++) {
        let guard = 0;
        const before = picks.length;
        const isDup = () => picks.slice(before).some(p => picks.slice(0, before).some(q => q.trackId === p.trackId));
        do {
            picks.length = before;
            once();
        } while (node.dup === 'reroll' && isDup() && guard++ < 20);
    }
    ct.rolls[key] = picks;
    return picks;
}
export function makeChoice(c: Campaign, key: string, idx: number): void {
    if (c.contract) c.contract.choices[key] = idx;
}
export function loopDecision(c: Campaign, key: string, again: boolean): void {
    if (!c.contract) return;
    const st = c.contract.loops[key] || { n: 1, stopped: false };
    if (again) st.n++;
    else st.stopped = true;
    c.contract.loops[key] = st;
}
