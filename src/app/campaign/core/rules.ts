// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { isMek, type CampaignUnitData } from './units';

/*
 * Ruleset seam. Everything that differs between Classic BattleTech and Alpha
 * Strike in the campaign math lives in one `SystemRules` object per system,
 * looked up with `rulesFor(system)`. The runner never branches on the system
 * itself; it asks the rules object.
 */

// ---------- skill ladders (shared table; each system reads its own columns) ----------

export type LadderColumn = 'gunnery' | 'piloting' | 'asSkill' | 'edge' | 'edgeAbilities';
export const LADDER_COLUMNS: readonly LadderColumn[] = ['gunnery', 'piloting', 'asSkill', 'edge', 'edgeAbilities'];

export interface Ladder {
    /** Skill value at each rung. */
    readonly levels: readonly number[];
    /** Cumulative SP invested to reach each rung. */
    readonly sp: readonly number[];
    /** Handicap points at each rung. */
    readonly h: readonly number[];
}

export const LADDER: Readonly<Record<LadderColumn, Ladder>> = {
    gunnery: { levels: [4, 3, 2, 1, 0], sp: [0, 300, 700, 1200, 2200], h: [0, 12, 28, 48, 88] },
    piloting: { levels: [5, 4, 3, 2, 1], sp: [0, 100, 200, 700, 1200], h: [0, 4, 8, 28, 48] },
    asSkill: { levels: [4, 3, 2, 1, 0], sp: [0, 400, 900, 1900, 3400], h: [0, 16, 36, 76, 136] },
    edge: { levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], sp: [0, 60, 120, 200, 300, 420, 560, 720, 900, 1100], h: [0, 2, 5, 8, 12, 17, 22, 29, 36, 44] },
    edgeAbilities: { levels: [0, 1, 2, 3, 4, 5], sp: [0, 60, 180, 360, 600, 900], h: [0, 2, 8, 14, 24, 36] },
};

/** Handicap of a value on a ladder; values off the table clamp to the nearest end. */
export function ladderHandicap(lad: Ladder, value: number | undefined): number {
    if (value === undefined) return 0;
    const i = lad.levels.indexOf(value);
    if (i >= 0) return lad.h[i];
    const descending = lad.levels[0] > lad.levels[1];
    const belowFirst = descending ? value > lad.levels[0] : value < lad.levels[0];
    return belowFirst ? 0 : lad.h[lad.h.length - 1];
}

export interface PilotSkills {
    gunnery: number;
    piloting: number;
    /** Alpha Strike Skill. */
    skill: number;
}

/** Repairable damage levels, in order of severity. */
export type RepairLevel = 'armor' | 'structure' | 'crippled' | 'destroyed';

/** Tonnage multiplier per repair level (only the highest level is paid). */
export const REPAIR_TONNAGE_MULT: Readonly<Record<RepairLevel, number>> = { armor: 0.5, structure: 2, crippled: 3, destroyed: 5 };
/** Alpha Strike optional Size-based repairs: Size × value. */
export const AS_SIZE_REPAIR: Readonly<Record<RepairLevel, number>> = { armor: 20, structure: 40, crippled: 60, destroyed: 100 };

export interface RepairOptions {
    /** Alpha Strike optional Size-based repair table. Ignored by Classic. */
    sizeRepairs: boolean;
}

export interface RepairBase {
    cost: number;
    note: string;
}

export interface RearmInput {
    /** Units fielded that may need rearming. */
    units: readonly CampaignUnitData[];
    ammoTons: number;
    advancedAmmoTons: number;
    alternateMunitions: number;
}

export type RearmField = 'ammoTons' | 'advTons' | 'altMunitions';

export interface MoveThresholds {
    lightTons?: number;
    lightSz?: number;
}

