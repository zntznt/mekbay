// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type Campaign, type MapSide, type RunnerEnv } from './campaign.model';
import { roll } from './dice';
import { ECON, purchasePrice } from './engine';
import { describeEffect, effectsOf, enemyAt, groupAt, groupChecks, groupMove, hexIncome, hexName, hexType, isNamed, pathLength, resolveLzEffects } from './hex-map';
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
    if (ms.phase !== 'landing') throw new RuleError('Already landed.');
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
    if (!hexType(map, hex).lz) throw new RuleError('That hex is not a landing zone.');
    if (ms.lzHex && ms.lzGroup && (map.hexes[hex]?.end || '') === ms.lzGroup) throw new RuleError('The opponent lands on the other end of the map.');
    ms.enemyLz = hex;
    ms.owner[hex] = 'them';
}
export function addGroup(c: Campaign, env: RunnerEnv, name: string, unitIds: string[], bsp = 0) {
    const { ms } = mapCtx(c, env);
    const g = { id: uid('fg'), name: name || `Formation ${ms.groups.length + 1}`, hex: ms.lzHex, unitIds: [...unitIds], bsp, moved: false };
    ms.groups.push(g);
    return g;
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
}
export function moveGroup(c: Campaign, env: RunnerEnv, gid: string, to: string) {
    const { ms, map, R } = mapCtx(c, env);
    if (ms.phase !== 'turns') throw new RuleError('Map turns have not started.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    const g = ms.groups.find(x => x.id === gid);
    if (!g || !g.unitIds.length) throw new RuleError('No such formation.');
    if (g.moved) throw new RuleError(`${g.name} has already moved this turn.`);
    const t = hexType(map, to);
    if (t.impassable) throw new RuleError(`${t.name} can't be entered.`);
    const mp = groupMove(c, env, g);
    const steps = pathLength(map, g.hex, to, mp, { blocked: h => !!enemyAt(ms, h) });
    if (steps == null) throw new RuleError(`${g.name} moves ${mp} hexes; ${to} is out of reach${ms.enemy.some(e => !e.gone) ? ' (enemy formations and impassable hexes block the way)' : ''}.`);
    const foe = enemyAt(ms, to) || (to === ms.enemyLz ? { id: 'hq' } : null);
    if (foe) return startMapBattle(c, env, { hex: to, from: g.hex, groupId: g.id, enemyId: foe.id, ourRole: 'attacker' });
    const mate = groupAt(ms, to);
    if (mate && mate !== g) {
        if (mate.unitIds.length + g.unitIds.length > R.groupSize) throw new RuleError(`Merging would make ${mate.unitIds.length + g.unitIds.length} units; the maximum is ${R.groupSize}.`);
        mate.unitIds.push(...g.unitIds);
        mate.bsp = (Number(mate.bsp) || 0) + (Number(g.bsp) || 0);
        g.unitIds = [];
        mate.moved = true;
        return { merged: mate.name };
    }
    g.hex = to;
    g.moved = true;
    g.garrison = (t.effects || []).some(e => e.kind === 'garrison');
    if (isNamed(map, to) && !t.noBattle) ms.owner[to] = 'us';
    return { moved: steps };
}
export function stayGroup(c: Campaign, env: RunnerEnv, gid: string): void {
    const { ms } = mapCtx(c, env);
    const g = ms.groups.find(x => x.id === gid);
    if (g) g.moved = true;
}
/** Opponent formations are markers moved by the player (or a GM, or an opponent module). */
export function addEnemy(c: Campaign, env: RunnerEnv, name: string, hex = ''): void {
    const { ms } = mapCtx(c, env);
    ms.enemy.push({ id: uid('en'), name: name || `Enemy ${ms.enemy.length + 1}`, hex: hex || ms.enemyLz, moved: false, note: '' });
}
export function moveEnemy(c: Campaign, env: RunnerEnv, eid: string, to: string) {
    const { ms, map } = mapCtx(c, env);
    const e = ms.enemy.find(x => x.id === eid);
    if (!e) throw new RuleError('No such enemy formation.');
    if (c.draft) throw new RuleError('Finish the battle in progress first.');
    if (hexType(map, to).impassable) throw new RuleError("That hex can't be entered.");
    const mine = groupAt(ms, to) || (to === ms.lzHex ? { id: '' } : null);
    if (mine) return startMapBattle(c, env, { hex: to, from: e.hex, groupId: mine.id, enemyId: e.id, ourRole: 'defender' });
    e.hex = to;
    e.moved = true;
    if (isNamed(map, to) && !hexType(map, to).noBattle) ms.owner[to] = 'them';
    return null;
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
