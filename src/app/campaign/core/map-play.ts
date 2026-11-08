// SPDX-License-Identifier: GPL-3.0-or-later

import { isGone, RuleError, type Campaign, type CampaignUnit, type MapGroup, type MapOrder, type MapSide, type MapState, type RunnerEnv } from './campaign.model';
import { roll } from './dice';
import { ECON, purchasePrice } from './engine';
import {
    describeEffect, effectsOf, enemyAt, groupAt, groupChecks, groupMove, hexIncome, hexName, hexType, isNamed, reachable, recordMove, resolveLzEffects, toMove,
} from './hex-map';
import { isMek } from './units';
import { isBAPilot } from './pilots';
import { uid } from './publication.model';
import { repairQuote } from './market';
import { endMonth, note, post, unitName } from './runner';
import { mapCtx, startMapBattle } from './track';

/*
 * Operational campaign maps: landing, formation movement, battles triggered by
 * contact, per-turn hex income and the end-of-map checks. Each map turn is paid
 * like a month.
 */

export function landAt(c: Campaign, env: RunnerEnv, hex: string): void {
    const { ms, map } = mapCtx(c, env);
    if (ms.phase !== 'landing' || ms.lzHex) throw new RuleError('Already landed.');
    const t = hexType(map, hex);
    if (!t.lz) throw new RuleError('That hex is not a landing zone.');
    if (ms.enemyLz && ms.enemyLz === hex) throw new RuleError('The opponent landed there.');
    const end = map.hexes[hex]?.end || '';
    if (ms.enemyLz && end && (map.hexes[ms.enemyLz]?.end || '') === end) throw new RuleError('The opponent landed on that end of the map.');
    ms.lzHex = hex;
    ms.lzGroup = end;
    ms.owner[hex] = 'us';
    ms.lzEffects = resolveLzEffects(t, env.rng ?? Math.random);
    ms.reinforcements += ms.lzEffects.filter(e => e.kind === 'reinforce').reduce((s, e) => s + (Number(e.value) || 0), 0);
    const fx = ms.lzEffects.length ? ' — ' + ms.lzEffects.map(e => describeEffect(map, e, c.system)).join('; ') : '';
    note(c, `Landing: ${hexName(map, hex) || t.name} (${hex})${fx}`);
}
export function setEnemyLz(c: Campaign, env: RunnerEnv, hex: string): void {
    const { ms, map } = mapCtx(c, env);
    if (ms.phase !== 'landing') throw new RuleError('Already landed.');
    if (ms.enemyLz) delete ms.owner[ms.enemyLz];
    if (!hexType(map, hex).lz) throw new RuleError('That hex is not a landing zone.');
    if (ms.lzHex && ms.lzGroup && (map.hexes[hex]?.end || '') === ms.lzGroup) throw new RuleError('The opponent lands on the other end of the map.');
    ms.enemyLz = hex;
    ms.owner[hex] = 'them';
}
/** Formations are organised while landing, and at the start of a map turn before anything moves. */
function canReorganise(c: Campaign, ms: MapState): void {
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    if (ms.phase === 'ended') throw new RuleError('The map campaign is over.');
    if (ms.phase === 'turns' && (ms.groups.some(g => g.moved) || ms.enemy.some(e => e.moved))) {
        throw new RuleError('Formations can be split or merged only at the start of a map turn, before anything moves.');
    }
}
export function addGroup(c: Campaign, env: RunnerEnv, name: string, unitIds: string[], bsp = 0): MapGroup {
    const { ms, R } = mapCtx(c, env);
    canReorganise(c, ms);
    if (ms.groups.length >= R.maxGroups) throw new RuleError(`The maximum is ${R.maxGroups} formations.`);
    const g: MapGroup = { id: uid('fg'), name: name || `Formation ${ms.groups.length + 1}`, hex: ms.lzHex, unitIds: [], bsp: 0, moved: false };
    ms.groups.push(g);
    editGroup(c, env, g.id, { unitIds, bsp });
    return g;
}
/** Rename a formation, change its units (own units not in another formation) or its BSP share. */
export function editGroup(c: Campaign, env: RunnerEnv, gid: string, patch: { name?: string; unitIds?: string[]; bsp?: number }): void {
    const { ms, R, ct } = mapCtx(c, env);
    canReorganise(c, ms);
    const g = ms.groups.find(x => x.id === gid);
    if (!g) throw new RuleError('No such formation.');
    if (patch.name != null) g.name = patch.name.trim() || g.name;
    if (patch.bsp != null) {
        const v = Number(patch.bsp);
        if (!Number.isInteger(v) || v < 0) throw new RuleError('BSP must be a whole number, 0 or more.');
        g.bsp = v;
    }
    if (patch.unitIds) {
        const ids = [...new Set(patch.unitIds)];
        if (ids.length > R.groupSize) throw new RuleError(`${g.name}: the maximum is ${R.groupSize} units.`);
        for (const id of ids) {
            const cu = c.units.find(u => u.id === id);
            if (!cu || cu.tempHire || isGone(cu.state)) throw new RuleError('That unit cannot join a formation.');
            if (cu.arrives && ct.month < cu.arrives) throw new RuleError(`That unit arrives at the landing zone on turn ${cu.arrives}.`);
            const other = ms.groups.find(x => x !== g && x.unitIds.includes(id));
            if (other) throw new RuleError(`That unit is already in ${other.name}.`);
        }
        // A formation reorganised mid-campaign forms up at the landing zone.
        if (ms.phase === 'turns' && ids.some(id => !g.unitIds.includes(id)) && g.hex !== ms.lzHex) {
            throw new RuleError(`${g.name} is away from the landing zone; new units join a formation there.`);
        }
        g.unitIds = ids;
    }
}
export function removeGroup(c: Campaign, env: RunnerEnv, gid: string): void {
    const { ms } = mapCtx(c, env);
    canReorganise(c, ms);
    ms.groups = ms.groups.filter(g => g.id !== gid);
}
export function beginMapTurns(c: Campaign, env: RunnerEnv): void {
    const { ms } = mapCtx(c, env);
    const errs = groupChecks(c, env);
    if (errs.length) throw new RuleError(errs.join(' '));
    if (!ms.lzHex) throw new RuleError('Land first.');
    if (!ms.enemyLz) throw new RuleError("Set the opponent's landing zone first.");
    for (const g of ms.groups) {
        g.hex = ms.lzHex;
        g.moved = false;
    }
    ms.phase = 'turns';
    ms.order = null;
}

