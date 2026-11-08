// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { compressNums, coverage, dieRange } from './dice';
import { TERMS, TERM_LABEL, bestBasePayTerms, contractEconomics, selectable, tempHireRoom, trackLimit } from './engine';
import {
    BETWEEN_BLOCKS, COLLECTIONS, briefNodes, byId, isSplit, tableResults, trackRange,
    type AttackerRoll, type CollectionKey, type Publication,
} from './publication.model';
import { rulesFor } from './rules';
import { REPAIR_TIME } from './runner';
import { unitGroup, type UnitLookup } from './units';
import { inMap, MAP_RULE_RANGES, MAX_MAP_SIDE, type MapRuleNum } from './hex-map';

export interface Issue {
    level: 'error' | 'warn' | 'info';
    coll: CollectionKey;
    id: string;
    msg: string;
}

const SYSTEM_NAME: Readonly<Record<GameSystem, string>> = { [GameSystem.CLASSIC]: 'Classic', [GameSystem.ALPHA_STRIKE]: 'Alpha Strike' };
const ym = (x: string | undefined): number | null => {
    const m = /^(\d{4})-(\d{1,2})$/.exec(String(x || '').trim());
    return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
};

const MAX_GEN_INPUTS = 20;
const MAX_ATTACKER_ROLLS = 50;
/** Problems with one Attacker / Defender rule (at most one message per kind). */
function attackerRollIssues(a: AttackerRoll): string[] {
    const out: string[] = [];
    const label = `Attacker / Defender rule ${a?.type || '(no type)'}`;
    if (!a?.type) out.push(`${label}: no contract type`);
    if (a?.die && !dieRange(a.die)) out.push(`${label}: bad die ${a.die}`);
    if (a?.die && !(Number.isFinite(a.min) && Number.isFinite(a.max) && a.min <= a.max)) out.push(`${label}: attacker range must be min ≤ max`);
    if (!Array.isArray(a?.tracks) || a.tracks.length > MAX_ATTACKER_ROLLS) out.push(`${label}: at most ${MAX_ATTACKER_ROLLS} track entries`);
    if (!a?.die && !a?.tracks?.length) out.push(`${label}: needs a die or track entries`);
    return out;
}

/**
 * Errors, warnings and notes for a publication. Unit checks run only when a
 * lookup is supplied (the MekBay catalog is loaded).
 */
