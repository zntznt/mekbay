// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { RuleError, type Campaign, type CampaignPilot, type FixedPilot } from './campaign.model';
import { asSkillFrom, handicap } from './engine';
import { uid } from './publication.model';
import { LADDER, rulesFor, type LadderColumn } from './rules';

export const COL_LABEL: Readonly<Record<LadderColumn, string>> = {
    gunnery: 'Gunnery', piloting: 'Piloting', asSkill: 'Skill (AS)', edge: 'Edge tokens', edgeAbilities: 'Edge Abilities',
};
/** Named pilots in a command, and per track. */
export const MAX_NAMED = 4;

/** Battle armor named pilots: improvement costs halved (round down), half SP earned. */
export const isBAPilot = (pl: { unitType?: string } | null | undefined): boolean => pl?.unitType === 'Battle Armor';

export function ladderSp(col: LadderColumn, half = false): number[] {
    return LADDER[col].sp.map(x => (half ? Math.floor(x / 2) : x));
}
export function ladderIndex(col: LadderColumn, invested: number, half = false): number {
    const sp = ladderSp(col, half);
    let i = 0;
    while (i + 1 < sp.length && invested >= sp[i + 1]) i++;
    return i;
}
export function nextThreshold(col: LadderColumn, invested: number, half = false): number | null {
    const sp = ladderSp(col, half);
    const i = ladderIndex(col, invested, half);
    return i + 1 < sp.length ? sp[i + 1] : null;
}

export interface PilotStats {
    g: number;
    p: number;
    skill: number;
    edge: number;
    ea: number;
    handicap: number;
}
const isFixed = (pl: CampaignPilot | FixedPilot): pl is FixedPilot => 'fixed' in pl && pl.fixed === true;

/** Effective stats of a pilot in a track of `system`; `home` is the campaign's system. */
export function pilotStats(pl: CampaignPilot | FixedPilot, system: GameSystem = GameSystem.CLASSIC, home: GameSystem = system): PilotStats {
    if (isFixed(pl)) {
        const g = pl.g ?? 4;
        const p = pl.p ?? 5;
        const skill = pl.skill ?? asSkillFrom(g, p);
        const edge = pl.edge ?? 0;
        const ea = pl.edgeAbilities ?? 0;
        const h = pl.named === false ? 0 : handicap({ gunnery: g, piloting: p, asSkill: skill, edge: edge || 1, edgeAbilities: ea }, system);
        return { g, p, skill, edge, ea, handicap: h };
    }
    const half = isBAPilot(pl);
    const lv = (col: LadderColumn) => LADDER[col].levels[ladderIndex(col, pl.cols[col] || 0, half)];
    const s = rulesFor(system).convertSkills({ gunnery: lv('gunnery'), piloting: lv('piloting'), skill: lv('asSkill') }, home);
    const edge = lv('edge');
    const ea = lv('edgeAbilities');
    const h = handicap({ gunnery: s.gunnery, piloting: s.piloting, asSkill: s.skill, edge, edgeAbilities: ea }, system);
    return { g: s.gunnery, p: s.piloting, skill: s.skill, edge, ea, handicap: h };
}

export function newPilot(name: string, sp = 0): CampaignPilot {
    return {
        id: uid('cp'), name, callsign: '', unitType: 'MechWarrior', status: 'active', wounds: 0, earned: sp, unspent: sp,
        cols: { gunnery: 0, piloting: 0, asSkill: 0, edge: 0, edgeAbilities: 0 }, edgeAbilities: [], scas: [], formation: '',
        tracks: 0, kills: 0, mvp: 0, healMonth: '', healedMonth: 0, healedGap: -1, note: '',
    };
}

/** Allocate unspent SP into a ladder column. */
export function investSp(c: Campaign, pid: string, col: LadderColumn, amount: number): void {
    const pl = c.pilots.find(p => p.id === pid);
    if (!pl) throw new RuleError('Pilot not found.');
    amount = Math.round(amount);
    if (amount <= 0 || amount > pl.unspent) throw new RuleError(`${pl.name} has ${pl.unspent} SP to allocate.`);
    const cap = ladderSp(col, isBAPilot(pl)).at(-1)!;
    if ((pl.cols[col] || 0) + amount > cap) throw new RuleError(`${COL_LABEL[col]} tops out at ${cap} SP.`);
    pl.cols[col] = (pl.cols[col] || 0) + amount;
    pl.unspent -= amount;
}
