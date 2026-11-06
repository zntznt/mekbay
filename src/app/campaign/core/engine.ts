// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { LADDER, ladderHandicap, rulesFor, type PilotSkills } from './rules';
import type { CampaignUnitData } from './units';

/*
 * Contract and economy math shared by both systems: the Contract Steps Table,
 * negotiation, Scale limits, pay. Numbers and formulas only. Rulings are
 * referenced as R-n.
 */

// ---------- contract terms ----------

export type TermKey = 'basePay' | 'support' | 'transport' | 'salvage' | 'command';
export const TERMS: readonly TermKey[] = ['basePay', 'support', 'transport', 'salvage', 'command'];
export const TERM_LABEL: Readonly<Record<TermKey, string>> = {
    basePay: 'Base Pay', support: 'Support', transport: 'Transportation', salvage: 'Salvage Rights', command: 'Command Rights',
};

/** Contract terms as steps (0–17). */
export type Terms = Record<TermKey, number>;

export interface TermLock {
    mode: 'fixed' | 'min' | 'max';
    value: number;
}
export type TermLocks = Partial<Record<TermKey, TermLock>>;

const D = null;
/** Contract Steps Table. null = em-dash (not selectable). Index = step 0–17. */
export const STEPS: Readonly<Record<TermKey, readonly (string | null)[]>> = {
    basePay: ['0%', '50%', '55%', '60%', '70%', '80%', '90%', '100%', '110%', '120%', '130%', '140%', '150%', '160%', '170%', '180%', '190%', '200%'],
    command: ['None', D, D, 'Integrated', D, D, D, 'House', 'Liaison', D, D, 'Independent', D, D, D, D, D, D],
    salvage: ['None', 'None', D, 'Exchange', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%', '100%', D, D, D, D],
    support: ['None', 'None', 'Straight/20%', 'Straight/40%', 'Straight/60%', 'Straight/70%', 'Straight/80%', 'Straight/90%', 'Straight/100%',
        'Battle/10%', 'Battle/20%', 'Battle/30%', 'Battle/40%', 'Battle/50%', 'Battle/75%', 'Battle/100%', D, D],
    transport: ['0%', D, D, D, D, '0%', '25%', '50%', '75%', '100%', D, D, D, D, D, D, D, D],
};
export const MAX_STEP = 17;

export function stepLabel(term: TermKey, step: number): string {
    return STEPS[term][step] ?? '—';
}
export function selectable(term: TermKey, step: number): boolean {
    return step >= 0 && step <= MAX_STEP && STEPS[term][step] != null;
}
export function selectableSteps(term: TermKey): number[] {
    const out: number[] = [];
    for (let s = 0; s <= MAX_STEP; s++) if (selectable(term, s)) out.push(s);
    return out;
}
/** An em-dash step resolves to the next step closer to 7. */
export function resolveStep(term: TermKey, step: number): number {
    // Steps come from imported publications: a non-number would never become selectable.
    let s = Number.isFinite(step) ? Math.trunc(Math.max(0, Math.min(MAX_STEP, step))) : 7;
    for (let i = 0; i <= MAX_STEP && !selectable(term, s); i++) s += s < 7 ? 1 : -1;
    return s;
}
export function pct(term: TermKey, step: number): number {
    const v = STEPS[term][step];
    if (!v) return 0;
    const m = /(\d+)%/.exec(v);
    return m ? Number(m[1]) / 100 : 0;
}
export type SupportKind = 'battle' | 'straight' | 'none';
export function supportKind(step: number): SupportKind {
    const v = STEPS.support[step] || '';
    return v.startsWith('Battle') ? 'battle' : v.startsWith('Straight') ? 'straight' : 'none';
}
export type CommandBand = 'None' | 'Integrated' | 'House' | 'Liaison' | 'Independent';
export function commandBand(step: number): CommandBand {
    if (step <= 0) return 'None';
    if (step <= 3) return 'Integrated';
    if (step <= 7) return 'House';
    if (step <= 10) return 'Liaison';
    return 'Independent';
}
export type CommandModKey = 'integrated' | 'house' | 'liaison' | 'independent';
export const COMMAND_MOD_DEFAULT: Readonly<Record<CommandModKey, number>> = { integrated: 3, house: 2, liaison: 1, independent: 0 };

// ---------- Scale ----------

export const SCALE = { contractMult: 1.5, unitsPerScale: 3 } as const;

export function trackLimit(scale: number, system: GameSystem = GameSystem.CLASSIC, mechCommander = false): number {
    const l = rulesFor(system).limits;
    return (mechCommander ? l.mechCommanderTrackValuePerScale : l.trackValuePerScale) * scale;
}
export function contractLimit(scale: number, system: GameSystem = GameSystem.CLASSIC, mechCommander = false): { value: number; units: number } {
    return { value: trackLimit(scale, system, mechCommander) * SCALE.contractMult, units: SCALE.unitsPerScale * scale };
}
export function mapsheets(totalScaleSide: number): number {
    return totalScaleSide <= 1 ? 1 : totalScaleSide <= 3 ? 2 : 4;
}
/** Most own-force value you can field alongside a temp hire of `hireValue`. */
export function tempHireRoom(hireValue: number, scale: number, system: GameSystem = GameSystem.CLASSIC): number {
    const under = rulesFor(system).limits.tempHireUnderPerScale * scale;
    return Math.min(under - 1, trackLimit(scale, system) - hireValue);
}

// ---------- economy ----------

export type CombatTier = 'broke' | 'none' | 'unsuccessful' | 'success' | 'allObjectives';

export interface VariantOptions {
    combatPay: Partial<Record<CombatTier, number>> | null;
    combatPayMult: number;
    spCostMult: number;
    supportAtEnd: boolean;
    basePayEvery: number;
    vpIsSp: boolean;
    noDamagePersists: boolean;
}

export const ECON = {
    maintenancePerScale: 500,
    basePayPerScale: 500,
    transportPerScale: 300,
    jumpBase: 50,
    jumpPer: 50,
    jumpsPerTravelMonth: 4,
    combatPay: { broke: 0, none: 0, unsuccessful: 250, success: 500, allObjectives: 750 } as Readonly<Record<CombatTier, number>>,
} as const;

export function transportCost(scale: number, jumps: number | null = null): number {
    if (jumps == null) return ECON.transportPerScale * scale;
    return (ECON.jumpBase + ECON.jumpPer * jumps) * scale;
}
export function combatPay(tier: CombatTier, trackScale: number, variant: { o: Partial<VariantOptions> } | null = null): number {
    const table = variant?.o.combatPay || ECON.combatPay;
    const base = (table[tier] ?? ECON.combatPay[tier] ?? 0) * trackScale;
    return Math.ceil(base * (variant?.o.combatPayMult ?? 1));
}
export function basePay(scale: number, terms: Terms): number {
    return Math.round(ECON.basePayPerScale * scale * pct('basePay', terms.basePay));
}

export interface EconomicsLine {
    month: number;
    event: string;
    cost: number;
    cover: number;
    net: number;
}
export interface EconomicsInput {
    terms: Terms;
    scale?: number;
    months?: number;
    tracks?: number;
    trackScale?: number | null;
    outcome?: CombatTier;
    jumps?: number | null;
    travelMonths?: number | null;
    variant?: { o: Partial<VariantOptions> } | null;
}

/** Contract ledger estimate with one combat-pay outcome applied to every track. */
export function contractEconomics(input: EconomicsInput) {
    const { terms, scale = 1, months = 3, tracks = 1, trackScale = null, outcome = 'success', jumps = null, travelMonths = null, variant = null } = input;
    const maint = ECON.maintenancePerScale * scale;
    const bp = basePay(scale, terms);
    const tCost = transportCost(scale, jumps);
    const tCover = Math.round(tCost * pct('transport', terms.transport));
    const ledger: EconomicsLine[] = [];
    let bal = 0;
    const tm = travelMonths ?? (jumps != null ? Math.floor(jumps / ECON.jumpsPerTravelMonth) : 0);
    if (tCost) {
        bal += tCover - tCost;
        ledger.push({ month: 1, event: 'Transport', cost: tCost, cover: tCover, net: tCover - tCost });
    }
    const every = Math.max(1, variant?.o.basePayEvery || 1);
    for (let m = 1; m <= months; m++) {
        if (every > 1 && m % every !== 0 && m !== months) continue;
        const k = every > 1 ? (m % every === 0 ? every : m % every) : 1;
        bal += (bp - maint) * k;
        ledger.push({ month: m, event: every > 1 ? `Maintenance / Base Pay (${k} months)` : 'Maintenance / Base Pay', cost: maint * k, cover: bp * k, net: (bp - maint) * k });
    }
    const cp = combatPay(outcome, trackScale ?? scale, variant) * tracks;
    if (tracks) ledger.push({ month: months, event: `Combat pay ×${tracks} (${outcome})`, cost: 0, cover: cp, net: cp });
    bal += cp;
    return { ledger, net: bal, monthlyNet: bp - maint, transportNet: tCover - tCost, travelMonths: tm, combat: cp };
}

// ---------- negotiation (R-2) ----------

export interface NegotiationOptions {
    reputation?: number;
    scale?: number;
    locks?: TermLocks;
    nonNegotiable?: boolean;
}
export interface NegotiationResult {
    ok: boolean;
    errors: string[];
    currency: number;
    spent: number;
    raised: number;
    dropped: number;
    repUsable: number;
}

export function checkNegotiation(offered: Terms, final: Terms, opts: NegotiationOptions = {}): NegotiationResult {
    const { reputation = 1, scale = 1, locks = {}, nonNegotiable = false } = opts;
    const errors: string[] = [];
    let raised = 0;
    let dropped = 0;
    const dropsByTerm: Partial<Record<TermKey, number>> = {};
    for (const t of TERMS) {
        const a = offered[t];
        const b = final[t];
        if (b === a) continue;
        if (nonNegotiable) errors.push(`${TERM_LABEL[t]}: contract is non-negotiable`);
        if (!selectable(t, b)) errors.push(`${TERM_LABEL[t]}: step ${b} is not selectable (—)`);
        const lk = locks[t];
        if (lk?.mode === 'fixed') errors.push(`${TERM_LABEL[t]}: term is non-negotiable`);
        if (lk?.mode === 'min' && b < lk.value) errors.push(`${TERM_LABEL[t]}: cannot go below step ${lk.value}`);
        if (lk?.mode === 'max' && b > lk.value) errors.push(`${TERM_LABEL[t]}: cannot go above step ${lk.value}`);
        if (b > a) {
            raised += b - a;
            // R-2: one increase per Scale = one selectable level.
            const levels = selectableSteps(t).filter(s => s > a && s <= b).length;
            if (levels > scale) errors.push(`${TERM_LABEL[t]}: raised ${levels} levels; max ${scale} at Scale ${scale}`);
        } else {
            dropsByTerm[t] = a - b;
            dropped += a - b;
        }
    }
    const repUsable = Math.min(reputation, 2 * scale);
    // Sacrifice: 2 steps dropped buy +1, at most twice.
    const usableDrop = Math.min(4, Object.values(dropsByTerm).reduce((s, d) => s + Math.floor(d / 2) * 2, 0));
    const currency = repUsable + Math.floor(usableDrop / 2);
    if (raised > currency) errors.push(`Raises cost ${raised} step(s); available ${currency} (Reputation ${repUsable} + sacrifices ${Math.floor(usableDrop / 2)})`);
    return { ok: errors.length === 0, errors, currency, spent: raised, raised, dropped, repUsable };
}

/** Best Base Pay reachable by negotiation, spending Reputation and sacrifices on Base Pay only. */
export function bestBasePayTerms(terms: Terms, opts: NegotiationOptions = {}): Terms {
    const { reputation = 1, scale = 1, locks = {}, nonNegotiable = false } = opts;
    if (nonNegotiable || locks.basePay?.mode === 'fixed') return { ...terms };
    let drop = 0;
    for (const t of TERMS) {
        if (t === 'basePay') continue;
        const lk = locks[t];
        if (lk?.mode === 'fixed') continue;
        const floor = Math.max(lk?.mode === 'min' ? lk.value : 0, selectableSteps(t)[0]);
        drop += Math.max(0, terms[t] - floor);
    }
    const currency = Math.min(reputation, 2 * scale) + Math.min(2, Math.floor(Math.min(4, drop) / 2));
    let bp = terms.basePay;
    let raised = 0;
    const cap = locks.basePay?.mode === 'max' ? locks.basePay.value : MAX_STEP;
    while (raised < Math.min(currency, scale) && bp < cap) {
        bp++;
        raised++;
    }
    return { ...terms, basePay: bp };
}

// ---------- pilots ----------

export interface HandicapInput {
    gunnery?: number;
    piloting?: number;
    asSkill?: number | null;
    edge?: number;
    edgeAbilities?: number;
    spas?: number;
}

/** Handicap from skills (R-19: Special Pilot Abilities count as Edge Ability levels). */
export function handicap(input: HandicapInput, system: GameSystem = GameSystem.CLASSIC): number {
    const { gunnery = 4, piloting = 5, asSkill = null, edge = 1, edgeAbilities = 0, spas = 0 } = input;
    const ea = Math.min(5, edgeAbilities + spas);
    const skills: PilotSkills = { gunnery, piloting, skill: asSkill ?? asSkillFrom(gunnery, piloting) };
    return rulesFor(system).skillHandicap(skills) + ladderHandicap(LADDER.edge, edge) + ladderHandicap(LADDER.edgeAbilities, ea);
}
export function asSkillFrom(g: number, p: number): number {
    return Math.floor((g + p) / 2);
}

// ---------- reference lists (ids and labels only) ----------

export const GENERAL_TRACKS: readonly [string, string][] = [
    ['assault', 'Assault'], ['breakthrough', 'Breakthrough'], ['defend', 'Defend'], ['flank', 'Flank'],
    ['meeting-engagement', 'Meeting Engagement'], ['objective-raid', 'Objective Raid'], ['pursuit', 'Pursuit'],
    ['pushback', 'Pushback'], ['recon', 'Recon'], ['retreat', 'Retreat'], ['strike', 'Strike'],
];
export const SPECIAL_RULES: readonly [string, string][] = [
    ['commander', 'Commander'], ['forcedWithdrawal', 'Forced Withdrawal'], ['crippling', 'Crippling Damage'], ['scanning', 'Scanning'],
];
export const CONTRACT_TYPES: Readonly<Record<string, readonly string[]>> = {
    'Raid': ['Objective Raid', 'Diversionary Raid', 'Pirate Raid'],
    'Expedition': ['Reconnaissance', 'Intelligence Support', 'Guerrilla Operation'],
    'Pirate Hunt': [],
    'Garrison': ['Cadre Duty'],
    'Invasion': [],
    'Retainer': [],
    'Defense': [],
    'Piracy': [],
    'Covert': [],
    'Assault': [],
};

// ---------- travel, halls, sponsors ----------

/** Light years per jump. */
export const JUMP_LY = 30;
export function jumpsBetween(a: { x: number | null; y: number | null } | null | undefined, b: { x: number | null; y: number | null } | null | undefined): number | null {
    if (!a || !b || a.x == null || b.x == null || a.y == null || b.y == null) return null;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return Math.max(d > 0 ? 1 : 0, Math.ceil(d / JUMP_LY - 1e-9));
}
export type SupportRating = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export const SUPPORT_RATING_MOD: Readonly<Record<SupportRating, number>> = { A: 0.5, B: 0.5, C: 0.75, D: 1, E: 1, F: 1 };
export const HALL_REDUCED_MAINTENANCE = 100;

export function purchasePrice(u: CampaignUnitData | undefined, system: GameSystem): number {
    return rulesFor(system).purchasePrice(u);
}
export function sponsorPrice(u: CampaignUnitData, system: GameSystem, discountPct: number): number {
    return Math.ceil(purchasePrice(u, system) * (1 - discountPct / 100));
}