export function validate(pub: Publication, units: UnitLookup | null = null): Issue[] {
    const out: Issue[] = [];
    const add = (level: Issue['level'], coll: CollectionKey, id: string, msg: string) => out.push({ level, coll, id, msg });
    const getUnit = (name: string | undefined) => (units && name ? units(name) : undefined);
    const both = pub.systems.includes(GameSystem.CLASSIC) && pub.systems.includes(GameSystem.ALPHA_STRIKE);
    const endYear = Number(String(pub.calendar?.end || '').slice(0, 4)) || null;

    // Duplicate ids
    const seen = new Set<string>();
    for (const c of COLLECTIONS) {
        for (const x of pub[c] as { id: string }[]) {
            if (seen.has(x.id)) add('error', c, x.id, `Duplicate id ${x.id}`);
            seen.add(x.id);
        }
    }
    const ref = (coll: CollectionKey, id: string | undefined, from: CollectionKey, fid: string, what: string) => {
        if (id && !byId(pub, coll, id)) add('error', from, fid, `${what}: reference to a missing ${coll.replace(/s$/, '')} (${id})`);
    };
    // Split values in a both-systems publication need both halves.
    const scanSplits = (obj: unknown, coll: CollectionKey, id: string, path = ''): void => {
        if (!obj || typeof obj !== 'object') return;
        if (isSplit(obj)) {
            const v = obj as Partial<Record<GameSystem, unknown>>;
            const cbt = v[GameSystem.CLASSIC];
            const as = v[GameSystem.ALPHA_STRIKE];
            if (both && (!cbt || !as) && (cbt || as)) add('warn', coll, id, `${path || 'Field'}: split by system but the ${SYSTEM_NAME[cbt ? GameSystem.ALPHA_STRIKE : GameSystem.CLASSIC]} version is empty`);
            return;
        }
        for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') scanSplits(v, coll, id, path ? `${path}.${k}` : k);
    };
    const tooLateUnit = (year: number | undefined) => !!endYear && !!year && year > endYear;

    // ---- Contracts ----
    for (const c of pub.contracts) {
        for (const t of TERMS) {
            const s = c.terms?.[t];
            if (s == null) add('error', 'contracts', c.id, `${TERM_LABEL[t]} has no step`);
            else if (!selectable(t, s)) add('error', 'contracts', c.id, `${TERM_LABEL[t]}: step ${s} is not selectable (—) in the Contract Steps Table`);
            const lk = c.locks?.[t];
            if (s != null && lk?.mode === 'min' && s < lk.value) add('error', 'contracts', c.id, `${TERM_LABEL[t]}: offered step ${s} is below its own lock (${lk.value})`);
            if (s != null && lk?.mode === 'max' && s > lk.value) add('error', 'contracts', c.id, `${TERM_LABEL[t]}: offered step ${s} is above its own lock (${lk.value})`);
        }
        if (!c.length || c.length < 1) add('warn', 'contracts', c.id, 'Contract length is not set');
        if (!c.location?.planet && !c.location?.random) add('warn', 'contracts', c.id, 'No location');
        ref('contracts', c.opposedId, 'contracts', c.id, 'Opposed contract');
        ref('briefs', c.briefId, 'contracts', c.id, 'Mission brief');
        ref('tables', c.purchase?.tableId, 'contracts', c.id, 'Purchase table');
        ref('variants', c.variantId, 'contracts', c.id, 'Rules variant');
        ref('maps', c.mapId, 'contracts', c.id, 'Campaign map');
        if (c.repairTime && c.repairTime !== 'roll' && !Object.hasOwn(REPAIR_TIME, c.repairTime)) add('error', 'contracts', c.id, `Unknown repair time "${c.repairTime}"`);
        for (const id of c.tempHirePilotIds || []) ref('pilots', id, 'contracts', c.id, 'Temporary hire');
        if (c.opposedId) {
            const o = byId(pub, 'contracts', c.opposedId);
            if (o && o.length !== c.length) add('warn', 'contracts', c.id, `Opposed contract ${o.name} has a different length (${o.length} vs ${c.length})`);
        }
        // Economics at Scale 1, offered terms, every track successful. Map contracts earn from hexes instead.
        const b = c.briefId ? byId(pub, 'briefs', c.briefId) : undefined;
        const tracks = b ? (b.intensity?.max ?? 1) : 1;
        const e = contractEconomics({ terms: c.terms, scale: 1, months: c.length || 1, tracks, outcome: 'success' });
        if (!c.mapId && e.net < 0) {
            const bestTerms = bestBasePayTerms(c.terms, { reputation: 1, scale: 1, locks: c.locks, nonNegotiable: c.nonNegotiable });
            const best = contractEconomics({ terms: bestTerms, scale: 1, months: c.length || 1, tracks, outcome: 'success' });
            if (best.net < 0) add('warn', 'contracts', c.id, `Loses ${-best.net} SP at Scale 1 even with every track successful and the best Base Pay a Reputation-1 force can negotiate (before repairs)`);
            else add('info', 'contracts', c.id, `Loses ${-e.net} SP at Scale 1 on the offered terms with every track successful; a Reputation-1 force can negotiate to +${best.net} SP`);
        }
        for (const h of c.tempHires || []) {
            const u = getUnit(h.unit);
            if (h.unit && units && !u) add('error', 'contracts', c.id, `Temp hire ${h.name}: unit ${h.unit} not found in MekBay data`);
            if (!u) continue;
            for (const sys of pub.systems) {
                const rules = rulesFor(sys);
                const v = rules.unitValue(u);
                const min = rules.limits.tempHireMinRoom;
                let minScale: number | null = null;
                for (let s = 1; s <= 6; s++) if (tempHireRoom(v, s, sys) > min) { minScale = s; break; }
                const room1 = tempHireRoom(v, 1, sys);
                if (room1 < min) add('warn', 'contracts', c.id, `Temp hire ${h.name} (${v} ${rules.valueLabel}): at Scale 1 you could field only ${Math.max(0, room1)} of your own alongside${minScale ? `; practical from Scale ${minScale}` : ''}`);
            }
            if (tooLateUnit(u.year)) add('warn', 'contracts', c.id, `Temp hire unit ${u.name} enters service ${u.year}, after the campaign window`);
        }
        scanSplits(c, 'contracts', c.id);
    }

    // ---- Briefs ----
    for (const b of pub.briefs) {
        const contracts = (b.sides || []).map(s => s.contractId).filter(Boolean);
        for (const id of contracts) ref('contracts', id, 'briefs', b.id, 'Side contract');
        const len = Math.max(0, ...contracts.map(id => byId(pub, 'contracts', id)?.length || 0));
        if (len && b.months.length !== len) add('warn', 'briefs', b.id, `Script has ${b.months.length} month(s); contract length is ${len}`);
        const [lo, hi] = trackRange(b.months.flatMap(m => m.nodes));
        const imin = b.intensity?.min ?? 0;
        const imax = b.intensity?.max ?? imin;
        if (hi < imin || lo > imax) add('warn', 'briefs', b.id, `Script produces ${lo === hi ? lo : `${lo}–${hi}`} track(s); Intensity says ${imin === imax ? imin : `${imin}–${imax}`}`);
        const ids = new Set<string>();
        for (const n of briefNodes(b)) {
            ids.add(n.id);
            switch (n.kind) {
                case 'track':
                    if (!n.trackId) add('error', 'briefs', b.id, `Track step${n.label ? ` "${n.label}"` : ''} has no track selected`);
                    ref('tracks', n.trackId, 'briefs', b.id, 'Track step');
                    if (n.repairTime && !Object.hasOwn(REPAIR_TIME, n.repairTime)) add('error', 'briefs', b.id, `Track step: unknown repair time "${n.repairTime}"`);
                    break;
                case 'branch':
                    if (!n.of) add('error', 'briefs', b.id, 'Branch has no source track');
                    else if (!ids.has(n.of)) add('error', 'briefs', b.id, 'Branch refers to a track that is not earlier in the script');
                    if (!n.cases.length) add('error', 'briefs', b.id, 'Branch has no outcomes');
                    break;
                case 'lookup': {
                    if (n.keys.some(k => !k || !ids.has(k))) add('error', 'briefs', b.id, 'Lookup keys must be earlier track steps');
                    const have = new Set(n.cases.map(c => c.match.join('/'))).size;
                    if (have < 4) add('warn', 'briefs', b.id, `Lookup covers ${have} of 4 winner combinations`);
                    break;
                }
                case 'random':
                    if (!n.tableId) add('error', 'briefs', b.id, 'Random step has no table');
                    ref('tables', n.tableId, 'briefs', b.id, 'Random step');
                    break;
                case 'choice':
                    if (!n.options.length) add('error', 'briefs', b.id, 'Choice has no options');
                    break;
                case 'loop':
                    if (!(n.max > 0)) add('error', 'briefs', b.id, 'Repeat has no cap');
                    break;
                default:
                    break;
            }
        }
        for (const f of b.forces || []) {
            if (!f.units.length) add('warn', 'briefs', b.id, `Granted force ${f.name || '(unnamed)'} has no units`);
            if ((f.fromMonth || 1) > b.months.length) add('error', 'briefs', b.id, `Granted force ${f.name || '(unnamed)'} joins in month ${f.fromMonth}, after the script ends`);
        }
        for (const sd of b.sides || []) {
            const conds = b.victoryConds?.[sd.key] || [];
            if (!conds.length && !b.victory) add('info', 'briefs', b.id, `No victory conditions for ${sd.label}`);
            for (const v of conds) {
                if (v.kind === 'survive' && !(b.forces || []).some(f => f.id === v.forceId)) add('error', 'briefs', b.id, `${sd.label}: survival condition points to a missing granted force`);
                if ((v.kind === 'winAll' || v.kind === 'winCount') && v.nodes.some(id => !ids.has(id))) add('error', 'briefs', b.id, `${sd.label}: victory condition points to a missing track step`);
                if (v.kind === 'winAll' && !v.nodes.length) add('error', 'briefs', b.id, `${sd.label}: "wins all of these tracks" has no tracks selected`);
            }
        }
        ref('tables', b.complications?.tableId, 'briefs', b.id, 'Complications table');
        for (const sys of pub.systems) {
            ref('tables', b.mapsheets?.[sys], 'briefs', b.id, `${SYSTEM_NAME[sys]} terrain table`);
            if (!b.mapsheets?.[sys]) add('info', 'briefs', b.id, `No terrain table (${SYSTEM_NAME[sys]})`);
        }
        scanSplits(b, 'briefs', b.id);
    }

    // ---- Tracks ----
    const isText = (v: unknown) => v == null || typeof v === 'string' || isSplit(v);
    for (const t of pub.tracks) {
        if (!isText(t.situation)) add('error', 'tracks', t.id, 'Situation must be text');
        for (const o of t.objectives) if (!isText(o.text)) add('error', 'tracks', t.id, `Objective "${o.name}": text must be text`);
        if (!t.generalRef && !t.objectives.length) add('warn', 'tracks', t.id, 'Custom track has no objectives');
        for (const o of t.objectives) for (const r of o.requires || []) if (!t.objectives.some(x => x.id === r)) add('error', 'tracks', t.id, `Objective "${o.name}" requires a missing objective`);
        for (const m of t.mods || []) if (!t.generalRef && m.op !== 'note') add('warn', 'tracks', t.id, 'Modifications only apply to a referenced general track');
        scanSplits(t, 'tracks', t.id);
    }

    // ---- Tables ----
    for (const t of pub.tables) {
        const modMin = (t.mods || []).reduce((s, m) => s + Math.min(0, Number(m.value) || 0), 0);
        const modMax = (t.mods || []).reduce((s, m) => s + Math.max(0, Number(m.value) || 0), 0);
        if (t.purpose !== 'catalog') {
            const r = dieRange(t.die, modMin, modMax);
            if (!r) add('error', 'tables', t.id, `Die expression "${t.die}" is not valid`);
            else if (t.rows.length) {
                const cov = coverage(t.rows, r.min, r.max);
                if (cov.gaps.length) add('warn', 'tables', t.id, `No row for ${compressNums(cov.gaps)} (range ${r.min}–${r.max} incl. modifiers)`);
                if (cov.overlaps.length) add('warn', 'tables', t.id, `Overlapping rows at ${compressNums(cov.overlaps)}`);
            } else add('info', 'tables', t.id, 'Table has no rows');
        }
        for (const row of t.rows) {
            if (row.unique) {
                const f = row.fallback;
                if (!f || (f.kind === 'text' && !f.text)) add('warn', 'tables', t.id, `Row ${row.min ?? ''}${row.max != null && row.max !== row.min ? '–' + row.max : ''} is unique but has no fallback`);
            }
            for (const c of t.columns) {
                const res = row.cells?.[c.key];
                if (res?.kind !== 'nested') continue;
                const nr = dieRange(res.die);
                if (!nr) add('error', 'tables', t.id, `Sub-roll die "${res.die}" is not valid`);
                else {
                    const cov = coverage(res.rows || [], nr.min, nr.max);
                    if (cov.gaps.length) add('warn', 'tables', t.id, `Sub-roll on row ${row.min ?? ''}–${row.max ?? ''} has no row for ${compressNums(cov.gaps)}`);
                }
            }
        }
        for (const res of tableResults(t)) {
            switch (res.kind) {
                case 'pointer':
                    if (!res.tableId) add('error', 'tables', t.id, 'Roll-on-table result has no table');
                    ref('tables', res.tableId, 'tables', t.id, 'Pointer');
                    if (res.tableId === t.id) add('warn', 'tables', t.id, 'Table points to itself');
                    break;
                case 'track': ref('tracks', res.trackId, 'tables', t.id, 'Track result'); break;
                case 'between':
                    if (!Array.isArray(res.block) || res.block.some(x => !BETWEEN_BLOCKS.includes(x))) add('error', 'tables', t.id, `Between-tracks result: block must list ${BETWEEN_BLOCKS.join(', ')}`);
                    if (!Number.isFinite(Number(res.costPct ?? 0)) || Number(res.costPct) < -100) add('error', 'tables', t.id, 'Between-tracks result: cost change must be a number of at least −100%');
                    break;
                case 'count':
                    if (!res.tableId) add('error', 'tables', t.id, 'Availability roll has no table to roll on');
                    ref('tables', res.tableId, 'tables', t.id, 'Availability roll');
                    break;
                case 'asset': ref('assets', res.assetId, 'tables', t.id, 'Asset result'); break;
                case 'pilot':
                    if (!res.pilotId) add('error', 'tables', t.id, 'Pilot result has no pilot');
                    ref('pilots', res.pilotId, 'tables', t.id, 'Pilot result');
                    break;
                case 'upgrade': ref('upgrades', res.upgradeId, 'tables', t.id, 'Asset result'); break;
                case 'statBlock': ref('statBlocks', res.statBlockId, 'tables', t.id, 'Stat block result'); break;
                case 'units': {
                    const totals = new Map<GameSystem, number>();
                    for (const x of res.units) {
                        const u = getUnit(x.unit);
                        if (!u) {
                            if (units) add('error', 'tables', t.id, `Unit ${x.unit} not found in MekBay data`);
                            continue;
                        }
                        const q = (x.qty || 1) * (x.perScale ? (t.scale || 1) : 1);
                        for (const sys of pub.systems) totals.set(sys, (totals.get(sys) || 0) + rulesFor(sys).unitValue(u) * q);
                        if (tooLateUnit(u.year)) add('warn', 'tables', t.id, `${u.name} enters service ${u.year}, after the campaign window (${endYear})`);
                        if (t.purpose === 'purchase' && pub.systems.includes(GameSystem.CLASSIC) && u.bv > trackLimit(1, GameSystem.CLASSIC)) add('info', 'tables', t.id, `${u.name} (${u.bv} BV) can't be fielded at Scale 1`);
                    }
                    if (t.purpose === 'opfor') {
                        for (const [sys, v] of totals) {
                            const lim = trackLimit(t.scale || 1, sys);
                            if (v > lim) add('warn', 'tables', t.id, `OpFor result totals ${v} ${rulesFor(sys).valueLabel}; Scale ${t.scale} limit is ${lim}`);
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        }
        scanSplits(t, 'tables', t.id);
    }

    // ---- Assets ----
    for (const a of pub.assets) {
        if (a.bsp?.vet && a.bsp?.reg && a.bsp.vet < a.bsp.reg) add('warn', 'assets', a.id, `Veteran BSP cost (${a.bsp.vet}) is lower than regular (${a.bsp.reg}), likely a typo`);
    }

    // ---- Hot spots ----
    for (const h of pub.hotSpots) {
        for (const id of h.contractIds) ref('contracts', id, 'hotSpots', h.id, 'Contract');
        for (const id of h.briefIds) ref('briefs', id, 'hotSpots', h.id, 'Brief');
        for (const id of h.tableIds) ref('tables', id, 'hotSpots', h.id, 'Table');
        ref('halls', h.hallId, 'hotSpots', h.id, 'Hiring hall');
        ref('tables', h.worldTableId, 'hotSpots', h.id, 'World table');
        for (const v of h.venues || []) ref('tables', v.mapTableId, 'hotSpots', h.id, `Venue ${v.name}`);
        if (!h.contractIds.length) add('info', 'hotSpots', h.id, 'Hot spot has no contracts');
        const a = ym(h.availability?.from);
        const z = ym(h.availability?.to);
        const cs = ym(pub.calendar?.start);
        const ce = ym(pub.calendar?.end);
        if ((h.availability?.from && a == null) || (h.availability?.to && z == null)) add('warn', 'hotSpots', h.id, 'Availability dates must be YYYY-MM');
        if (a != null && cs != null && a < cs) add('warn', 'hotSpots', h.id, 'Available before the campaign starts');
        if (z != null && ce != null && z > ce) add('warn', 'hotSpots', h.id, 'Available after the campaign ends');
        const winLo = a ?? cs;
        const winHi = z ?? ce;
        if (winLo != null && winHi != null) {
            for (const id of h.contractIds) {
                const c = byId(pub, 'contracts', id);
                if (c && c.length > winHi - winLo + 1) add('warn', 'hotSpots', h.id, `${c.name} runs ${c.length} months; the window is ${winHi - winLo + 1}`);
            }
        }
        scanSplits(h, 'hotSpots', h.id);
    }

    // ---- Pilots ----
    for (const pl of pub.pilots) {
        const u = getUnit(pl.unit);
        if (pl.unit && units && !u) add('error', 'pilots', pl.id, `Unit ${pl.unit} not found in MekBay data`);
        if (u && tooLateUnit(u.year)) add('warn', 'pilots', pl.id, `${u.name} enters service ${u.year}, after the campaign window`);
        for (const id of pl.edgeAbilityIds || []) ref('edgeAbilities', id, 'pilots', pl.id, 'Edge Ability');
        ref('tables', pl.hire?.feeTableId, 'pilots', pl.id, 'Fee table');
        if (u && (pl.hire?.kind === 'temp' || pl.hire?.kind === 'withUnit')) {
            for (const sys of pub.systems) {
                const rules = rulesFor(sys);
                const v = rules.unitValue(u);
                const min = rules.limits.tempHireMinRoom;
                const room = tempHireRoom(v, 1, sys);
                if (room >= min) continue;
                let ms: number | null = null;
                for (let sc = 2; sc <= 6; sc++) if (tempHireRoom(v, sc, sys) >= min) { ms = sc; break; }
                add('warn', 'pilots', pl.id, `As a temp hire (${v} ${rules.valueLabel}) there's room for only ${Math.max(0, room)} of your own at Scale 1${ms ? `; practical from Scale ${ms}` : ''}`);
            }
        }
        if ((pl.edge ?? 1) > 10) add('warn', 'pilots', pl.id, 'More than 10 Edge tokens is off the ladder');
    }

    // ---- Halls ----
    for (const h of pub.halls) {
        ref('starSystems', h.systemId, 'halls', h.id, 'System');
        ref('generators', h.generatorId, 'halls', h.id, 'Generator');
        for (const id of [h.systemTableId, h.tempHireTableId, h.boardTableId]) ref('tables', id, 'halls', h.id, 'Table');
        for (const id of h.purchaseTableIds) ref('tables', id, 'halls', h.id, 'Purchase table');
        for (const id of h.pilotIds) ref('pilots', id, 'halls', h.id, 'Mercenary');
        for (const id of h.upgradeIds) ref('upgrades', id, 'halls', h.id, 'Asset');
        if (!h.generatorId) add('info', 'halls', h.id, 'No contract generator');
        if (!Number.isInteger(h.offersPerMonth) || h.offersPerMonth < 1 || h.offersPerMonth > 12) add('error', 'halls', h.id, 'Offers per month must be a whole number from 1 to 12');
    }

    // ---- Sponsors ----
    for (const sp of pub.sponsors) {
        ref('tables', sp.purchaseTableId, 'sponsors', sp.id, 'Purchase table');
        const t = byId(pub, 'tables', sp.purchaseTableId);
        if (t) {
            for (const res of tableResults(t)) {
                if (res.kind !== 'units') continue;
                for (const x of res.units) {
                    const u = getUnit(x.unit);
                    if (!u) continue;
                    const grp = unitGroup(u);
                    if (!sp.scope.includes(grp)) add('warn', 'sponsors', sp.id, `${u.name} is on the factory table but outside the sponsor's purchase scope (${grp})`);
                }
            }
        }
        if (!(sp.discountPct >= 0 && sp.discountPct < 100)) add('error', 'sponsors', sp.id, 'Discount must be 0–99%');
    }

    // ---- Generators ----
    const OFFER_ASSIGN: string[] = ['type', 'subtype', 'employer', 'length', ...TERMS];
    const ASSIGN_ONCE = ['type', 'employer', 'length', 'basePay', 'support', 'transport', 'salvage', 'command', 'system', 'tracks', 'intensity'];
    for (const g of pub.generators) {
        const known = new Set((g.inputs || []).map(x => x.key));
        const assigned: Record<string, string> = {};
        const earlier = (k: string | undefined) => !k || known.has(k);
        for (const st of g.steps) {
            if (st.tableMode === 'byStep') {
                if (!st.tableFrom || !earlier(st.tableFrom)) add('error', 'generators', g.id, `${st.label}: table choice must come from an earlier step`);
                for (const m of st.tableMap || []) ref('tables', m.tableId, 'generators', g.id, st.label);
                if (!(st.tableMap || []).length) add('error', 'generators', g.id, `${st.label}: no table mappings`);
            } else {
                if (!st.tableId) add('error', 'generators', g.id, `${st.label}: no table`);
                ref('tables', st.tableId, 'generators', g.id, st.label);
            }
            if (st.columnMode === 'byStep' && !earlier(st.columnFrom)) add('error', 'generators', g.id, `${st.label}: column must come from an earlier step`);
            for (const m of [...(st.dieMods || []), ...(st.shifts || [])]) {
                if (!m.from || !earlier(m.from)) add('error', 'generators', g.id, `${st.label}: a rule refers to a later or missing step`);
                if (!m.tag) add('warn', 'generators', g.id, `${st.label}: a rule has no tag`);
            }
            if (st.when?.from && !earlier(st.when.from)) add('error', 'generators', g.id, `${st.label}: condition refers to a later step`);
            if (st.after != null && typeof st.after !== 'boolean') add('error', 'generators', g.id, `${st.label}: "after" must be true or false`);
            if (st.after && OFFER_ASSIGN.includes(st.assign)) add('error', 'generators', g.id, `${st.label}: "${st.assign}" is negotiated before signing, so it cannot be a briefing detail`);
            if (ASSIGN_ONCE.includes(st.assign)) {
                const prev = assigned[st.assign];
                if (prev) add('warn', 'generators', g.id, `${st.label}: "${st.assign}" is already set by ${prev}`);
                assigned[st.assign] = st.label;
            }
            known.add(st.id);
        }
        if (g.purpose === 'contract' && !assigned['type']) add('info', 'generators', g.id, 'No step sets the contract type');
        if ((g.inputs || []).length > MAX_GEN_INPUTS) add('error', 'generators', g.id, `More than ${MAX_GEN_INPUTS} inputs`);
        if ((g.inputs || []).some(i => !i?.key)) add('error', 'generators', g.id, 'An input has no key');
        if ((g.attackerRolls || []).length > MAX_ATTACKER_ROLLS) add('error', 'generators', g.id, `More than ${MAX_ATTACKER_ROLLS} Attacker / Defender rules`);
        for (const a of (g.attackerRolls || []).slice(0, MAX_ATTACKER_ROLLS)) for (const m of attackerRollIssues(a)) add('error', 'generators', g.id, m);
    }
    for (const ct of pub.contracts) if (ct.attackerRoll) for (const m of attackerRollIssues(ct.attackerRoll)) add('error', 'contracts', ct.id, m);

    // ---- Star systems ----
    for (const sy of pub.starSystems) {
        for (const l of sy.links || []) ref('starSystems', l.to, 'starSystems', sy.id, 'Distance');
        if (sy.x == null || sy.y == null) add('info', 'starSystems', sy.id, 'No map coordinates; jumps must be set by hand');
    }

    // ---- Factions / backgrounds ----
    for (const f of pub.factions) {
        for (const x of f.contracts) {
            if (!x.contractId) add('warn', 'factions', f.id, 'Contract entry with no contract');
            ref('contracts', x.contractId, 'factions', f.id, 'Contract');
        }
        for (const id of [f.purchaseTableId, f.tankerTableId, f.baTableId]) ref('tables', id, 'factions', f.id, 'Table');
        for (const pc of f.parents) {
            for (const id of pc.scaIds) ref('scas', id, 'factions', f.id, 'SCA');
            for (const x of pc.units) if (units && !getUnit(x.unit)) add('error', 'factions', f.id, `Unit ${x.unit} not found`);
        }
        if (f.singleParent && f.parents.length !== 1) add('warn', 'factions', f.id, 'Marked single parent command but has ' + f.parents.length);
    }
    for (const bg of pub.backgrounds) for (const id of [bg.mechTableId, bg.tankerTableId, bg.baTableId]) ref('tables', id, 'backgrounds', bg.id, 'Table');

    // ---- Campaign maps ----
    for (const m of pub.maps || []) {
        const types = new Map(m.hexTypes.map(t => [t.id, t]));
        const used = new Set(Object.values(m.hexes).map(h => h?.t).filter(Boolean));
        const lzHexes = Object.entries(m.hexes).filter(([id, h]) => h?.t && types.get(h.t)?.lz && inMap(m, id));
        if (!lzHexes.length) add('warn', 'maps', m.id, 'No landing zone hexes: a player has nowhere to start.');
        const ends = new Set(lzHexes.map(([, h]) => h.end || ''));
        if (lzHexes.length && (ends.has('') || ends.size < 2)) add('warn', 'maps', m.id, 'Landing zones need a map end (north/south…) so opposing sides land apart.');
        for (const t of m.hexTypes) {
            if (!t.impassable && !t.noBattle && !t.trackId && used.has(t.id)) add('warn', 'maps', m.id, `Hex type "${t.name}" has no scenario track: a battle there can't start.`);
            ref('tracks', t.trackId, 'maps', m.id, `Hex type "${t.name}"`);
            for (const e of [...t.effects, ...t.lzEffects]) {
                if ((e.kind === 'incomePct' || e.kind === 'cancel') && e.target && !types.has(e.target)) add('error', 'maps', m.id, `Hex type "${t.name}": effect targets a missing hex type`);
            }
        }
        const sideOk = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_MAP_SIDE;
        if (!sideOk(m.cols) || !sideOk(m.rows)) add('error', 'maps', m.id, `Map size must be 1–${MAX_MAP_SIDE} columns and rows.`);
        const R = m.rules;
        for (const [k, [lo, hi]] of Object.entries(MAP_RULE_RANGES) as [MapRuleNum, readonly [number, number]][]) {
            const v = R[k];
            if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) add('error', 'maps', m.id, `Map rule ${k} must be a whole number ${lo}–${hi}.`);
        }
        // One issue per kind, not per hex: an imported map can list any number of hexes.
        let outside = 0;
        const missing = new Set<string>();
        for (const [h, x] of Object.entries(m.hexes)) {
            if (!/^\d{4}$/.test(h) || !inMap(m, h)) outside++;
            else if (x?.t && !types.has(x.t)) missing.add(h);
        }
        if (outside) add('info', 'maps', m.id, `${outside} hex entr${outside === 1 ? 'y is' : 'ies are'} not "CCRR" ids inside the ${m.cols}×${m.rows} grid and ${outside === 1 ? 'is' : 'are'} ignored.`);
        if (missing.size) add('error', 'maps', m.id, `${missing.size} hex(es) use a missing hex type (${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? '…' : ''}).`);
        if (m.rules.final?.enabled && !m.rules.final.trackId) add('warn', 'maps', m.id, 'Final battle is on but has no track.');
        ref('tracks', m.rules.final?.trackId, 'maps', m.id, 'Final battle');
        if (m.rules.victory?.holdTurns && !m.hexTypes.some(t => t.strategic && used.has(t.id))) add('info', 'maps', m.id, 'No strategic-point hexes: the "hold the strategic points" victory can\'t happen.');
        if (m.image && !m.image.startsWith('data:image/')) add('warn', 'maps', m.id, 'Background image is not an embedded data:image URL and is not shown.');
        if (m.image && m.image.length > 4e6) add('info', 'maps', m.id, `Background image is ${(m.image.length / 1e6).toFixed(1)} MB inside the publication; browser storage may run out.`);
        if (!pub.contracts.some(c => c.mapId === m.id)) add('info', 'maps', m.id, 'No contract plays on this map.');
    }

    // ---- Orphans ----
    const usedIds = new Set<string>();
    const use = (...xs: (string | undefined)[]) => xs.forEach(x => x && usedIds.add(x));
    for (const h of pub.hotSpots) use(...h.contractIds, ...h.briefIds, ...h.tableIds, ...(h.venues || []).map(v => v.mapTableId));
    for (const c of pub.contracts) use(c.briefId, c.purchase?.tableId);
    for (const m of pub.maps || []) {
        for (const t of m.hexTypes) use(t.trackId);
        use(m.rules.final?.trackId);
    }
    for (const b of pub.briefs) {
        use(...(b.sides || []).map(s => s.contractId), b.complications?.tableId, ...Object.values(b.mapsheets || {}));
        for (const n of briefNodes(b)) {
            if (n.kind === 'track') use(n.trackId);
            if (n.kind === 'random') use(n.tableId);
        }
    }
    for (const t of pub.tables) {
        for (const r of tableResults(t)) {
            if ('tableId' in r) use(r.tableId);
            if ('trackId' in r) use(r.trackId);
            if ('assetId' in r) use(r.assetId);
            if ('statBlockId' in r) use(r.statBlockId);
        }
    }
    for (const h of pub.halls) use(h.systemTableId, h.tempHireTableId, h.boardTableId, ...h.purchaseTableIds);
    use(...pub.sponsors.map(s => s.purchaseTableId), ...pub.pilots.map(p => p.hire?.feeTableId));
    use(...pub.factions.flatMap(f => [f.purchaseTableId, f.tankerTableId, f.baTableId, ...f.contracts.map(c => c.contractId)]));
    use(...pub.backgrounds.flatMap(b => [b.mechTableId, b.tankerTableId, b.baTableId]));
    use(...pub.generators.flatMap(g => g.steps.flatMap(st => [st.tableId, ...(st.tableMap || []).map(m => m.tableId)])));
    for (const coll of ['contracts', 'briefs', 'tracks', 'tables'] as const) {
        for (const x of pub[coll]) if (!usedIds.has(x.id)) add('info', coll, x.id, 'Not used anywhere');
    }
    return out;
}