export interface SystemRules {
    readonly system: GameSystem;
    /** Unit value basis: Battle Value or Point Value. */
    readonly valueLabel: 'BV' | 'PV';
    /** Ladder columns a pilot invests SP in under this system. */
    readonly ladderColumns: readonly LadderColumn[];
    unitValue(u: CampaignUnitData | undefined): number;
    purchasePrice(u: CampaignUnitData | undefined): number;
    sellingPrice(u: CampaignUnitData | undefined): number;

    readonly limits: {
        trackValuePerScale: number;
        mechCommanderTrackValuePerScale: number;
        /** Temp hires need the rest of the force under this × Scale. */
        tempHireUnderPerScale: number;
        /** Validation: a temp hire that leaves less room than this is flagged. */
        tempHireMinRoom: number;
        veteranStartValue: number;
        maxStartingMechs: number;
    };
    readonly bsp: {
        perScale: number;
        /** Cap on BSP converted from unused value, per Scale (R-6). */
        convertCapPerScale: number;
        /** Unused value per converted BSP. */
        valuePerPoint: number;
    };
    readonly healing: {
        boxesPerMonth: number;
        /** Wound boxes one injury represents (a heal covers a whole injury). */
        boxesPerInjury: number;
        /** Boxes healable between two tracks of the same month; null = no extra limit. */
        boxesBetweenTracks: number | null;
    };

    /** Handicap points from the skill part of a pilot (Edge is shared and added by the engine). */
    skillHandicap(s: PilotSkills): number;
    /** Skills of a pilot whose ladder lives in `home`, as fielded under this system. */
    convertSkills(s: PilotSkills, home: GameSystem): PilotSkills;
    skillLabel(s: PilotSkills): string;

    baseRepairCost(u: CampaignUnitData, level: RepairLevel, opts: RepairOptions): RepairBase;
    reconfigureCost(u: CampaignUnitData, opts: RepairOptions): number;
    rearmCost(input: RearmInput): number;
    /** Track-result inputs the rearm cost reads under this system. */
    readonly rearmFields: readonly RearmField[];
    /** Whether a unit moves at the slow (heavy) campaign-map rate. */
    isHeavyMover(u: CampaignUnitData, t: MoveThresholds): boolean;

    /** Salvage check target number for a destroyed unit; null = not salvageable. Absent = no check in this system. */
    readonly destroyedSalvageTarget: ((u: CampaignUnitData) => number | null) | null;
    /** Whether the crew of a destroyed unit rolls a survival check. */
    readonly crewCheckOnDestroyed: boolean;
    /** Play-area width (inches) by Scale; null when the system uses mapsheets. */
    readonly playWidth: ((scale: number) => number) | null;
}

const asSalvageTarget = (u: CampaignUnitData): number | null => {
    if (u.type === 'Infantry') return null;
    if (u.type === 'Mek' && !/Industrial/i.test(u.subtype || '')) return 4;
    if (/DropShip|Support|ProtoMek/i.test(`${u.subtype} ${u.type}`)) return 8;
    return 6;
};

const tonnageRepair = (u: CampaignUnitData, level: RepairLevel): RepairBase => {
    const tons = u.tons || 0;
    const m = REPAIR_TONNAGE_MULT[level];
    return { cost: tons * m, note: `${tons} t × ${m}` };
};

