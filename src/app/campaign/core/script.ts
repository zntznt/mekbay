// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type RandomPick, type RunnerEnv, type Winner } from './campaign.model';
import { roll, rowMatches, type Rng } from './dice';
import { briefNodes, byId, type AttackerRoll, type BriefNode, type Publication, type Side, type TableResult } from './publication.model';

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
    const rule = byId(env.pub, 'contracts', ct.contractId)?.attackerRoll;
    for (let i = 0; i < (node.rolls || 1); i++) {
        let guard = 0;
        const before = picks.length;
        const isDup = () => picks.slice(before).some(p => picks.slice(0, before).some(q => q.trackId === p.trackId));
        do {
            picks.length = before;
            once();
        } while (node.dup === 'reroll' && isDup() && guard++ < 20);
    }
    if (rule) {
        for (const p of picks) {
            const r = rollAttacker(rule, byId(env.pub, 'tracks', p.trackId)?.name || '', rng);
            if (!r) continue;
            p.attacker = r.attacks ? ct.side : ct.side === 'A' ? 'B' : 'A';
            p.log += ` · ${r.text}: ${r.attacks ? 'you attack' : 'you defend'}`;
        }
    }
    ct.rolls[key] = picks;
    return picks;
}
/** Whether the command attacks in a track, by its contract type's Attacker / Defender rule; null when the rule doesn't decide. */
export function rollAttacker(rule: AttackerRoll, trackName: string, rng: Rng): { attacks: boolean; text: string } | null {
    const byName = (rule.tracks || []).find(t => t.name && t.name.trim().toLowerCase() === trackName.trim().toLowerCase());
    if (byName) return { attacks: !!byName.attacker, text: trackName };
    if (!rule.die) return null;
    const v = roll(rule.die, rng).total;
    if (!Number.isFinite(v)) return null;
    return { attacks: v >= rule.min && v <= rule.max, text: `${rule.die} → ${v}` };
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

// ---------- brief flow (read-only view of the whole script) ----------

/** won / lost / draw: played; next: the track to play now; waiting: needs input now; open: not reached yet; off: on a path not taken. */
export type FlowState = 'won' | 'lost' | 'draw' | 'next' | 'waiting' | 'open' | 'off';
export interface FlowBranch {
    label: string;
    /** null while the outcome is not known yet. */
    taken: boolean | null;
    nodes: FlowNode[];
}
export interface FlowNode {
    key: string;
    kind: BriefNode['kind'];
    text: string;
    state: FlowState;
    trackId?: string;
    /** Track nodes: whether the command is the attacker. */
    attacking?: boolean;
    branches?: FlowBranch[];
}
export interface FlowMonth {
    n: number;
    note: string;
    current: boolean;
    nodes: FlowNode[];
}

// Imported scripts: cap what one view renders.
const FLOW_MAX_NODES = 1000;
const FLOW_MAX_DEPTH = 16;
const FLOW_MAX_LOOPS = 20;

/**
 * The contract's brief as a tree: every month, every branch, with the path
 * taken so far (results, choices, rolls) and the point that needs input now.
 * `focusKey` marks the track in play (defaults to the next unplayed track).
 */
export function briefFlow(c: Campaign, pub: Publication, focusKey?: string): FlowMonth[] {
    const ct = c.contract;
    const brief = ct ? byId(pub, 'briefs', ct.briefId) : undefined;
    if (!ct || !brief) return [];
    const plan = monthPlan(c, pub);
    const focus = focusKey ?? nextItem(plan)?.key;
    const waitKey = plan.waiting?.type === 'result' ? undefined : plan.waiting?.key;
    const sideLabel = (s: Side) => (s === ct.side ? 'you' : brief.sides.find(x => x.key === s)?.label || `side ${s}`);
    const outcome = (w: string) => (w === ct.side ? 'If you win' : w === 'none' ? 'If no one wins' : 'If you lose');
    const trackName = (id: string, label?: string) => label || byId(pub, 'tracks', id)?.name || 'Track';
    const nodeById = new Map<string, BriefNode>();
    for (const n of briefNodes(brief)) nodeById.set(n.id, n);
    const nameOf = (key: string) => {
        const n = nodeById.get(key.split('/').pop()!.split('#')[0]);
        return n?.kind === 'track' ? trackName(n.trackId, n.label) : 'an earlier track';
    };
    let budget = FLOW_MAX_NODES;
    type Mode = 'on' | 'maybe' | 'off';
    const sub = (mode: Mode, taken: boolean | null): Mode => (mode === 'off' || taken === false ? 'off' : taken === null ? 'maybe' : mode);
    const track = (key: string, trackId: string, attacker: Side, label: string, mode: Mode, extra = ''): FlowNode => {
        const w = ct.results[key];
        const state: FlowState = mode === 'off' ? 'off'
            : w !== undefined ? (w === ct.side ? 'won' : w === 'none' ? 'draw' : 'lost')
            : key === focus ? 'next' : 'open';
        return { key, kind: 'track', text: trackName(trackId, label) + extra, state, trackId, attacking: attacker === ct.side };
    };
    const walk = (nodes: readonly BriefNode[] | undefined, prefix: string, mode: Mode, depth: number): FlowNode[] => {
        const out: FlowNode[] = [];
        if (depth > FLOW_MAX_DEPTH) return out;
        for (const n of nodes || []) {
            if (budget-- <= 0) return out;
            const key = prefix + n.id;
            const pending: FlowState = mode === 'off' ? 'off' : mode === 'on' && key === waitKey ? 'waiting' : 'open';
            switch (n.kind) {
                case 'track':
                    out.push(track(key, n.trackId, n.attacker, n.label, mode, n.optional ? ' (optional)' : ''));
                    break;
                case 'branch': {
                    const w = ct.results[n.of];
                    const branches = n.cases.map(cs => {
                        const taken = w === undefined ? null : cs.when === w;
                        return { label: outcome(cs.when), taken, nodes: walk(cs.nodes, prefix, sub(mode, taken), depth + 1) };
                    });
                    out.push({ key, kind: n.kind, text: `After ${nameOf(n.of)}`, state: pending, branches });
                    break;
                }
                case 'lookup': {
                    const ws = n.keys.map(k => ct.results[k]);
                    const known = ws.every(w => w !== undefined);
                    const branches = n.cases.map(cs => {
                        const taken = known ? cs.match.every((m, i) => m === ws[i]) : null;
                        return { label: cs.match.map(outcome).join(', then '), taken, nodes: walk(cs.nodes, prefix, sub(mode, taken), depth + 1) };
                    });
                    out.push({ key, kind: n.kind, text: `By the results of ${n.keys.map(nameOf).join(' and ')}`, state: pending, branches });
                    break;
                }
                case 'random': {
                    const picks = ct.rolls[key];
                    const table = byId(pub, 'tables', n.tableId)?.name || 'a table';
                    const nodes = (picks || []).map((p, i) => track(`${key}#${i}`, p.trackId, p.attacker || 'A', p.label || '', sub(mode, true), ` (${p.log})`));
                    out.push({ key, kind: n.kind, text: `Random track${(n.rolls || 1) > 1 ? ` ×${n.rolls}` : ''} on ${table}`, state: pending, branches: picks ? [{ label: 'Rolled', taken: true, nodes }] : [] });
                    break;
                }
                case 'choice': {
                    const ch = ct.choices[key];
                    const branches = n.options.map((o, i) => {
                        const taken = ch === undefined ? null : ch === i;
                        return { label: o.label || `Option ${i + 1}`, taken, nodes: walk(o.nodes, prefix, sub(mode, taken), depth + 1) };
                    });
                    const who = sideLabel(n.side);
                    out.push({ key, kind: n.kind, text: who === 'you' ? 'You choose' : `${who} chooses`, state: pending, branches });
                    break;
                }
                case 'loop': {
                    const st = ct.loops[key] || { n: 1, stopped: false };
                    const rounds = Math.min(st.n, n.max || 1, FLOW_MAX_LOOPS);
                    const branches = Array.from({ length: rounds }, (_, i) => ({ label: `Round ${i + 1}`, taken: mode !== 'off', nodes: walk(n.nodes, `${key}#${i}/`, mode, depth + 1) }));
                    out.push({ key, kind: n.kind, text: `Repeat up to ${n.max || 1}×${n.until ? `: ${n.until}` : ''}`, state: pending, branches });
                    break;
                }
                case 'end':
                    out.push({ key, kind: n.kind, text: `End (${n.scope === 'contract' ? 'contract' : 'one side'}): ${n.text}`, state: mode === 'off' ? 'off' : 'open' });
                    break;
                case 'note':
                    out.push({ key, kind: n.kind, text: n.text, state: mode === 'off' ? 'off' : 'open' });
                    break;
            }
        }
        return out;
    };
    return brief.months.map((m, i) => ({ n: i + 1, note: m.note, current: i + 1 === ct.month, nodes: walk(m.nodes, '', 'on', 0) }));
}
