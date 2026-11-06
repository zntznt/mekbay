// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import type { RepairTimeKind } from './campaign.model';
import type { CombatTier, SupportRating, TermKey, TermLocks, Terms, VariantOptions } from './engine';
import type { RowRange } from './dice';

/*
 * Publication: the authored content a campaign plays through (contracts,
 * mission-brief scripts, tracks, tables, maps …). Flat collections, references
 * by id. Units are referenced by MekBay unit name.
 */

export const PUBLICATION_SCHEMA = 1;

export function uid(prefix = 'x'): string {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

export type Side = 'A' | 'B';

/** A plain value, or one value per game system. */
export type SplitValue<T> = T | ({ split: true } & Partial<Record<GameSystem, T>>);

export function isSplit<T>(v: SplitValue<T> | null | undefined): v is { split: true } & Partial<Record<GameSystem, T>> {
    return !!v && typeof v === 'object' && (v as { split?: unknown }).split === true;
}
/** Value for a system; a split value falls back to the other system's entry when its own is empty. */
export function vget<T>(v: SplitValue<T> | null | undefined, system: GameSystem): T | undefined {
    if (v == null) return undefined;
    if (!isSplit(v)) return v;
    const own = v[system];
    const other = v[system === GameSystem.CLASSIC ? GameSystem.ALPHA_STRIKE : GameSystem.CLASSIC];
    return own !== '' && own != null ? own : other;
}

// ---------- unit references ----------

export interface UnitRef {
    /** MekBay unit name. */
    unit: string;
    qty?: number;
    perScale?: boolean;
    g?: number;
    p?: number;
    skill?: number;
}

// ---------- tables ----------

/** SP activities a between-tracks effect can block until the next track. */
export type BetweenBlock = 'repair' | 'rearm' | 'heal';
export const BETWEEN_BLOCKS: readonly BetweenBlock[] = ['repair', 'rearm', 'heal'];

export type DupPolicy = 'apply' | 'ignore' | 'reroll' | 'rerollSome' | 'rerollUntil' | 'none';

export type TableResult =
    | { kind: 'text'; text: SplitValue<string> }
    | { kind: 'units'; units: UnitRef[] }
    | { kind: 'pointer'; tableId: string; count: number; column: string }
    | { kind: 'rollAgain'; times: number; dup: DupPolicy; note: string }
    | { kind: 'nested'; die: string; rows: NestedRow[] }
    | { kind: 'bySide'; a: string; b: string; ra: TableResult; rb: TableResult }
    | { kind: 'amount'; currency: 'SP' | 'BSP' | 'VP'; value: number; perScale: boolean; note: string }
    | { kind: 'step'; term: TermKey; mode: 'shift' | 'set'; value: number }
    | { kind: 'track'; trackId: string; attacker: Side }
    | { kind: 'asset'; assetId: string; qty: number; perScale: boolean; veteran: boolean }
    | { kind: 'statBlock'; statBlockId: string; qty: number; perScale: boolean }
    | { kind: 'count'; die: string; thresholds: { min: number; count: number }[]; tableId: string; note: string }
    | { kind: 'pilot'; pilotId: string; note: string }
    | { kind: 'upgrade'; upgradeId: string; note: string }
    /** Between this track and the next: blocked SP activities and a cost change in percent. */
    | { kind: 'between'; block: BetweenBlock[]; costPct: number; note: string }
    | { kind: 'none' };
export type ResultKind = TableResult['kind'];

export interface NestedRow extends RowRange {
    tag?: string;
    result: TableResult;
}
export interface TableRow extends RowRange {
    id?: string;
    tag?: string;
    cells: Record<string, TableResult>;
    unique?: boolean;
    fallback?: TableResult;
}
export interface Table {
    id: string;
    name: string;
    purpose: string;
    scale: number;
    die: string;
    mods: { value: number; label?: string }[];
    columns: { key: string; label: string }[];
    columnMode: string;
    rows: TableRow[];
    footnotes: string;
    system: GameSystem | 'both';
}

// ---------- tracks ----------

export interface Track {
    id: string;
    name: string;
    generalRef: string;
    mods: { op: string }[];
    objectives: { id: string; name: string; requires?: string[] }[];
    salvage: 'winner' | 'none' | string;
    end: Record<GameSystem, number> & { text: string };
    specialRules: Record<string, boolean>;
    overrides: { ignoreScale: boolean; noBsp: boolean; costScale: string };
}

// ---------- briefs ----------

export type BriefNode =
    /** `repairTime`: fixed repair time after this track (before the next one), overriding the contract's. */
    | { id: string; kind: 'track'; trackId: string; attacker: Side; label: string; optional: boolean; repairTime?: RepairTimeKind | '' }
    | { id: string; kind: 'branch'; of: string; cases: { when: string; nodes: BriefNode[] }[] }
    | { id: string; kind: 'lookup'; keys: [string, string]; cases: { match: string[]; nodes: BriefNode[] }[] }
    | { id: string; kind: 'random'; tableId: string; rolls: number; dup: DupPolicy; note: string }
    | { id: string; kind: 'choice'; side: Side; options: { label: string; nodes: BriefNode[] }[] }
    | { id: string; kind: 'loop'; max: number; until: string; nodes: BriefNode[] }
    | { id: string; kind: 'end'; scope: string; text: string }
    | { id: string; kind: 'note'; text: string };
export type NodeKind = BriefNode['kind'];

export type VictoryCondition =
    | { kind: 'survive'; forceId: string; min: number }
    | { kind: 'winAll'; nodes: string[] }
    | { kind: 'winCount'; n: number; nodes: string[] }
    | { kind: 'finalTrack' }
    | { kind: 'otherFails' }
    | { kind: 'destroy'; n: number; what: string }
    | { kind: 'text'; text: string };

export interface GrantedForce {
    id: string;
    name: string;
    side: Side;
    units: UnitRef[];
    fromMonth?: number;
    persistent?: boolean;
}
export interface BriefSide {
    key: Side;
    label: string;
    contractId: string;
    allowed: string;
}
export interface Brief {
    id: string;
    name: string;
    number: string;
    contractIds: string[];
    intensity: { min: number; max: number };
    sides: BriefSide[];
    months: { id: string; note: string; nodes: BriefNode[] }[];
    complications: { tableId: string; rollers: string; mode: string; mods: Record<string, number>; exclude: string };
    mapsheets: Record<GameSystem, string>;
    rulesOff: string[];
    victory: string;
    special: string[];
    forces: GrantedForce[];
    victoryConds: Record<Side, VictoryCondition[]> & { noVictor: boolean };
}

// ---------- contracts ----------

export interface ContractTempHire {
    id: string;
    name: string;
    /** MekBay unit name. */
    unit: string;
    g?: number;
    p?: number;
    skill?: number;
    edge?: number;
    /** Comma-separated Edge Ability names. */
    edgeAbilities?: string;
    feePerTrack?: number;
    feePerKill?: number;
    eligibility?: string;
    text?: string;
}
export interface Contract {
    id: string;
    name: string;
    number: string;
    employer: string;
    location: { planet: string; faction: string; sub: string; disputedBy: string; random: boolean; terrain: string };
    type: string;
    subtype: string;
    length: number;
    terms: Terms;
    locks: TermLocks;
    nonNegotiable: boolean;
    piracy: boolean;
    purchase: { tableId: string; gateDie: string; gate: { min: number; count: number }[]; freq: 'month' | 'track'; note: string };
    tempHires: ContractTempHire[];
    tempHirePilotIds: string[];
    opposedId: string;
    briefId: string;
    variantId: string;
    mapId: string;
    /** Repair time between tracks of the same month: '' = the command's option, 'roll' = Repair Time Table, or a fixed kind. */
    repairTime: ContractRepairTime;
    notes: string;
}
export type ContractRepairTime = '' | 'roll' | RepairTimeKind;

// ---------- people, places, assets ----------

export interface NamedPilot {
    id: string;
    name: string;
    callsign: string;
    role: string;
    unitType: string;
    /** MekBay unit name. */
    unit: string;
    g: number;
    p: number;
    skill: number;
    edge: number;
    edgeAbilityIds: string[];
    /** Comma-separated Special Pilot Abilities. */
    spas: string;
    hire: { kind: string; perTrack: number; perKill: number; perSuccess: number; eligibility: string; feeTableId: string };
}
export interface HotSpot {
    id: string;
    name: string;
    contractIds: string[];
    briefIds: string[];
    tableIds: string[];
    availability: { from: string; to: string };
    venues: { name: string; mapTableId: string }[];
    hallId: string;
    /** Table rolled once per track while on a contract here (world circumstances); its effects apply like complications. */
    worldTableId: string;
    /** Short label / value pairs shown with the contract (ruler, HPG, presence …). */
    facts: { label: string; value: string }[];
}
export interface Hall {
    id: string;
    name: string;
    systemId: string;
    support: SupportRating;
    reducedMaintenance: boolean;
    generatorId: string;
    systemTableId: string;
    purchaseTableIds: string[];
    tempHireTableId: string;
    boardTableId: string;
    pilotIds: string[];
    upgradeIds: string[];
}
export interface Sponsor {
    id: string;
    name: string;
    scope: string[];
    discountPct: number;
    deliveryInTerritory: number;
    deliveryNear: number;
    nearJumps: number;
    purchaseTableId: string;
}
export interface ParentCommand {
    id: string;
    name: string;
    units: UnitRef[];
    scaIds: string[];
}
export interface Faction {
    id: string;
    name: string;
    contracts: { contractId: string; restriction?: string }[];
    purchaseTableId: string;
    tankerTableId: string;
    baTableId: string;
    parents: ParentCommand[];
    singleParent: boolean;
}
export interface Background {
    id: string;
    name: string;
    units: UnitRef[];
    mechTableId: string;
    tankerTableId: string;
    baTableId: string;
}
export interface Variant {
    id: string;
    name: string;
    preset: string;
    o: VariantOptions;
}
export interface Asset {
    id: string;
    name: string;
    bsp: { reg: number; vet: number };
}
export interface Named {
    id: string;
    name: string;
}
export interface StarSystem {
    id: string;
    name: string;
    x: number | null;
    y: number | null;
    links: { to: string; jumps?: number }[];
}

// ---------- generators ----------

export type GenAssign =
    | '' | 'type' | 'subtype' | 'opposedType' | 'employer' | 'length' | TermKey | 'system' | 'terrain'
    | 'faction' | 'jumps' | 'tracks' | 'intensity' | 'trackTable' | 'note';
export interface TagRule {
    from: string;
    tag: string;
    add: number;
}
export interface GeneratorStep {
    id: string;
    label: string;
    tableId: string;
    tableMode?: 'fixed' | 'byStep';
    tableFrom?: string;
    tableMap?: { tag: string; tableId: string }[];
    noRoll?: boolean;
    dieMods?: TagRule[];
    shifts?: TagRule[];
    columnMode?: 'first' | 'fixed' | 'byStep';
    columnKey?: string;
    columnFrom?: string;
    assign: GenAssign;
    when?: { from: string; tag: string };
}
export interface GeneratorChain {
    id: string;
    name: string;
    purpose: string;
    inputs: { key: string; label: string }[];
    steps: GeneratorStep[];
}

// ---------- campaign maps ----------

export type MapEffectKind =
    | 'incomePct' | 'maintPct' | 'purchase' | 'reinforce' | 'recruit' | 'supportPct'
    | 'bsp' | 'pilotSpMult' | 'heal' | 'cancel' | 'garrison' | 'note';
export interface MapEffect {
    kind: MapEffectKind;
    target?: string;
    pct?: number;
    die?: string;
    mult?: number;
    sign?: number;
    value?: number;
    types?: string[];
    g?: number;
    p?: number;
    skill?: number;
    cost?: number;
    note?: string;
    asNote?: string;
    text?: string;
    /** Set once a landing-zone effect is rolled. */
    roll?: number;
}
export interface HexType {
    id: string;
    name: string;
    color: string;
    income: number;
    trackId: string;
    terrain: Record<GameSystem, string>;
    impassable: boolean;
    noBattle: boolean;
    /** Non-empty marks a landing zone. */
    lz: string;
    hq: boolean;
    strategic: boolean;
    effects: MapEffect[];
    lzEffects: MapEffect[];
}
export interface MapHex {
    t?: string;
    name?: string;
    /** Map end of a landing zone (opposing sides land on different ends). */
    end?: string;
}
export interface MapRules {
    turns: number;
    turnsPerMonth: number;
    maxGroups: number;
    groupSize: number;
    minMechs: number;
    bspPerScale: number;
    lightTons: number;
    lightSz: number;
    lightMove: number;
    heavyMove: number;
    reinforcements: number;
    purchaseNeedsHex: boolean;
    recruitNeedsHex: boolean;
    victory: { turns: boolean; zeroSp: boolean; holdTurns: number; captureHq: boolean };
    final: { enabled: boolean; trackId: string; support: number | null; bsp: number; payouts: { name: string; sp: number }[] };
}
export interface CampaignMap {
    id: string;
    name: string;
    cols: number;
    rows: number;
    image: string;
    hexTypes: HexType[];
    hexes: Record<string, MapHex>;
    rules: MapRules;
}

// ---------- publication ----------

export interface Publication {
    schema: number;
    id: string;
    title: string;
    systems: GameSystem[];
    calendar: { start: string; end: string };
    hotSpots: HotSpot[];
    contracts: Contract[];
    briefs: Brief[];
    tracks: Track[];
    tables: Table[];
    generators: GeneratorChain[];
    maps: CampaignMap[];
    halls: Hall[];
    pilots: NamedPilot[];
    factions: Faction[];
    backgrounds: Background[];
    sponsors: Sponsor[];
    upgrades: Named[];
    assets: Asset[];
    statBlocks: Named[];
    edgeAbilities: Named[];
    scas: Named[];
    variants: Variant[];
    starSystems: StarSystem[];
    dossiers: Named[];
}

export type CollectionKey = Exclude<keyof Publication, 'schema' | 'id' | 'title' | 'systems' | 'calendar'>;
export const COLLECTIONS: readonly CollectionKey[] = [
    'hotSpots', 'contracts', 'briefs', 'tracks', 'tables', 'generators', 'maps', 'halls', 'pilots', 'factions', 'backgrounds',
    'sponsors', 'upgrades', 'assets', 'statBlocks', 'edgeAbilities', 'scas', 'variants', 'starSystems', 'dossiers',
];

export function newPublication(): Publication {
    const pub = {
        schema: PUBLICATION_SCHEMA, id: uid('pub'), title: 'Untitled publication',
        systems: [GameSystem.CLASSIC], calendar: { start: '3151-04', end: '3152-06' },
    } as Publication;
    for (const k of COLLECTIONS) (pub[k] as unknown[]) = [];
    return pub;
}

export function byId<K extends CollectionKey>(pub: Publication, coll: K, id: string | null | undefined): Publication[K][number] | undefined {
    if (!id) return undefined;
    return (pub[coll] as Publication[K][number][]).find(x => x.id === id);
}

// ---------- factories (the shapes the engine itself creates) ----------

export const defaultTerms = (): Terms => ({ basePay: 7, support: 8, transport: 7, salvage: 7, command: 7 });

export function newContract(): Contract {
    return {
        id: uid('ct'), name: 'New contract', number: '', employer: '',
        location: { planet: '', faction: '', sub: '', disputedBy: '', random: false, terrain: '' },
        type: 'Raid', subtype: '', length: 3, terms: defaultTerms(), locks: {}, nonNegotiable: false, piracy: false,
        purchase: { tableId: '', gateDie: '2D6', gate: [{ min: 7, count: 1 }, { min: 11, count: 2 }], freq: 'month', note: '' },
        tempHires: [], tempHirePilotIds: [], opposedId: '', briefId: '', variantId: '', mapId: '', repairTime: '', notes: '',
    };
}
export function newBrief(): Brief {
    return {
        id: uid('mb'), name: 'New mission brief', number: '', contractIds: [], intensity: { min: 1, max: 1 },
        sides: [
            { key: 'A', label: 'Side A', contractId: '', allowed: 'Mercenary or House' },
            { key: 'B', label: 'Side B', contractId: '', allowed: 'Mercenary or House' },
        ],
        months: [{ id: uid('mo'), note: '', nodes: [] }],
        complications: { tableId: '', rollers: 'each', mode: 'add', mods: { integrated: 3, house: 2, liaison: 1, independent: 0 }, exclude: '' },
        mapsheets: { [GameSystem.CLASSIC]: '', [GameSystem.ALPHA_STRIKE]: '' }, rulesOff: [], victory: '', special: [],
        forces: [], victoryConds: { A: [], B: [], noVictor: false },
    };
}
export function newTrack(): Track {
    return {
        id: uid('tr'), name: 'New track', generalRef: '', mods: [], objectives: [], salvage: 'winner',
        end: { [GameSystem.CLASSIC]: 10, [GameSystem.ALPHA_STRIKE]: 8, text: '' },
        specialRules: { commander: true, forcedWithdrawal: true, crippling: true, scanning: false },
        overrides: { ignoreScale: false, noBsp: false, costScale: '' },
    };
}
export function newTable(): Table {
    return {
        id: uid('tb'), name: 'New table', purpose: 'general', scale: 1, die: '1D6', mods: [],
        columns: [{ key: 'r', label: 'Result' }], columnMode: 'all', rows: [], footnotes: '', system: 'both',
    };
}
export function newNode<K extends NodeKind>(kind: K): Extract<BriefNode, { kind: K }>;
export function newNode(kind: NodeKind): BriefNode {
    const id = uid('n');
    switch (kind) {
        case 'branch': return { id, kind, of: '', cases: [{ when: 'A', nodes: [] }, { when: 'B', nodes: [] }] };
        case 'lookup': return { id, kind, keys: ['', ''], cases: [] };
        case 'random': return { id, kind, tableId: '', rolls: 1, dup: 'none', note: '' };
        case 'choice': return { id, kind, side: 'A', options: [{ label: 'Option 1', nodes: [] }] };
        case 'loop': return { id, kind, max: 2, until: '', nodes: [] };
        case 'end': return { id, kind, scope: 'contract', text: '' };
        case 'note': return { id, kind, text: '' };
        case 'track': return { id, kind, trackId: '', attacker: 'A', label: '', optional: false };
    }
}

export const HEX_DEFAULT = 'hx_empty';
export function newHexType(name = 'New hex type', color = '#c9b98a'): HexType {
    return {
        id: uid('hx'), name, color, income: 0, trackId: '', terrain: { [GameSystem.CLASSIC]: '', [GameSystem.ALPHA_STRIKE]: '' },
        impassable: false, noBattle: false, lz: '', hq: false, strategic: false, effects: [], lzEffects: [],
    };
}
export function newCampaignMap(): CampaignMap {
    return {
        id: uid('mp'), name: 'New campaign map', cols: 11, rows: 14, image: '',
        hexTypes: [
            { ...newHexType('Empty', '#c9b98a'), id: HEX_DEFAULT },
            { ...newHexType('Water / off-map', '#7fa9c9'), id: 'hx_water', impassable: true, noBattle: true },
        ],
        hexes: {},
        rules: {
            turns: 10, turnsPerMonth: 2, maxGroups: 4, groupSize: 5, minMechs: 1, bspPerScale: 32, lightTons: 55, lightSz: 2, lightMove: 4, heavyMove: 2,
            reinforcements: 0, purchaseNeedsHex: true, recruitNeedsHex: true,
            victory: { turns: true, zeroSp: true, holdTurns: 2, captureHq: true },
            final: { enabled: true, trackId: '', support: 13, bsp: 96, payouts: [] },
        },
    };
}

/** Variant presets: numbers only. Names are short labels. */
export const VARIANT_PRESETS: Readonly<Record<string, { name: string; o: Partial<VariantOptions> }>> = {
    aces: { name: 'ACES conversion', o: { combatPay: { unsuccessful: 400, success: 750, allObjectives: 1000 } as Partial<Record<CombatTier, number>> } },
    cadre: { name: 'Cadre Duty', o: { combatPayMult: 0.25, noDamagePersists: true } },
    guerrilla: { name: 'Guerrilla Operation', o: { spCostMult: 2, supportAtEnd: true } },
    duel: { name: 'Duel (game world)', o: { vpIsSp: true } },
    bimonthly: { name: 'Pay every two months', o: { basePayEvery: 2 } },
    piracy: { name: 'Piracy economy', o: {} },
};
export const DEFAULT_VARIANT_OPTIONS: VariantOptions = {
    combatPay: null, combatPayMult: 1, spCostMult: 1, supportAtEnd: false, basePayEvery: 1, vpIsSp: false, noDamagePersists: false,
};

// ---------- walkers ----------

export function* walkResults(res: TableResult | undefined): Generator<TableResult> {
    if (!res) return;
    yield res;
    if (res.kind === 'nested') for (const r of res.rows || []) yield* walkResults(r.result);
    if (res.kind === 'bySide') {
        yield* walkResults(res.ra);
        yield* walkResults(res.rb);
    }
}
export function* tableResults(t: Table): Generator<TableResult> {
    for (const row of t.rows || []) {
        for (const c of t.columns) yield* walkResults(row.cells?.[c.key]);
        if (row.fallback) yield* walkResults(row.fallback);
    }
}
export function* walkNodes(nodes: readonly BriefNode[] | undefined): Generator<BriefNode> {
    for (const n of nodes || []) {
        yield n;
        if (n.kind === 'branch' || n.kind === 'lookup') for (const c of n.cases) yield* walkNodes(c.nodes);
        if (n.kind === 'choice') for (const o of n.options) yield* walkNodes(o.nodes);
        if (n.kind === 'loop') yield* walkNodes(n.nodes);
    }
}
export function* briefNodes(b: Brief): Generator<BriefNode> {
    for (const m of b.months || []) yield* walkNodes(m.nodes);
}

/** Track count range [min, max] a node list can produce. */
export function trackRange(nodes: readonly BriefNode[] | undefined): [number, number] {
    let lo = 0;
    let hi = 0;
    for (const n of nodes || []) {
        let a = 0;
        let b = 0;
        if (n.kind === 'track') {
            a = n.optional ? 0 : 1;
            b = 1;
        } else if (n.kind === 'branch' || n.kind === 'lookup' || n.kind === 'choice') {
            const lists = n.kind === 'choice' ? n.options.map(o => o.nodes) : n.cases.map(c => c.nodes);
            if (lists.length) {
                const rs = lists.map(trackRange);
                a = Math.min(...rs.map(r => r[0]));
                b = Math.max(...rs.map(r => r[1]));
            }
        } else if (n.kind === 'random') {
            b = n.rolls || 1;
        } else if (n.kind === 'loop') {
            b = trackRange(n.nodes)[1] * (n.max || 1);
        }
        lo += a;
        hi += b;
    }
    return [lo, hi];
}

const isSystem = (x: unknown): x is GameSystem => x === GameSystem.CLASSIC || x === GameSystem.ALPHA_STRIKE;

/** Fill missing collections and defaults on a loaded publication. */
export function migratePublication(pub: Publication): Publication {
    if (!pub.schema) pub.schema = PUBLICATION_SCHEMA;
    for (const c of COLLECTIONS) if (!Array.isArray(pub[c])) (pub[c] as unknown[]) = [];
    pub.systems = (Array.isArray(pub.systems) ? pub.systems : []).filter(isSystem);
    if (!pub.systems.length) pub.systems = [GameSystem.CLASSIC];
    for (const h of pub.hotSpots) {
        h.venues ??= [];
        h.hallId ??= '';
        h.worldTableId ??= '';
        h.facts = Array.isArray(h.facts) ? h.facts : [];
    }
    for (const c of pub.contracts) {
        c.tempHirePilotIds ??= [];
        c.variantId ??= '';
        c.mapId ??= '';
        c.repairTime ??= '';
    }
    for (const f of pub.factions) for (const pc of f.parents || []) {
        pc.id ||= uid('pc');
        pc.units ||= [];
        pc.scaIds ||= [];
    }
    for (const m of pub.maps) {
        m.hexes ||= {};
        m.hexTypes ||= [];
        for (const t of m.hexTypes) {
            t.effects ||= [];
            t.lzEffects ||= [];
            t.terrain ||= { [GameSystem.CLASSIC]: '', [GameSystem.ALPHA_STRIKE]: '' };
        }
    }
    for (const b of pub.briefs) {
        b.forces ??= [];
        b.victoryConds ??= { A: [], B: [], noVictor: false };
        b.special ??= [];
        b.rulesOff ??= [];
    }
    for (const t of pub.tracks) {
        t.end = Object.assign({ [GameSystem.CLASSIC]: 10, [GameSystem.ALPHA_STRIKE]: 8, text: '' }, t.end);
        t.overrides = Object.assign({ ignoreScale: false, noBsp: false, costScale: '' }, t.overrides);
        t.specialRules = Object.assign({ commander: true, forcedWithdrawal: true, crippling: true, scanning: false }, t.specialRules);
        t.mods ??= [];
        t.objectives ??= [];
    }
    return pub;
}
