// SPDX-License-Identifier: GPL-3.0-or-later

import type { GameSystem } from '../../models/common.model';
import type { RollLogLine, TableRoller } from './campaign.model';
import { roll, rowLabel, rowMatches, type Rng } from './dice';
import { stepLabel, TERM_LABEL } from './engine';
import { byId, vget, type Publication, type Table, type TableResult, type TableRow } from './publication.model';

/*
 * Rolls a publication table into a log: pointer, count, nested and roll-again
 * results roll further tables; unit results carry their MekBay unit names.
 */

interface Ctx {
    pub: Publication;
    system: GameSystem;
    modifier: number;
    subModifier?: number;
    column?: string;
    rng: Rng;
    taken: Set<string>;
}

const MAX_DEPTH = 8;
// Publications are imported files: count/times fan-out can multiply past MAX_DEPTH, so cap total output too.
const MAX_LOG = 500;
const STOPPED = 'Stopped: too many rolls';
/** True once the budget is used up; notes it once in the log. */
function spent(log: RollLogLine[]): boolean {
    if (log.length < MAX_LOG) return false;
    if (log[log.length - 1]?.text !== STOPPED) log.push({ depth: 0, text: STOPPED });
    return true;
}

function describe(res: TableResult, ctx: Ctx): string {
    const { pub, system } = ctx;
    const table = (id: string) => byId(pub, 'tables', id)?.name || '(missing table)';
    const qty = (n: number, perScale: boolean) => (n > 1 || perScale ? `${n}×${perScale ? ' per Scale' : ''} ` : '');
    switch (res.kind) {
        case 'text': return vget(res.text, system) || '—';
        case 'units': return res.units.map(x => `${qty(x.qty || 1, !!x.perScale)}${x.unit}`).join('; ') || '(no units)';
        case 'pointer': return `Roll ${res.count > 1 ? `${res.count}× ` : ''}on ${table(res.tableId)}${res.column ? ` [${res.column}]` : ''}`;
        case 'rollAgain': return `Roll ${res.times}× and apply all${res.note ? `. ${res.note}` : ''}`;
        case 'nested': return `Roll ${res.die}`;
        case 'bySide': return `${res.a}: ${describe(res.ra, ctx)} | ${res.b}: ${describe(res.rb, ctx)}`;
        case 'amount': return `${res.value >= 0 ? '+' : ''}${res.value} ${res.currency}${res.perScale ? ' per Scale' : ''}${res.note ? ` — ${res.note}` : ''}`;
        case 'step': return res.mode === 'shift' ? `${TERM_LABEL[res.term]} ${res.value >= 0 ? '+' : ''}${res.value} step(s)` : `${TERM_LABEL[res.term]}: ${stepLabel(res.term, res.value)}`;
        case 'track': return byId(pub, 'tracks', res.trackId)?.name || '(missing track)';
        case 'asset': return `${qty(res.qty, res.perScale)}${byId(pub, 'assets', res.assetId)?.name || '(missing asset)'}`;
        case 'statBlock': return `${qty(res.qty, res.perScale)}${byId(pub, 'statBlocks', res.statBlockId)?.name || '(missing stat block)'}`;
        case 'count': return `Roll ${res.die} for rolls on ${table(res.tableId)}`;
        case 'pilot': return byId(pub, 'pilots', res.pilotId)?.name || '(missing pilot)';
        case 'upgrade': return byId(pub, 'upgrades', res.upgradeId)?.name || '(missing upgrade)';
        case 'none': return 'No result';
    }
}

