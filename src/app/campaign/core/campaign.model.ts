// SPDX-License-Identifier: GPL-3.0-or-later

import type { GameSystem } from '../../models/common.model';
import type { Rng } from './dice';
import type { CombatTier, Terms } from './engine';
import type { OpponentModule } from './opponent.model';
import type { BetweenBlock, MapEffect, Publication, Side, Table, TableResult } from './publication.model';
import type { LadderColumn } from './rules';
import type { UnitLookup } from './units';

/*
 * Campaign state: a plain JSON object the runner functions mutate in place.
 * Callers that need all-or-nothing actions run them on a copy and keep it
 * only when no RuleError was thrown.
 */

export const CAMPAIGN_SCHEMA = 1;

/** A rules violation; the action should be discarded. */
export class RuleError extends Error {
    override name = 'RuleError';
}

/** Everything the runner reads from outside the campaign object. */
export interface RunnerEnv {
    pub: Publication;
    units: UnitLookup;
    /** Random source; defaults to Math.random. */
    rng?: Rng;
}

export interface RollLogLine {
    depth: number;
    text: string;
    /** MekBay unit names produced by this line, if any. */
    units?: { unit: string }[] | null;
    /** Machine-readable result (amount, step, between) for effects. */
    effect?: TableResult;
}

/** Rolls a publication table (pointer sub-rolls etc.); supplied by the caller. */
export type TableRoller = (table: Table, opts: {
    pub: Publication;
    system: GameSystem;
    modifier: number;
    subModifier?: number;
    scale?: number;
    side?: Side;
}) => RollLogLine[];

// ---------- units ----------

export type DamageState = 'ok' | 'armor' | 'structure' | 'crippled' | 'destroyed' | 'truly' | 'lost';
export const DAMAGE_STATES: readonly DamageState[] = ['ok', 'armor', 'structure', 'crippled', 'destroyed', 'truly', 'lost'];
export const DAMAGE_LABEL: Readonly<Record<DamageState, string>> = {
    ok: 'Operational', armor: 'Armor damage', structure: 'Structure / critical', crippled: 'Crippled',
    destroyed: 'Destroyed (repairable)', truly: 'Truly destroyed', lost: 'Lost to enemy salvage',
};
export const isGone = (s: DamageState): boolean => s === 'truly' || s === 'lost';

export type CrewKind = 'regular' | 'green' | 'fixed' | 'none';
export interface Crew {
    kind: CrewKind;
    wounds: number;
    g?: number;
    p?: number;
    skill?: number;
    name?: string;
    dead?: boolean;
}

export interface TempHireState {
    hireId: string;
    name: string;
    g: number;
    p: number;
    skill: number;
    edge: number;
    edgeAbilities: number;
    feePerTrack: number;
    feePerKill: number;
    perSuccess: number;
    wounds: number;
    tracks: number;
    successes: number;
}

export type UnitSource = 'start' | 'purchase' | 'contract' | 'sponsor' | 'scrapyard' | 'salvage' | 'toftt' | 'hire';

export interface CampaignUnit {
    id: string;
    /** MekBay unit name. */
    unit: string;
    state: DamageState;
    pilotId: string;
    crew: Crew;
    acquired: string;
    source?: UnitSource;
    /** Display name override (temp hires). */
    name?: string;
    /** Granted-force id for units lent by the employer. */
    granted?: string;
    grantedName?: string;
    fromMonth?: number;
    persistent?: boolean;
    tempHire?: TempHireState;
    leftBehind?: boolean;
    /** Map turn it arrives at the landing zone. */
    arrives?: number;
    delivery?: { due?: string; collect?: boolean; paid: number };
    scrapCheck?: { due: string };
    repaired?: { date: string; after: number; exempt: boolean };
    damagedInContract?: boolean;
    lostTo?: string | null;
    lostState?: DamageState;
    omni?: boolean;
}

// ---------- pilots ----------

export interface CampaignPilot {
    id: string;
    name: string;
    callsign: string;
    unitType: string;
    status: 'active' | 'dead';
    wounds: number;
    earned: number;
    unspent: number;
    /** SP invested per ladder column. */
    cols: Record<LadderColumn, number>;
    edgeAbilities: string[];
    scas: string[];
    formation: string;
    tracks: number;
    kills: number;
    mvp: number;
    healMonth: string;
    healedMonth: number;
    healedGap: number;
    note: string;
}

/** Skills as given (temp hires, regular and fixed crews). */
export interface FixedPilot {
    fixed: true;
    named?: boolean;
    id?: string;
    name?: string;
    g?: number;
    p?: number;
    skill?: number;
    edge?: number;
    edgeAbilities?: number;
    wounds?: number;
}

// ---------- ledger ----------

