// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { roll, rowLabel, rowMatches, type Rng } from './dice';
import { CONTRACT_TYPES, TERMS, resolveStep, stepLabel, type TermKey } from './engine';
import {
    byId, newBrief, newContract, newNode, uid, vget,
    type Brief, type Contract, type GeneratorChain, type GeneratorStep, type Publication, type TableResult, type TableRow,
} from './publication.model';

/*
 * Generator chains: ordered table rolls. Row tags from earlier steps steer
 * later steps (skip conditions, table and column choice, die modifiers,
 * contract-step shifts). The result is a draft that becomes a contract + brief.
 */

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const tagsOf = (...xs: unknown[]) => xs.flatMap(x => String(x ?? '').split(',')).map(norm).filter(Boolean);
const isTerm = (s: string): s is TermKey => (TERMS as readonly string[]).includes(s);

export interface StepResult {
    text: string;
    tags: string[];
    value: number | null;
    row?: TableRow;
    tableId?: string;
}
const hasTag = (res: StepResult | undefined, tag: string) => !!res && res.tags.includes(norm(tag));

function cellText(cell: TableResult | undefined, pub: Publication, system: GameSystem): string {
    if (!cell) return '';
    switch (cell.kind) {
        case 'text': return vget(cell.text, system) || '';
        case 'step': return cell.mode === 'set' ? stepLabel(cell.term, cell.value) : `${cell.value} step(s)`;
        case 'amount': return String(cell.value);
        case 'track': return byId(pub, 'tracks', cell.trackId)?.name || '';
        default: return '';
    }
}

export interface GeneratorDraft {
    terms: Partial<Record<TermKey, number>>;
    type?: string;
    typeDetail?: string;
    subtype?: string;
    opposedType?: string;
    employer?: string;
    length?: number | null;
    tracks?: number | null;
    jumps?: number | null;
    trackTableId?: string;
    system?: string;
    terrain?: string;
    faction?: string;
    intensity?: string;
    note?: string;
}

export interface GeneratorLogLine {
    depth: number;
    text: string;
    /** From a briefing-detail step (hidden until the contract is signed). */
    after?: boolean;
}

export interface RunGeneratorInput {
    pub: Publication;
    system?: GameSystem;
    inputs?: Record<string, string>;
    rng?: Rng;
}
export function runGenerator(gen: GeneratorChain, input: RunGeneratorInput) {
    const { pub, system = GameSystem.CLASSIC, inputs = {}, rng = Math.random } = input;
    const results: Record<string, StepResult> = {};
    const log: GeneratorLogLine[] = [];
    for (const inp of gen.inputs || []) {
        const v = inputs[inp.key] ?? '';
        results[inp.key] = { text: v, tags: tagsOf(v), value: Number(v) || null };
        log.push({ depth: 0, text: `${inp.label || inp.key}: ${v || '—'}` });
    }
    for (const st of gen.steps || []) {
        const at = log.length;
        step(st);
        if (st.after) for (let i = at; i < log.length; i++) log[i].after = true;
    }
    function step(st: GeneratorStep): void {
        if (st.when?.from && st.when.tag && !hasTag(results[st.when.from], st.when.tag)) {
            log.push({ depth: 0, text: `${st.label}: skipped` });
            return;
        }
        let tableId = st.tableId;
        if (st.tableMode === 'byStep') {
            const src = st.tableFrom ? results[st.tableFrom] : undefined;
            tableId = (st.tableMap || []).find(x => hasTag(src, x.tag))?.tableId || '';
        }
        const table = byId(pub, 'tables', tableId);
        if (st.noRoll) {
            results[st.id] = { text: table?.name || '', tags: tagsOf(table?.name), value: null, tableId };
            log.push({ depth: 0, text: `${st.label}: ${table ? table.name : '(no table matched)'}` });
            return;
        }
        if (!table) {
            log.push({ depth: 0, text: `${st.label}: no table` });
            results[st.id] = { text: '', tags: [], value: null };
            return;
        }
        let mod = 0;
        const modNotes: string[] = [];
        for (const m of st.dieMods || []) {
            if (hasTag(results[m.from], m.tag)) {
                mod += Number(m.add) || 0;
                modNotes.push(`${m.add > 0 ? '+' : ''}${m.add} ${m.tag}`);
            }
        }
        const v = roll(table.die, rng).total + mod;
        const row = table.rows.find(x => rowMatches(x, v));
        let col = table.columns[0];
        if (st.columnMode === 'fixed' && st.columnKey) col = table.columns.find(c => c.key === st.columnKey) || col;
        if (st.columnMode === 'byStep') {
            const src = st.columnFrom ? results[st.columnFrom] : undefined;
            col = table.columns.find(c => src && (norm(c.label) === norm(src.text) || src.tags.includes(norm(c.label)) || (src.value != null && norm(c.label) === String(src.value)))) || col;
        }
        let cell = col ? row?.cells?.[col.key] : undefined;
        let tags = tagsOf(row?.tag);
        let sub = '';
        if (cell?.kind === 'nested') {
            const r2 = roll(cell.die, rng).total;
            const nrow = (cell.rows || []).find(x => rowMatches(x, r2));
            sub = ` → sub-roll ${r2}`;
            tags = tags.concat(tagsOf(nrow?.tag));
            cell = nrow?.result;
        }
        let text = cellText(cell, pub, system);
        tags = tags.concat(tagsOf(text));
        let value: number | null = null;
        let stepNote = '';
        if (cell?.kind === 'step' && cell.mode === 'set') {
            let shift = 0;
            const shiftNotes: string[] = [];
            for (const sh of st.shifts || []) {
                if (hasTag(results[sh.from], sh.tag)) {
                    shift += Number(sh.add) || 0;
                    shiftNotes.push(`${sh.add > 0 ? '+' : ''}${sh.add} ${sh.tag}`);
                }
            }
            const term = isTerm(st.assign) ? st.assign : cell.term;
            const s0 = Number(cell.value);
            value = resolveStep(term, s0 + shift);
            text = `${stepLabel(term, value)} (${value})`;
            stepNote = shift ? ` [${s0}${shiftNotes.map(x => ' ' + x).join('')} → ${value}]` : '';
        } else {
            const n = /-?\d+/.exec(text);
            value = n ? Number(n[0]) : null;
        }
        results[st.id] = { text, tags, value, row, tableId };
        log.push({ depth: 0, text: `${st.label}: ${table.die}${modNotes.length ? ' ' + modNotes.join(' ') : ''} → ${v}${row ? ` (${rowLabel(row)})` : ' — no row'}${sub}: ${text || '—'}${stepNote}` });
    }
    const draft: GeneratorDraft = { terms: {} };
    for (const st of gen.steps || []) {
        const r = results[st.id];
        const a = st.assign;
        if (!r || !a) continue;
        if (isTerm(a)) {
            if (r.value != null) draft.terms[a] = r.value;
        } else if (a === 'length' || a === 'tracks' || a === 'jumps') draft[a] = r.value;
        else if (a === 'trackTable') draft.trackTableId = r.tableId;
        else if (a === 'type' || a === 'subtype' || a === 'opposedType') {
            const tag = r.row?.tag ? r.row.tag.split(',')[0].trim() : '';
            draft[a] = tag || r.text;
            if (a === 'type' && tag && r.text && norm(r.text) !== norm(tag)) draft.typeDetail = r.text;
        } else draft[a] = r.text;
    }
    return { log, results, draft };
}