function resolve(res: TableResult | undefined, ctx: Ctx, depth: number, log: RollLogLine[], t: Table): void {
    if (!res) {
        log.push({ depth, text: '—' });
        return;
    }
    switch (res.kind) {
        case 'pointer': {
            log.push({ depth, text: describe(res, ctx) });
            const next = byId(ctx.pub, 'tables', res.tableId);
            for (let i = 0; next && i < (res.count || 1) && !spent(log); i++) rollOn(next, { ...ctx, modifier: ctx.subModifier || 0, column: res.column || ctx.column }, depth + 1, log);
            return;
        }
        case 'count': {
            const r = roll(res.die, ctx.rng).total;
            const n = [...res.thresholds].sort((a, b) => b.min - a.min).find(x => r >= x.min)?.count ?? 0;
            log.push({ depth, text: `${res.die} → ${r}: ${n} roll(s)` });
            const next = byId(ctx.pub, 'tables', res.tableId);
            for (let i = 0; next && i < n && !spent(log); i++) rollOn(next, { ...ctx, modifier: 0 }, depth + 1, log);
            return;
        }
        case 'nested': {
            const r = roll(res.die, ctx.rng).total;
            log.push({ depth, text: `Sub-roll ${res.die} → ${r}` });
            resolve((res.rows || []).find(x => rowMatches(x, r))?.result, ctx, depth + 1, log, t);
            return;
        }
        case 'rollAgain': {
            log.push({ depth, text: describe(res, ctx) });
            const col = t.columns[0]?.key;
            const seen = new Set<TableRow>();
            // Rows that would roll again are rerolled, not applied; extra rolls are unmodified.
            const pick = () => {
                for (let g = 0; g < 30; g++) {
                    const v = roll(t.die, ctx.rng).total;
                    const row = t.rows.find(x => rowMatches(x, v));
                    if (row && row.cells?.[col]?.kind !== 'rollAgain') return { v, row };
                }
                return null;
            };
            for (let i = 0; i < res.times && !spent(log); i++) {
                let p = pick();
                for (let g = 0; p && seen.has(p.row) && (res.dup === 'reroll' || res.dup === 'rerollUntil') && g < 30; g++) p = pick();
                if (!p) {
                    log.push({ depth: depth + 1, text: 'no usable result' });
                    continue;
                }
                if (seen.has(p.row) && res.dup !== 'apply') {
                    log.push({ depth: depth + 1, text: `${p.v}: duplicate, ignored` });
                    continue;
                }
                seen.add(p.row);
                log.push({ depth: depth + 1, text: `${p.v}:` });
                resolve(p.row.cells?.[col], ctx, depth + 2, log, t);
            }
            return;
        }
        default:
            log.push({ depth, text: describe(res, ctx), units: res.kind === 'units' ? res.units.map(x => ({ unit: x.unit })) : null });
    }
}

function rollOn(t: Table, ctx: Ctx, depth: number, log: RollLogLine[]): void {
    if (spent(log)) return;
    if (depth > MAX_DEPTH) {
        log.push({ depth, text: 'Stopped: too many nested rolls' });
        return;
    }
    if (t.purpose === 'catalog') {
        log.push({ depth, text: `${t.name}: catalog, no roll` });
        return;
    }
    const r = roll(t.die, ctx.rng);
    const mod = Number(ctx.modifier) || 0;
    const v = r.total + mod;
    const row = t.rows.find(x => rowMatches(x, v));
    log.push({ depth, text: `${t.name}: ${t.die} [${r.dice.join(', ')}]${mod ? ` ${mod > 0 ? '+' : ''}${mod}` : ''} = ${v}${row ? ` (${rowLabel(row)})` : ', no row'}` });
    if (!row) return;
    if (row.unique && row.id) {
        if (ctx.taken.has(row.id)) {
            log.push({ depth: depth + 1, text: 'Already taken, fallback:' });
            resolve(row.fallback, ctx, depth + 2, log, t);
            return;
        }
        ctx.taken.add(row.id);
    }
    const cols = t.columnMode === 'select' && ctx.column ? t.columns.filter(c => c.key === ctx.column) : t.columns;
    for (const c of cols) {
        if (cols.length > 1) log.push({ depth: depth + 1, text: `${c.label}:` });
        resolve(row.cells?.[c.key], ctx, depth + (cols.length > 1 ? 2 : 1), log, t);
    }
}

/** Roll a table; matches `TableRoller` with the random source fixed. */
export function tableRoller(rng: Rng = Math.random): TableRoller {
    return (t, opts) => {
        const log: RollLogLine[] = [];
        rollOn(t, { ...opts, rng, taken: new Set() }, 0, log);
        return log;
    };
}
