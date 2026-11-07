// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import {
    CAMPAIGN_SCHEMA, RuleError, isGone,
    type ActiveContract, type BetweenState, type Campaign, type CampaignUnit, type CompanyOptions, type LedgerEntry, type LedgerKind,
    type RepairTimeKind, type RunnerEnv, type TrackDraft,
} from './campaign.model';
import { roll } from './dice';
import {
    ECON, HALL_REDUCED_MAINTENANCE, TERMS, basePay, checkNegotiation, contractLimit, pct, purchasePrice, supportKind, trackLimit,
    transportCost, type NegotiationResult, type Terms,
} from './engine';
import { effectsOf, mapOf, newMapState } from './hex-map';
import { newPilot, MAX_NAMED } from './pilots';
import { byId, uid, type BetweenBlock, type Contract, type Faction, type ParentCommand, type Publication, type Variant } from './publication.model';
import { rulesFor } from './rules';
import { monthPlan } from './script';
import { unitCountWeight, type UnitLookup } from './units';

export const fmt = (n: number | null | undefined): string => Number(n || 0).toLocaleString('en-US');

// ---------- dates ----------

export function addMonths(ym: string, n: number): string {
    const [y, m] = String(ym || '3151-04').split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function monthsBetween(a: string, b: string): number {
    const f = (s: string) => {
        const [y, m] = s.split('-').map(Number);
        return y * 12 + m;
    };
    return f(b) - f(a);
}
/** The "month" for upkeep, healing and purchases. On a campaign map each map turn counts as one. */
export const period = (c: Campaign): string => (c.contract?.map ? `${c.date}/t${c.contract.month}` : c.date);

export const unitName = (cu: CampaignUnit): string => cu.name || cu.unit;

// ---------- campaign ----------

export interface NewCampaignInput {
    pub?: Publication | null;
    name?: string;
    system?: GameSystem | null;
    options?: Partial<CompanyOptions>;
    backgroundId?: string;
    factionId?: string;
    start?: string | null;
}

export function newCampaign(input: NewCampaignInput = {}): Campaign {
    const { pub = null, name = 'New mercenary command', system = null, options = {}, backgroundId = '', factionId = '', start = null } = input;
    const vet = !!options.veteranCommand;
    const c: Campaign = {
        schema: CAMPAIGN_SCHEMA, id: uid('cmp'), name, pubId: pub?.id || '', pubTitle: pub?.title || '',
        system: system || pub?.systems?.[0] || GameSystem.CLASSIC, date: start || pub?.calendar?.start || '3151-04', maintPaid: '',
        scale: vet ? 3 : 1, // R-13
        reputation: vet ? 5 : 1, warchest: vet ? 6000 : 3000, debt: 0, debtMonths: 0, skipUsed: false, skipPenalty: false,
        options: { battleArmor: false, tanker: false, mechCommander: false, veteranCommand: false, ...options },
        backgroundId, factionId, regular: factionId ? { factionId, parentId: '', rank: rankFor(vet ? 5 : 1) } : null,
        tofttOptions: [], factionRolls: {}, hallId: '', sponsorId: '', sponsorBanned: [], modifiers: { mechBay: false },
        setup: true, orgType: 'is', formations: [], units: [], pilots: [], ledger: [], contract: null, offer: null, offers: { date: '', n: 0 }, history: [], tracks: [], draft: null,
        opponent: null, notes: '',
    };
    if (vet) for (let i = 1; i <= 4; i++) c.pilots.push(newPilot(`Named pilot ${i}`, 1000));
    else c.pilots.push(newPilot('Named pilot 1', 150), newPilot('Named pilot 2', 150));
    c.ledger.push(entry(c, { event: 'Starting Warchest', cover: c.warchest, net: c.warchest, kind: 'start' }));
    return c;
}

/** Fill fields added after a campaign file was written. Add a step whenever a field shape changes. */
export function migrateCampaign(c: Campaign): Campaign {
    c.units ||= [];
    c.pilots ||= [];
    c.ledger ||= [];
    c.history ||= [];
    c.tracks ||= [];
    c.options ||= { battleArmor: false, tanker: false, mechCommander: false, veteranCommand: false };
    c.modifiers ||= { mechBay: false };
    c.sponsorBanned ||= [];
    c.tofttOptions ||= [];
    c.factionRolls ||= {};
    c.formations ||= [];
    c.orgType ||= 'is';
    c.opponent ??= null;
    c.offer ??= null;
    c.offers ??= { date: '', n: 0 };
    if (c.factionId && !c.regular) c.regular = { factionId: c.factionId, parentId: '', rank: rankFor(c.reputation) };
    for (const p of c.pilots) {
        p.cols ||= { gunnery: 0, piloting: 0, asSkill: 0, edge: 0, edgeAbilities: 0 };
        p.edgeAbilities ||= [];
        p.scas ||= [];
    }
    for (const u of c.units) u.crew ||= { kind: 'regular', wounds: 0 };
    return c;
}

// ---------- ledger ----------

interface EntryInput {
    event: string;
    cost?: number;
    cover?: number;
    net?: number;
    toDebt?: number;
    kind?: LedgerKind;
    note?: string;
}
export function entry(c: Campaign, o: EntryInput): LedgerEntry {
    return {
        id: uid('le'), date: c.date, cmonth: c.contract ? c.contract.month : null, contract: c.contract?.name || '',
        event: o.event, cost: o.cost || 0, cover: o.cover || 0, net: o.net ?? ((o.cover || 0) - (o.cost || 0)),
        toDebt: o.toDebt || 0, warchest: c.warchest, debt: c.debt, rep: c.reputation, kind: o.kind || 'other', note: o.note || '',
    };
}
export function note(c: Campaign, event: string, kind: LedgerKind = 'note'): void {
    c.ledger.push(entry(c, { event, kind }));
}

export interface PostInput {
    event: string;
    cost?: number;
    cover?: number;
    kind?: LedgerKind;
    /** Only maintenance and transport may go into debt. */
    allowDebt?: boolean;
    note?: string;
}
/** The single ledger entry point. Paid = cost − cover. Net gains repay at least half of any debt. */
export function post(c: Campaign, input: PostInput): LedgerEntry {
    const { event, kind = 'other', allowDebt = false, note: n = '' } = input;
    const cost = Math.max(0, Math.round(input.cost ?? 0));
    const cover = Math.max(0, Math.round(input.cover ?? 0));
    const net = cover - cost;
    let toDebt = 0;
    if (net >= 0) {
        if (c.debt > 0) {
            toDebt = Math.min(c.debt, Math.ceil(net / 2));
            c.debt -= toDebt;
        }
        c.warchest += net - toDebt;
    } else {
        const need = -net;
        if (c.warchest >= need) c.warchest -= need;
        else if (allowDebt) {
            c.debt += need - c.warchest;
            c.warchest = 0;
        } else throw new RuleError(`${event}: needs ${fmt(need)} SP, Warchest has ${fmt(c.warchest)}`);
    }
    if (c.debt === 0) {
        c.debtMonths = 0;
        c.skipUsed = false;
    }
    const e = entry(c, { event, cost, cover, net, toDebt, kind, note: n });
    c.ledger.push(e);
    return e;
}
export function payDebt(c: Campaign, amount: number): void {
    amount = Math.min(Math.round(amount), c.debt, c.warchest);
    if (amount <= 0) return;
    c.warchest -= amount;
    c.debt -= amount;
    if (c.debt === 0) {
        c.debtMonths = 0;
        c.skipUsed = false;
    }
    c.ledger.push(entry(c, { event: 'Pay down Warchest Debt', net: 0, toDebt: amount, kind: 'debt' }));
}
export function requireNoDebt(c: Campaign, what: string): void {
    if (c.debt > 0) throw new RuleError(`${what}: not allowed while in Warchest Debt.`);
}
export function changeRep(c: Campaign, delta: number, reason: string): void {
    if (!delta) return;
    c.reputation = Math.max(0, c.reputation + delta);
    c.ledger.push(entry(c, { event: `Reputation ${delta > 0 ? '+' : ''}${delta}: ${reason}`, kind: 'rep' }));
    updateRank(c);
}

// ---------- regular military commands ----------

export const RANKS: readonly (string | null)[] = [null, 'Sergeant / Point Commander', 'Lieutenant / Star Commander', 'Captain / Star Captain'];
export const rankFor = (rep: number): number => (rep >= 5 ? 3 : rep >= 3 ? 2 : 1);
/** Promotion follows Reputation; demotion only once Reputation is two ranks lower. */
export function updateRank(c: Campaign): void {
    const r = c.regular;
    if (!r) return;
    const now = rankFor(c.reputation);
    if (now > r.rank) {
        r.rank = now;
        c.ledger.push(entry(c, { event: `Promoted to ${RANKS[now]}`, kind: 'rep' }));
    } else if (now <= r.rank - 2) {
        r.rank -= 1;
        c.ledger.push(entry(c, { event: `Demoted to ${RANKS[r.rank]}`, kind: 'rep' }));
    }
}
/** Simple contract terms for regular military: salvage-or-command choice by rank. */
export function regularTermOptions(c: Campaign): { key: 'salvage' | 'command'; label: string; terms: Terms }[] {
    const hi = (c.regular?.rank || 1) >= 3;
    const base = { basePay: 7, transport: 9, support: 8 };
    return [
        { key: 'salvage', label: `50% salvage, ${hi ? 'House' : 'Integrated'} Command`, terms: { ...base, salvage: 8, command: hi ? 7 : 3 } },
        { key: 'command', label: `0% salvage, ${hi ? 'Liaison' : 'House'} Command`, terms: { ...base, salvage: 0, command: hi ? 8 : 7 } },
    ];
}
export function factionOf(c: Campaign, pub: Publication): Faction | undefined {
    return c.regular ? byId(pub, 'factions', c.regular.factionId) : undefined;
}
export function parentOf(c: Campaign, pub: Publication): ParentCommand | undefined {
    const f = factionOf(c, pub);
    return f && c.regular?.parentId ? (f.parents || []).find(x => x.id === c.regular!.parentId) : undefined;
}

// ---------- force values ----------

export function ownUnits(c: Campaign): CampaignUnit[] {
    return c.units.filter(u => !u.tempHire && !u.granted && !isGone(u.state));
}
export function forceValue(units: readonly CampaignUnit[], system: GameSystem, lookup: UnitLookup): number {
    const r = rulesFor(system);
    return units.reduce((s, cu) => s + r.unitValue(lookup(cu.unit)), 0);
}
export function unitCount(units: readonly CampaignUnit[], lookup: UnitLookup): number {
    return units.reduce((s, cu) => s + unitCountWeight(lookup(cu.unit)), 0);
}

export interface Check {
    level: 'error' | 'warn' | 'info';
    msg: string;
}
export function campaignChecks(c: Campaign, env: RunnerEnv): Check[] {
    const out: Check[] = [];
    const add = (level: Check['level'], msg: string) => out.push({ level, msg });
    const rules = rulesFor(c.system);
    const named = c.pilots.filter(p => p.status === 'active');
    if (named.length > MAX_NAMED) add('error', `${named.length} named pilots; the maximum is ${MAX_NAMED}.`);
    for (const p of named) if (p.unspent > 0) add('warn', `${p.name} has ${p.unspent} unallocated SP.`);
    if (c.setup) {
        const own = ownUnits(c);
        const meks = own.filter(u => env.units(u.unit)?.type === 'Mek').length;
        const v = forceValue(own, c.system, env.units);
        const lim = c.options.veteranCommand ? rules.limits.veteranStartValue : trackLimit(1, c.system, c.options.mechCommander);
        if (v > lim) add('error', `Starting force is ${fmt(v)} ${rules.valueLabel}; the limit is ${fmt(lim)}.`);
        if (!c.options.veteranCommand) {
            const maxM = rules.limits.maxStartingMechs;
            if (meks < 1 && !c.options.tanker && !c.options.battleArmor) add('warn', "Start with at least one 'Mech.");
            if (meks > maxM) add('warn', `Start with at most ${maxM} 'Mechs.`);
        } else if (own.length > 9) add('error', 'Veteran Command allows at most 9 units.');
    }
    for (const x of formationChecks(c)) add(x.level, x.msg);
    if (c.debt > 0) add('warn', `In Warchest Debt: ${fmt(c.debt)} SP for ${c.debtMonths} month(s). No purchases or training; at least half of every gain pays the debt.`);
    for (const u of c.units) if (u.pilotId && !c.pilots.find(p => p.id === u.pilotId && p.status === 'active')) add('warn', `${unitName(u)} is assigned to a missing or dead pilot.`);
    return out;
}

// ---------- formations ----------

export const ORG_TYPES: Readonly<Record<string, [string, number]>> = {
    is: ['Inner Sphere (lances of 4)', 4], clan: ['Clan (Stars of 5)', 5], comstar: ['ComStar (Level IIs of 6)', 6],
};
export function formationChecks(c: Campaign): Check[] {
    const out: Check[] = [];
    const size = ORG_TYPES[c.orgType || 'is'][1];
    const off = (c.formations || []).filter(f => f.unitIds.length !== size);
    if (off.length > 1) out.push({ level: 'warn', msg: `Only one formation may be over- or under-strength (${size} units each); ${off.length} are.` });
    for (const f of c.formations || []) {
        const cmd = c.pilots.find(p => p.id === f.commanderId);
        if (!cmd || cmd.status !== 'active') out.push({ level: 'warn', msg: `${f.name}: no living commander.` });
        else if (cmd.formation !== f.type) out.push({ level: 'warn', msg: `${f.name}: ${cmd.name} is trained in ${cmd.formation || 'no formation'}, not ${f.type}.` });
    }
    return out;
}
/** Formations whose trained commander is fielded with 3+ of its units. */
export function activeFormations(c: Campaign, d: TrackDraft | null) {
    const fielded = new Set(d?.unitIds || []);
    return (c.formations || []).filter(f => {
        const cmd = c.pilots.find(p => p.id === f.commanderId && p.status === 'active');
        if (!cmd || cmd.formation !== f.type) return false;
        const cmdUnit = c.units.find(u => fielded.has(u.id) && (d?.pilotFor[u.id] ?? u.pilotId) === cmd.id);
        return !!cmdUnit && f.unitIds.filter(id => fielded.has(id)).length >= 3;
    });
}
export function trackFreeMonth(c: Campaign, pub: Publication): boolean {
    const ct = c.contract;
    if (!ct || ct.status !== 'active') return true;
    if (ct.tracksThisMonth > 0) return false;
    const plan = monthPlan(c, pub);
    return plan.items.length === 0 && !plan.waiting;
}

// ---------- repair time (optional table) ----------

export const REPAIR_TIME: Readonly<Record<RepairTimeKind, string>> = {
    none: 'No repairs',
    hasty: 'Hasty repairs', standard: 'Standard repairs', extended: 'Extended repairs', all: 'All the time in the world',
};
export function repairTimeKind(roll2d6: number): RepairTimeKind {
    return roll2d6 <= 2 ? 'hasty' : roll2d6 <= 9 ? 'standard' : roll2d6 <= 11 ? 'extended' : 'all';
}
export function repairTimeNow(c: Campaign): RepairTimeKind {
    const ct = c.contract;
    const rt = ct?.repairTime;
    return rt && rt.date === period(c) && rt.after === ct.tracksThisMonth ? rt.kind : 'standard';
}

/** Between-tracks effects in force now (set when the last track was applied). */
export function betweenNow(c: Campaign): BetweenState | null {
    const b = c.contract?.between;
    return b && b.track === c.contract!.trackIds.length ? b : null;
}
/** Why an SP activity can't be done now, or ''. 'No repairs' blocks every activity. */
export function betweenBlocked(c: Campaign, what: BetweenBlock): string {
    if (repairTimeNow(c) === 'none') return 'No repairs: no time for repairs, rearming or healing before the next track.';
    const b = betweenNow(c);
    return b?.block.includes(what) ? `Track event: no ${what === 'heal' ? 'healing' : what === 'rearm' ? 'rearming' : 'repairs'} before the next track.` : '';
}
/** Multiplier on SP activity costs from between-tracks effects. */
// ponytail: applied to repair, reconfigure, rearm and heal only; purchases and hiring would need it in every buy path.
export function betweenCostFactor(c: Campaign): number {
    return 1 + (betweenNow(c)?.costPct || 0) / 100;
}

// ---------- contracts ----------

export function availableContracts(c: Campaign, pub: Publication) {
    const fac = factionOf(c, pub);
    return (pub.contracts || []).map(ct => {
        const hs = (pub.hotSpots || []).find(h => (h.contractIds || []).includes(ct.id));
        const av = hs?.availability;
        const open = (!av?.from || c.date >= av.from) && (!av?.to || c.date <= av.to);
        const entryFor = fac ? (fac.contracts || []).find(x => x.contractId === ct.id) : undefined;
        return { ct, hs, open, allowed: !fac || !!entryFor, restriction: entryFor?.restriction || '', brief: byId(pub, 'briefs', ct.briefId) };
    });
}
export function variantOf(c: Campaign, pub: Publication): Variant | undefined {
    return c.contract?.variantId ? byId(pub, 'variants', c.contract.variantId) : undefined;
}
export function supportCoverage(terms: Terms): number {
    const k = supportKind(terms.support);
    return k === 'battle' ? 1 : k === 'straight' ? pct('support', terms.support) : 0;
}
/** Support step in force now (final-battle override wins). */
export function supportStep(c: Campaign): number {
    const step = c.contract?.supportOverride ?? c.contract?.terms.support ?? 0;
    return Math.max(0, step - (betweenNow(c)?.supportShift || 0));
}
/** Fraction of repair/rearm/heal costs the employer covers now, including map effects. */
export function coverage(c: Campaign, pub: Publication | null): number {
    const ct = c.contract;
    if (!ct) return 0;
    const step = supportStep(c);
    const k = supportKind(step);
    if (k === 'battle') return 1;
    let v = k === 'straight' ? pct('support', step) : 0;
    if (ct.map && pub) v += effectsOf(c, pub, 'supportPct').reduce((s, e) => s + (Number(e.value) || 0) / 100, 0);
    return Math.min(1, v);
}
export function negotiationCheck(c: Campaign, ct: Contract, terms: Terms, scale: number): NegotiationResult {
    return checkNegotiation(ct.terms, terms, { reputation: c.reputation, scale, locks: ct.locks || {}, nonNegotiable: ct.nonNegotiable });
}
/** A force over the contract limit chooses which units to bring; the rest are left behind. */
export function contractLimitCheck(c: Campaign, lookup: UnitLookup, scale: number, bring: string[] | null = null) {
    const rules = rulesFor(c.system);
    const own = ownUnits(c).filter(u => !bring || bring.includes(u.id));
    const lim = contractLimit(scale, c.system, c.options.mechCommander);
    const v = forceValue(own, c.system, lookup);
    const n = unitCount(own, lookup);
    const errors: string[] = [];
    if (v > lim.value) errors.push(`Units brought total ${fmt(v)} ${rules.valueLabel}; the contract limit at Scale ${scale} is ${fmt(lim.value)}. Leave some behind.`);
    if (n > lim.units) errors.push(`${n} units brought; the contract limit at Scale ${scale} is ${lim.units}.`);
    return { ok: !errors.length, errors, value: v, units: n, limit: lim };
}

export interface AcceptInput {
    contractId: string;
    terms: Terms;
    scale?: number;
    jumps?: number | null;
    override?: boolean;
    /** Campaign unit ids brought on the contract; null = all. */
    bring?: string[] | null;
    /** Taking One For the Team for the whole contract (R-36). */
    toftt?: boolean;
}
export function acceptContract(c: Campaign, env: RunnerEnv, input: AcceptInput): ActiveContract {
    const { contractId, terms, scale = c.scale, jumps = null, override = false, bring = null, toftt = false } = input;
    const pub = env.pub;
    if (c.contract) throw new RuleError('A contract is already active.');
    const ct = byId(pub, 'contracts', contractId);
    if (!ct) throw new RuleError('Contract not found.');
    if (c.regular && !toftt) {
        if (!availableContracts(c, pub).find(x => x.ct.id === contractId)?.allowed) throw new RuleError('That contract is not open to your faction; you can Take One For the Team instead.');
        const ok = regularTermOptions(c).some(o => TERMS.every(t => o.terms[t] === terms[t]));
        if (!ok && !override) throw new RuleError('Regular military commands use the simple contract terms.');
    } else if (!toftt) {
        const neg = negotiationCheck(c, ct, terms, scale);
        if (!neg.ok && !override) throw new RuleError(neg.errors.join(' '));
    }
    const lim = contractLimitCheck(c, env.units, scale, bring);
    if (!lim.ok && !override && !toftt) throw new RuleError(lim.errors.join(' '));
    if (bring) for (const u of ownUnits(c)) if (!bring.includes(u.id)) u.leftBehind = true;
    const brief = byId(pub, 'briefs', ct.briefId);
    const side = brief?.sides.find(s => s.contractId === ct.id)?.key || 'A';
    // A month already paid starts the new contract next month.
    if (c.maintPaid === c.date) c.date = addMonths(c.date, 1);
    c.scale = scale;
    c.setup = false;
    c.offer = null;
    const ac: ActiveContract = {
        id: uid('cc'), contractId: ct.id, briefId: ct.briefId || '', name: ct.name, number: ct.number || '', employer: ct.employer || '',
        side, terms: { ...terms }, offered: { ...ct.terms }, scale, length: Number(ct.length) || 1, month: 1, startDate: c.date,
        results: {}, rolls: {}, choices: {}, loops: {}, tracksThisMonth: 0, trackIds: [], buildings: 0, exchangeCredit: 0,
        salvagePool: [], variantId: ct.variantId || '', piracy: !!ct.piracy, jumps, status: 'active', toftt: !!toftt,
    };
    c.contract = ac;
    if (toftt) ac.terms = { basePay: 0, support: 0, transport: 0, salvage: 0, command: ct.terms.command };
    const map = ct.mapId ? byId(pub, 'maps', ct.mapId) : undefined;
    if (map) {
        ac.map = newMapState(map);
        ac.length = Number(map.rules.turns) || ac.length;
        ac.briefId = '';
    }
    if (!toftt) {
        const tCost = transportCost(scale, jumps);
        post(c, { event: `Transport${jumps != null ? ` (${jumps} jumps)` : ''}`, cost: tCost, cover: Math.round(tCost * pct('transport', terms.transport)), kind: 'transport', allowDebt: true });
    } else note(c, `Taking One For the Team: playing the opposing force in ${ct.name}`);
    // Granted forces for the player's side: units under the player's command for this contract.
    for (const f of toftt ? [] : brief?.forces || []) {
        if (f.side !== side) continue;
        for (const x of f.units || []) {
            const n = (x.qty || 1) * (x.perScale ? scale : 1);
            for (let i = 0; i < n; i++) {
                c.units.push({
                    id: uid('cu'), unit: x.unit, state: 'ok', granted: f.id, grantedName: f.name, fromMonth: f.fromMonth || 1,
                    persistent: f.persistent !== false, crew: { kind: 'fixed', g: x.g ?? 4, p: x.p ?? 5, skill: x.skill ?? 4, wounds: 0 }, pilotId: '', acquired: c.date,
                });
            }
        }
    }
    beginMonth(c, env);
    return ac;
}

/** Start of a month: maintenance, then Base Pay. Between contracts maintenance is still owed (or the hall's reduced rate). */
export function beginMonth(c: Campaign, env: RunnerEnv): void {
    if (c.maintPaid === period(c)) return;
    const ct = c.contract;
    if (ct && ct.status === 'active' && ct.toftt) {
        post(c, { event: 'Maintenance (Taking One For the Team, no Base Pay)', cost: ECON.maintenancePerScale * c.scale, kind: 'month', allowDebt: true });
    } else if (ct && ct.status === 'active') {
        const every = Math.max(1, variantOf(c, env.pub)?.o.basePayEvery || 1);
        const maint = ECON.maintenancePerScale * ct.scale;
        const bp = basePay(ct.scale, ct.terms);
        if (every > 1) {
            if (ct.month % every === 0 || ct.month === ct.length) {
                const k = ct.month % every === 0 ? every : ct.month % every;
                post(c, { event: `Maintenance / Base Pay (${k} months)`, cost: maint * k, cover: bp * k, kind: 'month', allowDebt: true });
            }
        } else post(c, { event: 'Maintenance / Base Pay', cost: maint, cover: bp, kind: 'month', allowDebt: true });
        c.hallStandard = (c.hallStandard || 0) + 1;
        if (c.hallStandard >= 3) c.hallReduced = 0;
    } else {
        const hall = c.hallId ? byId(env.pub, 'halls', c.hallId) : undefined;
        // Reduced hall maintenance: up to 6 months; the counter resets after 3 months of standard maintenance.
        const reduced = !!hall && hall.reducedMaintenance !== false && (c.hallReduced || 0) < 6;
        const maint = reduced ? HALL_REDUCED_MAINTENANCE : ECON.maintenancePerScale * c.scale;
        const event = reduced ? `Maintenance at ${hall!.name} (reduced, ${(c.hallReduced || 0) + 1}/6)` : hall ? `Maintenance at ${hall.name}` : 'Maintenance (between contracts)';
        post(c, { event, cost: maint, kind: 'month', allowDebt: true });
        if (reduced) {
            c.hallReduced = (c.hallReduced || 0) + 1;
            c.hallStandard = 0;
        } else {
            c.hallStandard = (c.hallStandard || 0) + 1;
            if (c.hallStandard >= 3) c.hallReduced = 0;
        }
    }
    c.maintPaid = period(c);
}

/** End the month: debt clock, deliveries, date. During a contract the next month starts at once; after the last month the contract waits to be closed. */
export function endMonth(c: Campaign, env: RunnerEnv): void {
    const ct = c.contract;
    const rng = env.rng ?? Math.random;
    if (ct && ct.status !== 'active') throw new RuleError('The contract has ended; close it first.');
    if (c.maintPaid !== period(c)) beginMonth(c, env);
    if (ct) ct.exchangeCredit = 0;
    if (c.debt > 0) {
        c.debtMonths++;
        if (c.debtMonths % 6 === 0) changeRep(c, -1, 'six months in Warchest Debt (R-14)');
    }
    const per = Math.max(1, Number(ct?.map ? mapOf(c, env.pub)?.rules.turnsPerMonth : 1) || 1);
    if (!ct?.map || ct.month % per === 0) c.date = addMonths(c.date, 1);
    for (const cu of c.units) {
        if (cu.delivery && !cu.delivery.collect && cu.delivery.due && cu.delivery.due <= c.date) {
            note(c, `Delivered: ${unitName(cu)}`);
            delete cu.delivery;
        }
        if (cu.scrapCheck && cu.scrapCheck.due <= c.date) {
            const r = roll('1D6', rng).total;
            if (r <= 3) {
                cu.state = 'truly';
                note(c, `Scrapyard wreck ${unitName(cu)}: 1D6 ${r}, beyond repair`);
            } else note(c, `Scrapyard wreck ${unitName(cu)}: 1D6 ${r}, repairable (destroyed)`);
            delete cu.scrapCheck;
        }
    }
    c.units = c.units.filter(u => !(u.state === 'truly' && u.source === 'scrapyard'));
    if (ct) {
        ct.tracksThisMonth = 0;
        if (ct.month >= ct.length) {
            ct.status = 'ended';
            ct.endDate = addMonths(c.date, -1);
            return;
        }
        ct.month++;
        beginMonth(c, env);
    }
}
/** Between contracts: spend a month. */
export function waitMonth(c: Campaign, env: RunnerEnv): void {
    if (c.contract) throw new RuleError('Finish or break the contract first.');
    // An unanswered offer lapses with the month.
    c.offer = null;
    endMonth(c, env);
}

// ---------- contract end ----------

export interface VictoryEval {
    text: string;
    /** true / false when decided by the record, null when the player must judge. */
    auto: boolean | null;
}
export function evaluateVictory(c: Campaign, pub: Publication): { conds: VictoryEval[]; suggested: boolean; playedCount: number } {
    const ct = c.contract;
    if (!ct) return { conds: [], suggested: false, playedCount: 0 };
    const brief = byId(pub, 'briefs', ct.briefId);
    const conds = brief?.victoryConds?.[ct.side] || [];
    const played = c.tracks.filter(t => t.contractRef === ct.id && !t.skip);
    const last = played[played.length - 1];
    const won = (k: string) => ct.results[k] === ct.side;
    const out: VictoryEval[] = conds.map(v => {
        switch (v.kind) {
            case 'survive': {
                const alive = c.units.filter(u => u.granted === v.forceId && !isGone(u.state)).length;
                return { text: `Granted force survives (${alive} left, need ${v.min})`, auto: alive >= v.min };
            }
            case 'winAll': {
                const res = v.nodes.map(k => ct.results[k]);
                const lost = res.some(x => x !== undefined && x !== ct.side);
                const open = res.some(x => x === undefined) && ct.status === 'active';
                const text = `Win all of ${v.nodes.length} listed tracks (${res.filter(x => x === ct.side).length} won${res.some(x => x === undefined) ? ', some not played' : ''})`;
                return { text, auto: lost ? false : open ? null : res.every(x => x === ct.side) };
            }
            case 'winCount': {
                const pool = v.nodes?.length ? v.nodes : played.map(t => t.key);
                const n = pool.filter(won).length;
                return { text: `Win at least ${v.n} tracks (${n} won)`, auto: n >= v.n };
            }
            case 'finalTrack': return { text: 'Win the final track', auto: last ? last.winner === ct.side : false };
            case 'otherFails': return { text: 'The other side fails its conditions', auto: null };
            case 'destroy': return { text: `Destroy ${v.n} ${v.what}`, auto: null };
            case 'text': return { text: v.text || 'Other condition', auto: null };
        }
    });
    if (!out.length) out.push({ text: 'Win the final track (no conditions authored)', auto: last ? last.winner === ct.side : false });
    return { conds: out, suggested: out.some(x => x.auto === true), playedCount: played.length };
}

export interface CloseInput {
    won?: boolean;
    /** Lost own units to buy back. */
    ransom?: string[];
    /** Temp-hire units to hire permanently. */
    hireIds?: string[];
    piracyFail?: boolean;
    piracySp?: number;
    /** Unit offered at half price after a whole contract of TOFTT tracks. */
    tofttBonus?: string;
}
/** Close the contract: Reputation (R-1), buildings, ransom, permanent hires, cleanup. */
export function closeContract(c: Campaign, env: RunnerEnv, input: CloseInput = {}): void {
    const { won = false, ransom = [], hireIds = [], piracyFail = false, piracySp = 0, tofttBonus = '' } = input;
    const ct = c.contract;
    if (!ct) throw new RuleError('No contract.');
    const rules = rulesFor(c.system);
    const v = variantOf(c, env.pub);
    if (v?.o.supportAtEnd) {
        // Support and losses paid at the end, scaled by the variant's SP multiplier.
        const mult = v.o.spCostMult || 1;
        const due = Math.round(Number(ct.deferredSupport || 0) * mult);
        if (due) post(c, { event: `Deferred support and losses${mult !== 1 ? ` ×${mult}` : ''} (${v.name})`, cover: due, kind: 'support' });
    }
    if (won) changeRep(c, 1, `victorious contract ${ct.name} (R-1)`);
    const played = c.tracks.filter(t => t.contractRef === ct.id).length;
    if (ct.buildings > 2 * played) changeRep(c, -1, `${ct.buildings} non-objective buildings destroyed in ${played} tracks`);
    if (ct.piracy && piracyFail) changeRep(c, -Math.max(1, Math.floor((Number(piracySp) || 0) / 500)), 'piracy exposed');
    // Ransom: buy back own lost units at salvage price; they return destroyed.
    for (const cu of c.units.filter(u => u.state === 'lost' && u.lostTo === ct.name && !u.tempHire)) {
        if (ransom.includes(cu.id) && !ct.piracy) {
            post(c, { event: `Ransom ${unitName(cu)}`, cost: rules.sellingPrice(env.units(cu.unit)), kind: 'purchase' });
            cu.state = 'destroyed';
            cu.lostTo = null;
            cu.damagedInContract = false;
        }
    }
    // Permanent hires: at least one successful track together; half purchase price (R-9).
    for (const cu of c.units.filter(u => u.tempHire)) {
        const t = cu.tempHire!;
        if (hireIds.includes(cu.id) && t.successes > 0 && !isGone(cu.state)) {
            post(c, { event: `Hire ${t.name} permanently (with ${unitName(cu)})`, cost: Math.ceil(purchasePrice(env.units(cu.unit), c.system) / 2), kind: 'hire' });
            cu.crew = { kind: 'fixed', g: t.g, p: t.p, skill: t.skill, wounds: 0, name: t.name };
            cu.name = '';
            cu.source = 'hire';
            delete cu.tempHire;
        }
    }
    // TOFTT options expire with their contract, unless earned while playing the opponent between own contracts.
    c.tofttOptions = c.tofttOptions.filter(o => o.contractRef !== 'next');
    c.tofttOptions = c.tofttOptions.filter(o => o.contractRef !== ct.id || o.betweenContracts);
    for (const o of c.tofttOptions) if (o.contractRef === ct.id) o.contractRef = 'next';
    const tracksHere = c.tracks.filter(t => t.contractRef === ct.id && !t.skip);
    if (tofttBonus && tracksHere.length && tracksHere.every(t => t.toftt)) {
        c.tofttOptions.push({ id: uid('to'), unit: tofttBonus, half: true, from: ct.name, contractRef: 'next', betweenContracts: true });
    }
    c.units = c.units.filter(u => !u.tempHire && !u.granted && !isGone(u.state));
    for (const u of c.units) {
        u.damagedInContract = false;
        delete u.leftBehind;
    }
    c.history.push({
        id: ct.id, name: ct.name, number: ct.number, employer: ct.employer, start: ct.startDate, end: ct.endDate || c.date, terms: ct.terms, scale: ct.scale,
        won: !!won, broken: !!ct.broken, tracks: ct.trackIds, rep: c.reputation,
    });
    c.contract = null;
    c.skipPenalty = false;
}

/** Escape clause: the force is under two-thirds of the Scale limit (R-12 scales it). */
export function escapeClauseOk(c: Campaign, lookup: UnitLookup): boolean {
    const v = forceValue(ownUnits(c).filter(u => u.state !== 'truly' && !u.leftBehind), c.system, lookup);
    return v < (2 / 3) * trackLimit(c.contract?.scale || c.scale, c.system, c.options.mechCommander);
}
/** Breaking a contract: lose half Reputation, minimum 3 (R-7); the escape clause costs 1. */
export function breakContract(c: Campaign, env: RunnerEnv, { escape = false } = {}): void {
    const ct = c.contract;
    if (!ct) throw new RuleError('No contract.');
    if (escape && !escapeClauseOk(c, env.units)) throw new RuleError('Escape clause needs the force under two-thirds of the Scale limit.');
    const loss = escape ? 1 : Math.max(3, Math.ceil(c.reputation / 2));
    changeRep(c, -loss, escape ? 'escape clause' : `broke contract ${ct.name} (R-7)`);
    ct.broken = true;
    closeContract(c, env, { won: false });
}

export function mercenaryRating(c: Campaign, lookup: UnitLookup): number {
    const rules = rulesFor(c.system);
    const units = ownUnits(c).reduce((s, cu) => s + rules.purchasePrice(lookup(cu.unit)), 0);
    const sp = c.pilots.filter(p => p.status === 'active').reduce((s, p) => s + p.earned, 0);
    return units + c.warchest - c.debt + sp;
}