/** Turn a generator draft into a contract and its brief, added to the publication. */
export function createFromDraft(pub: Publication, draft: GeneratorDraft, name = 'Generated contract'): { contract: Contract; brief: Brief } {
    const made = draftContract(draft, name);
    pub.contracts.push(made.contract);
    pub.briefs.push(made.brief);
    return made;
}

/** A contract and its brief from a generator draft, not yet added to any publication. */
export function draftContract(draft: GeneratorDraft, name = 'Generated contract'): { contract: Contract; brief: Brief } {
    const c = newContract();
    c.name = name;
    if (draft.type) c.type = draft.type.replace(/:$/, '');
    if (draft.subtype) c.subtype = draft.subtype;
    const subs = CONTRACT_TYPES[c.type] || [];
    if (!c.subtype && draft.typeDetail) {
        const hit = subs.find(x => norm(x) === norm(draft.typeDetail));
        if (hit) c.subtype = hit;
    }
    if (draft.employer) c.employer = draft.employer;
    if (draft.length) c.length = draft.length;
    for (const t of TERMS) {
        const s = draft.terms[t];
        if (s != null) c.terms[t] = s;
    }
    if (draft.system) c.location.planet = draft.system;
    if (draft.terrain) c.location.terrain = draft.terrain;
    c.notes = [
        draft.typeDetail && !c.subtype && `Type detail: ${draft.typeDetail}`,
        draft.faction && `Opposing faction: ${draft.faction}`,
        draft.jumps != null && `Jumps: ${draft.jumps}`,
        draft.opposedType && `Opposing contract type: ${draft.opposedType}`,
        draft.note,
    ].filter(Boolean).join('\n');
    const b = newBrief();
    b.name = name + ' — brief';
    b.sides[0].contractId = c.id;
    b.sides[0].label = 'Player';
    b.sides[1].label = draft.faction || 'Opposing force';
    c.briefId = b.id;
    const pattern = String(draft.intensity || '').split('-').map(x => x.trim()).filter(x => /^\d+$/.test(x)).map(Number);
    const months = c.length || pattern.length || 1;
    b.months = Array.from({ length: months }, () => ({ id: uid('mo'), note: '', nodes: [] }));
    let total = 0;
    pattern.forEach((n, i) => {
        const month = b.months[i];
        if (!month) return;
        for (let k = 0; k < n; k++) {
            total++;
            if (draft.trackTableId) month.nodes.push({ ...newNode('random'), tableId: draft.trackTableId, rolls: 1, dup: 'apply' });
            else month.nodes.push(newNode('track'));
        }
    });
    if (!pattern.length && draft.tracks) b.months[0].nodes.push({ ...newNode('note'), text: `${draft.tracks} track(s); set the monthly pattern.` });
    const count = total || draft.tracks || 0;
    b.intensity = { min: count, max: count };
    return { contract: c, brief: b };
}