// ---------- move order ----------

/** Roll Initiative for the map turn (2D6 each side, ties rerolled); the winner then chooses who moves first. */
export function rollMapInitiative(c: Campaign, env: RunnerEnv): MapOrder {
    const { ms } = mapCtx(c, env);
    if (ms.phase !== 'turns') throw new RuleError('Map turns have not started.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    if (ms.order) throw new RuleError('Initiative is already rolled for this map turn.');
    const rng = env.rng ?? Math.random;
    let us = 0;
    let them = 0;
    for (let i = 0; i < 50 && us === them; i++) {
        us = roll('2D6', rng).total;
        them = roll('2D6', rng).total;
    }
    ms.order = { rolls: { us, them }, winner: us >= them ? 'us' : 'them', side: '', used: 0 };
    return ms.order;
}
/** The Initiative winner's choice: which side moves first. */
export function chooseMapOrder(c: Campaign, env: RunnerEnv, first: MapSide): void {
    const { ms } = mapCtx(c, env);
    if (!ms.order) throw new RuleError('Roll Initiative first.');
    if (ms.order.side) throw new RuleError('The move order is already chosen.');
    ms.order.side = first;
    ms.order.used = 0;
}
function requireMove(ms: MapState, side: MapSide): void {
    if (!ms.order) throw new RuleError('Roll Initiative for this map turn first.');
    if (!ms.order.side) throw new RuleError('The Initiative winner chooses who moves first.');
    const w = toMove(ms);
    if (w && w !== side) throw new RuleError(w === 'us' ? 'It is your move.' : "It is the opponent's move.");
}
/** Where a formation can move this turn, with the hexes it takes. Enemy hexes end the move (a battle). */
export function legalMoves(c: Campaign, env: RunnerEnv, gid: string): Map<string, number> {
    const { ms, map } = mapCtx(c, env);
    const g = ms.groups.find(x => x.id === gid);
    if (ms.phase !== 'turns' || !g || !g.unitIds.length || g.moved || c.draft) return new Map();
    const blocked = (h: string) => !!enemyAt(ms, h) || h === ms.enemyLz;
    return reachable(map, g.hex, groupMove(c, env, g), { blocked });
}
export function moveGroup(c: Campaign, env: RunnerEnv, gid: string, to: string) {
    const { ms, map, R } = mapCtx(c, env);
    if (ms.phase !== 'turns') throw new RuleError('Map turns have not started.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    const g = ms.groups.find(x => x.id === gid);
    if (!g || !g.unitIds.length) throw new RuleError('No such formation.');
    if (g.moved) throw new RuleError(`${g.name} has already moved this turn.`);
    requireMove(ms, 'us');
    const t = hexType(map, to);
    if (t.impassable) throw new RuleError(`${t.name} can't be entered.`);
    const steps = legalMoves(c, env, gid).get(to);
    if (steps == null) throw new RuleError(`${g.name} moves ${groupMove(c, env, g)} hexes; ${to} is out of reach${ms.enemy.some(e => !e.gone) ? ' (enemy formations and impassable hexes block the way)' : ''}.`);
    const foe = enemyAt(ms, to) || (to === ms.enemyLz ? { id: 'hq' } : null);
    if (foe) return startMapBattle(c, env, { hex: to, from: g.hex, groupId: g.id, enemyId: foe.id, ourRole: 'attacker' });
    const mate = groupAt(ms, to);
    if (mate && mate !== g) {
        if (mate.unitIds.length + g.unitIds.length > R.groupSize) throw new RuleError(`Merging would make ${mate.unitIds.length + g.unitIds.length} units; the maximum is ${R.groupSize}.`);
        mate.unitIds.push(...g.unitIds);
        mate.bsp = (Number(mate.bsp) || 0) + (Number(g.bsp) || 0);
        g.unitIds = [];
        mate.moved = true;
        recordMove(ms, 'us');
        return { merged: mate.name };
    }
    g.hex = to;
    g.moved = true;
    recordMove(ms, 'us');
    g.garrison = (t.effects || []).some(e => e.kind === 'garrison');
    if (isNamed(map, to) && !t.noBattle) ms.owner[to] = 'us';
    return { moved: steps };
}
/** A formation elects not to move: that is its move. */
export function stayGroup(c: Campaign, env: RunnerEnv, gid: string): void {
    const { ms } = mapCtx(c, env);
    const g = ms.groups.find(x => x.id === gid);
    if (!g || g.moved || c.draft) return;
    requireMove(ms, 'us');
    g.moved = true;
    recordMove(ms, 'us');
}
export function stayEnemy(c: Campaign, env: RunnerEnv, eid: string): void {
    const { ms } = mapCtx(c, env);
    const e = ms.enemy.find(x => x.id === eid && !x.gone);
    if (!e || e.moved || c.draft) return;
    requireMove(ms, 'them');
    e.moved = true;
    recordMove(ms, 'them');
}
/** Opponent formations are markers moved by the player (or a GM, or an opponent module). */
export function addEnemy(c: Campaign, env: RunnerEnv, name: string, hex = ''): void {
    const { ms } = mapCtx(c, env);
    if (!ms.enemyLz) throw new RuleError("Set the opponent's landing zone first.");
    ms.enemy.push({ id: uid('en'), name: name || `Enemy ${ms.enemy.length + 1}`, hex: hex || ms.enemyLz, moved: false, note: '' });
}
export function moveEnemy(c: Campaign, env: RunnerEnv, eid: string, to: string) {
    const { ms, map } = mapCtx(c, env);
    const e = ms.enemy.find(x => x.id === eid);
    if (!e) throw new RuleError('No such enemy formation.');
    if (ms.phase !== 'turns') throw new RuleError('Map turns have not started.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    if (e.moved) throw new RuleError(`${e.name} has already moved this turn.`);
    requireMove(ms, 'them');
    if (hexType(map, to).impassable) throw new RuleError("That hex can't be entered.");
    const mine = groupAt(ms, to) || (to === ms.lzHex ? { id: '' } : null);
    if (mine) return startMapBattle(c, env, { hex: to, from: e.hex, groupId: mine.id, enemyId: e.id, ourRole: 'defender' });
    e.hex = to;
    e.moved = true;
    recordMove(ms, 'them');
    if (isNamed(map, to) && !hexType(map, to).noBattle) ms.owner[to] = 'them';
    return null;
}
/** Take an opponent marker off the map (destroyed or withdrawn at the table). */
export function removeEnemy(c: Campaign, env: RunnerEnv, eid: string): void {
    const { ms } = mapCtx(c, env);
    const e = ms.enemy.find(x => x.id === eid);
    if (!e) throw new RuleError('No such enemy formation.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    e.gone = true;
}
// ---------- units arriving mid-map ----------

/** Own units at the landing zone with no formation: bought, replaced or received during the map campaign. */
export function waitingAtLz(c: Campaign, env: RunnerEnv): CampaignUnit[] {
    const { ms, ct } = mapCtx(c, env);
    const inGroup = new Set(ms.groups.flatMap(g => g.unitIds));
    return c.units.filter(u => !u.tempHire && !u.leftBehind && !u.delivery && !u.scrapCheck && !isGone(u.state) && !inGroup.has(u.id) && !(u.arrives && ct.month < u.arrives));
}
/**
 * Put waiting units into a new formation at the landing zone, or into a formation
 * that is at the landing zone (it came to collect them). With every formation slot
 * taken they wait for one to open or for a formation to come back.
 */
export function deployArrivals(c: Campaign, env: RunnerEnv, unitIds: string[], gid = ''): MapGroup {
    const { ms, R } = mapCtx(c, env);
    if (ms.phase !== 'turns') throw new RuleError('Map turns have not started.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    const waiting = new Set(waitingAtLz(c, env).map(u => u.id));
    const ids = [...new Set(unitIds)].filter(id => waiting.has(id));
    if (!ids.length) throw new RuleError('Choose units waiting at the landing zone.');
    if (gid) {
        const g = ms.groups.find(x => x.id === gid && x.unitIds.length);
        if (!g) throw new RuleError('No such formation.');
        if (g.hex !== ms.lzHex) throw new RuleError(`${g.name} must be at the landing zone to collect units.`);
        if (g.unitIds.length + ids.length > R.groupSize) throw new RuleError(`${g.name}: the maximum is ${R.groupSize} units.`);
        g.unitIds.push(...ids);
        return g;
    }
    const live = ms.groups.filter(g => g.unitIds.length);
    if (live.length >= R.maxGroups) throw new RuleError(`All ${R.maxGroups} formation slots are taken: the units wait at the landing zone.`);
    if (ids.length > R.groupSize) throw new RuleError(`A formation has at most ${R.groupSize} units.`);
    const meks = ids.map(id => c.units.find(u => u.id === id)).filter(u => !!u && isMek(env.units(u.unit))).length;
    if (meks < (R.minMechs ?? 1)) throw new RuleError(`A formation needs at least ${R.minMechs ?? 1} 'Mech.`);
    ms.groups = live;
    const g: MapGroup = { id: uid('fg'), name: `Formation ${ms.groups.length + 1}`, hex: ms.lzHex, unitIds: ids, bsp: 0, moved: false };
    ms.groups.push(g);
    return g;
}

/** Strategic reinforcement: a 'Mech restored as if under Battle/100%; arrives at the landing zone next turn. */
export function reinforceUnit(c: Campaign, env: RunnerEnv, cuId: string): void {
    const { ms, ct } = mapCtx(c, env);
    const cu = c.units.find(u => u.id === cuId);
    const u = cu ? env.units(cu.unit) : undefined;
    if (!cu || u?.type !== 'Mek') throw new RuleError("Only 'Mechs can be replaced.");
    if (cu.state === 'ok') throw new RuleError('That unit needs no replacement.');
    if (ms.reinforcements <= 0) throw new RuleError('No strategic reinforcements left.');
    const cost = cu.state === 'truly' || cu.state === 'lost' ? purchasePrice(u, c.system) : repairQuote(c, env, cu)?.cost || 0;
    post(c, { event: `Strategic reinforcement: ${unitName(cu)}`, cost, cover: cost, kind: 'repair' });
    ms.reinforcements--;
    cu.state = 'ok';
    cu.damagedInContract = false;
    delete cu.lostTo;
    cu.arrives = ct.month + 1;
    for (const g of ms.groups) g.unitIds = g.unitIds.filter(id => id !== cu.id);
}
/** End of map turn: hex income replaces combat pay and funds pilot SP; victory checks; then the month rolls on. */
export function endMapTurn(c: Campaign, env: RunnerEnv, { designated = 0 } = {}) {
    const { ms, map, R, ct } = mapCtx(c, env);
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    if (ms.phase !== 'turns') throw new RuleError('Map turns have not started.');
    const inc = hexIncome(c, env.pub);
    // Pilot SP from income: 200 × Scale (× multipliers), split among named pilots who fought, 100 per track each.
    const mult = effectsOf(c, env.pub, 'pilotSpMult').reduce((m, e) => m * (Number(e.value) || 1), 1);
    const fought = c.pilots.filter(p => ms.fought[p.id]);
    let per = 0;
    if (fought.length && designated > 0) {
        const cap = Math.min(inc.total, 200 * ct.scale * mult);
        per = Math.floor(Math.min(designated, cap) / fought.length);
        for (const p of fought) {
            const share = Math.min(per, 100 * ms.fought[p.id] * mult);
            const s2 = isBAPilot(p) ? Math.floor(share / 2) : share;
            p.earned += s2;
            p.unspent += s2;
        }
    }
    const toPilots = per * fought.length;
    if (inc.total) {
        const held = inc.lines.map(l => `${l.name}${l.pct ? ` ${l.pct > 0 ? '+' : ''}${l.pct}%` : ''}`).join(' + ');
        post(c, { event: `Hexes held: ${held}${toPilots ? `, ${toPilots} SP to pilots` : ''}`, cover: inc.total - toPilots, kind: 'combat' });
    }
    const rng = env.rng ?? Math.random;
    for (const e of effectsOf(c, env.pub, 'maintPct')) {
        const pctv = e.die ? roll(e.die, rng).total * (Number(e.mult) || 5) : Number(e.pct) || 0;
        post(c, { event: `Maintenance +${pctv}% (${e.lz ? 'landing zone' : 'hex'} effect)`, cost: Math.round(ECON.maintenancePerScale * ct.scale * pctv / 100), kind: 'month', allowDebt: true });
    }
    // Strategic points held by one side for N complete turns.
    const strat = Object.keys(map.hexes).filter(h => hexType(map, h).strategic);
    if (strat.length) {
        const all = (side: MapSide) => strat.every(h => ms.owner[h] === side);
        ms.hold.us = all('us') ? ms.hold.us + 1 : 0;
        ms.hold.them = all('them') ? ms.hold.them + 1 : 0;
        const need = Number(R.victory?.holdTurns) || 2;
        if (!ms.ended && ms.hold.us >= need) ms.ended = { by: 'hold', winner: 'us', text: `Held the strategic points for ${need} turns.` };
        if (!ms.ended && ms.hold.them >= need) ms.ended = { by: 'hold', winner: 'them', text: `The opponent held the strategic points for ${need} turns.` };
    }
    if (!ms.ended && R.victory?.zeroSp && c.warchest <= 0) ms.ended = { by: 'sp', winner: 'them', text: 'Your Warchest is at 0 SP.' };
    if (!ms.ended && ct.month >= ct.length) ms.ended = { by: 'turns', winner: '', text: `${ct.length} map turns have passed: the side with the higher Warchest wins.` };
    ms.fought = {};
    ms.order = null;
    for (const g of ms.groups) g.moved = false;
    for (const e of ms.enemy) e.moved = false;
    ms.groups = ms.groups.filter(g => g.unitIds.length);
    if (ms.ended) {
        ms.phase = 'ended';
        return { ended: ms.ended, income: inc.total };
    }
    endMonth(c, env);
    return { ended: null, income: inc.total };
}
export function setMapWinner(c: Campaign, env: RunnerEnv, winner: MapSide): void {
    const { ms } = mapCtx(c, env);
    if (ms.ended) ms.ended.winner = winner;
}