export const CLASSIC_RULES: SystemRules = {
    system: GameSystem.CLASSIC,
    valueLabel: 'BV',
    ladderColumns: ['gunnery', 'piloting', 'edge', 'edgeAbilities'],
    unitValue: u => (u ? u.bv : 0),
    purchasePrice: u => (u ? u.bv : 0),
    sellingPrice: u => (u ? Math.floor(u.bv / 2) : 0),
    limits: {
        trackValuePerScale: 3000,
        mechCommanderTrackValuePerScale: 3500,
        tempHireUnderPerScale: 2000,
        tempHireMinRoom: 500,
        veteranStartValue: 12000,
        maxStartingMechs: 2,
    },
    bsp: { perScale: 32, convertCapPerScale: 32, valuePerPoint: 20 },
    healing: { boxesPerMonth: 2, boxesPerInjury: 1, boxesBetweenTracks: 1 },
    skillHandicap: s => ladderHandicap(LADDER.gunnery, s.gunnery) + ladderHandicap(LADDER.piloting, s.piloting),
    convertSkills: (s, home) => (home === GameSystem.ALPHA_STRIKE ? { gunnery: s.skill, piloting: s.skill + 1, skill: s.skill } : s),
    skillLabel: s => `${s.gunnery}/${s.piloting}`,
    baseRepairCost: (u, level) => tonnageRepair(u, level),
    reconfigureCost: u => Math.ceil(u.tons / 2),
    rearmCost: r => (r.ammoTons || 0) * 10 + (r.advancedAmmoTons || 0) * 100,
    rearmFields: ['ammoTons', 'advTons'],
    isHeavyMover: (u, t) => (u.tons || 0) > (t.lightTons ?? 55),
    destroyedSalvageTarget: null,
    crewCheckOnDestroyed: false,
    playWidth: null,
};

export const ALPHA_STRIKE_RULES: SystemRules = {
    system: GameSystem.ALPHA_STRIKE,
    valueLabel: 'PV',
    ladderColumns: ['asSkill', 'edge', 'edgeAbilities'],
    unitValue: u => (u ? u.as.PV : 0),
    purchasePrice: u => (u ? u.as.PV * 40 : 0),
    sellingPrice: u => (u ? u.as.PV * 20 : 0),
    limits: {
        trackValuePerScale: 100,
        mechCommanderTrackValuePerScale: 110,
        tempHireUnderPerScale: 80,
        tempHireMinRoom: 10,
        veteranStartValue: 400,
        maxStartingMechs: 3,
    },
    bsp: { perScale: 5, convertCapPerScale: 5, valuePerPoint: 3 },
    healing: { boxesPerMonth: 3, boxesPerInjury: 3, boxesBetweenTracks: null },
    skillHandicap: s => ladderHandicap(LADDER.asSkill, s.skill),
    convertSkills: (s, home) => (home === GameSystem.CLASSIC ? { ...s, skill: Math.floor((s.gunnery + s.piloting) / 2) } : s),
    skillLabel: s => `Skill ${s.skill}`,
    baseRepairCost: (u, level, opts) => {
        if (!opts.sizeRepairs) return tonnageRepair(u, level);
        const sz = u.as.SZ || 1;
        return { cost: sz * AS_SIZE_REPAIR[level], note: `Size ${sz} × ${AS_SIZE_REPAIR[level]}` };
    },
    reconfigureCost: (u, opts) => (opts.sizeRepairs ? (u.as.SZ || 1) * 10 : Math.ceil(u.tons / 2)),
    rearmCost: r => (r.units.filter(u => !u.as.specials.includes('ENE')).length + (r.alternateMunitions || 0)) * 20,
    rearmFields: ['altMunitions'],
    isHeavyMover: (u, t) => (u.as.SZ || 0) > (t.lightSz ?? 2),
    destroyedSalvageTarget: asSalvageTarget,
    crewCheckOnDestroyed: true,
    playWidth: s => (s <= 1 ? 36 : s <= 3 ? 48 : 60),
};

export const RULES: Readonly<Record<GameSystem, SystemRules>> = {
    [GameSystem.CLASSIC]: CLASSIC_RULES,
    [GameSystem.ALPHA_STRIKE]: ALPHA_STRIKE_RULES,
};

export function rulesFor(system: GameSystem): SystemRules {
    return RULES[system];
}

export function isMovementHeavy(units: readonly CampaignUnitData[], rules: SystemRules, t: MoveThresholds): boolean {
    const meks = units.filter(isMek);
    return (meks.length ? meks : units).some(u => rules.isHeavyMover(u, t));
}