export type LedgerKind =
    | 'start' | 'transport' | 'month' | 'combat' | 'hire' | 'loss' | 'salvage' | 'rearm' | 'repair' | 'heal'
    | 'training' | 'purchase' | 'sale' | 'support' | 'rep' | 'debt' | 'note' | 'other';

export interface LedgerEntry {
    id: string;
    date: string;
    cmonth: number | null;
    contract: string;
    event: string;
    cost: number;
    cover: number;
    net: number;
    toDebt: number;
    warchest: number;
    debt: number;
    rep: number;
    kind: LedgerKind;
    note: string;
}

// ---------- contract ----------

export type Winner = Side | 'none';

export interface RandomPick {
    trackId: string;
    attacker: Side;
    label?: string;
    log: string;
}
export interface SalvageItem {
    id: string;
    unit: string;
    state: DamageState;
    price: number;
    track: string;
}
export type RepairTimeKind = 'none' | 'hasty' | 'standard' | 'extended' | 'all';
/** Effects in force from the end of one track until the next track is applied. */
export interface BetweenState {
    /** `trackIds.length` when set; stale once another track is applied. */
    track: number;
    block: BetweenBlock[];
    costPct: number;
    supportShift: number;
    labels: string[];
}
export interface PurchaseState {
    roll: number;
    count: number;
    logs: RollLogLine[][];
}

export interface ActiveContract {
    id: string;
    contractId: string;
    briefId: string;
    name: string;
    number: string;
    employer: string;
    side: Side;
    terms: Terms;
    offered: Terms;
    scale: number;
    length: number;
    month: number;
    startDate: string;
    endDate?: string;
    /** Winner per script key / node id. */
    results: Record<string, Winner>;
    rolls: Record<string, RandomPick[]>;
    choices: Record<string, number>;
    loops: Record<string, { n: number; stopped: boolean }>;
    tracksThisMonth: number;
    trackIds: string[];
    buildings: number;
    exchangeCredit: number;
    salvagePool: SalvageItem[];
    variantId: string;
    piracy: boolean;
    jumps: number | null;
    status: 'active' | 'ended';
    toftt: boolean;
    broken?: boolean;
    map?: MapState;
    supportOverride?: number | null;
    deferredSupport?: number;
    /** `roll` 0 = fixed by the contract or the script. */
    repairTime?: { roll: number; kind: RepairTimeKind; date: string; after: number };
    between?: BetweenState;
    skipTaken?: boolean;
    tofttPlayed?: string[];
    purchaseCfg?: { freq: 'month' | 'track' };
    purchase?: Record<string, PurchaseState>;
}

// ---------- tracks ----------

export interface MapBattle {
    hex: string;
    from?: string;
    groupId: string;
    enemyId: string;
    ourRole: 'attacker' | 'defender';
    hq?: boolean;
    final?: boolean;
    helpers?: string[];
    helperMode?: 'recall' | 'garrison';
    joined?: string[];
}

export interface Payout {
    name: string;
    sp: number;
    done: boolean;
}

export interface TrackDraft {
    id: string;
    itemKey: string;
    nodeId: string;
    ancestors: string[];
    trackId: string;
    name: string;
    attacker: Side;
    system: GameSystem;
    scale: number;
    unitIds: string[];
    /** Named pilot per campaign unit for this track (overrides the unit's own). */
    pilotFor: Record<string, string>;
    hireIds: string[];
    grantedIds: string[];
    oppHandicap: number;
    sca: string;
    complications: RollLogLine[];
    notes: string;
    skip: boolean;
    toftt?: boolean;
    /** Map battles: the formation's BSP allocation replaces the Scale grant. */
    bspBase?: number | null;
    mapBattle?: MapBattle;
    payouts?: Payout[];
}

export interface UnitOutcome {
    state?: DamageState;
    kills?: number;
    crewKilled?: boolean;
    crewWounds?: number;
    hireWounds?: number;
    noRearm?: boolean;
}
export interface PilotOutcome {
    wounds?: number;
    killed?: boolean;
    kills?: number;
    /** Alpha Strike: one injury. */
    injured?: boolean;
}

/** What the player reports after a track. */
export interface TrackResult {
    winner: Winner | '';
    tier: CombatTier;
    objectivesDone?: number;
    objectivesTotal?: number;
    vpUs?: number;
    vpThem?: number;
    units?: Record<string, UnitOutcome>;
    pilots?: Record<string, PilotOutcome>;
    mvp?: string;
    /** SP of combat pay designated for named pilots. */
    designated?: number;
    salvage?: { unit: string; qty?: number; state?: DamageState }[];
    buildings?: number;
    ammoTons?: number;
    advTons?: number;
    altMunitions?: number;
    payouts?: Payout[];
    tofttPick?: string;
    tofttUnits?: string[];
}

export interface BspBudget {
    base: number;
    conv: number;
    ourExtra: number;
    oppExtra: number;
    bonus: number;
    bonusLines: MapEffect[];
    total: number;
    ourH: number;
    oppH: number;
    opforSkill: { gunnery: number; piloting: number } | null;
}

export interface TrackRecord {
    id: string;
    contract: string;
    contractRef: string;
    date: string;
    month: number;
    key: string;
    name: string;
    system: GameSystem;
    scale: number;
    attacker: Side;
    side: Side;
    winner: Winner | '';
    tier: CombatTier;
    combatPay: number;
    designated: number;
    per: number;
    mvp: string;
    objectives: string;
    vp: string;
    force: { cuId: string; unit: string; pilot: string; state: DamageState }[];
    bsp: BspBudget;
    complications: RollLogLine[];
    salvage: string[];
    salvValue: number;
    notes: string;
    skip: boolean;
    toftt: boolean;
    repairTime?: string;
}

// ---------- campaign maps ----------

export type MapSide = 'us' | 'them';
export interface MapGroup {
    id: string;
    name: string;
    hex: string;
    unitIds: string[];
    bsp: number;
    moved: boolean;
    garrison?: boolean;
}
export interface EnemyMarker {
    id: string;
    name: string;
    hex: string;
    moved: boolean;
    note: string;
    gone?: boolean;
}
export interface MapState {
    mapId: string;
    phase: 'landing' | 'turns' | 'ended';
    owner: Record<string, MapSide>;
    groups: MapGroup[];
    enemy: EnemyMarker[];
    lzHex: string;
    lzGroup: string;
    enemyLz: string;
    lzEffects: MapEffect[];
    reinforcements: number;
    hold: Record<MapSide, number>;
    battles: number;
    battle: MapBattle | null;
    fought: Record<string, number>;
    ended: { by: 'hq' | 'hold' | 'sp' | 'turns'; winner: MapSide | ''; text: string } | null;
    finalDone: boolean;
    notes: string[];
}

// ---------- campaign ----------

export interface CompanyOptions {
    battleArmor: boolean;
    tanker: boolean;
    mechCommander: boolean;
    veteranCommand: boolean;
    /** Optional Repair Time Table. */
    repairTimeTable?: boolean;
    /** Alpha Strike optional Size-based repairs. */
    asSizeRepairs?: boolean;
}

export type OrgType = 'is' | 'clan' | 'comstar';

export interface Formation {
    id: string;
    name: string;
    type: string;
    commanderId: string;
    unitIds: string[];
}
export interface TofttOption {
    id: string;
    /** MekBay unit name. */
    unit: string;
    half: boolean;
    from: string;
    /** Contract id, or 'next' once carried over. */
    contractRef: string;
    betweenContracts: boolean;
}
export interface ContractHistory {
    id: string;
    name: string;
    number: string;
    employer: string;
    start: string;
    end: string;
    terms: Terms;
    scale: number;
    won: boolean;
    broken: boolean;
    tracks: string[];
    rep: number;
}
export type ScrapCondition = 'impossible' | 'destroyed' | 'crippled';
export interface ScrapyardOffer {
    date: string;
    unit: string;
    cond: ScrapCondition;
    condRoll: number;
    price: number;
    log: RollLogLine[];
    bought: boolean;
}

export interface Campaign {
    schema: number;
    id: string;
    name: string;
    pubId: string;
    pubTitle: string;
    /** The system the force is tracked in (value basis, repairs, healing …). */
    system: GameSystem;
    date: string;
    /** Period whose maintenance is already posted. */
    maintPaid: string;
    scale: number;
    reputation: number;
    warchest: number;
    debt: number;
    debtMonths: number;
    skipUsed: boolean;
    skipPenalty: boolean;
    options: CompanyOptions;
    backgroundId: string;
    factionId: string;
    regular: { factionId: string; parentId: string; rank: number } | null;
    tofttOptions: TofttOption[];
    factionRolls: Record<string, RollLogLine[]>;
    hallId: string;
    hallStandard?: number;
    hallReduced?: number;
    sponsorId: string;
    sponsorBanned: string[];
    modifiers: { mechBay: boolean };
    setup: boolean;
    orgType: OrgType;
    formations: Formation[];
    units: CampaignUnit[];
    pilots: CampaignPilot[];
    ledger: LedgerEntry[];
    contract: ActiveContract | null;
    history: ContractHistory[];
    tracks: TrackRecord[];
    draft: TrackDraft | null;
    trainedMonth?: string;
    scrapyard?: ScrapyardOffer;
    /** Attached opponent module (e.g. ACES), with its own system. */
    opponent: OpponentModule | null;
    notes: string;
}
