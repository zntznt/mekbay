// SPDX-License-Identifier: GPL-3.0-or-later

import type { GameSystem } from '../../models/common.model';
import {
    DAMAGE_LABEL, RuleError, isGone,
    type Campaign, type CampaignPilot, type CampaignUnit, type FixedPilot, type MapBattle, type RollLogLine, type RunnerEnv, type TableRoller,
    type TrackDraft, type TrackRecord, type TrackResult, type UnitOutcome, type Winner,
} from './campaign.model';
import { roll, type Rng } from './dice';
import {
    SCALE, SUPPORT_RATING_MOD, combatPay, commandBand, pct, purchasePrice, stepLabel, supportKind, trackLimit, type CombatTier, type CommandBand,
} from './engine';
import { effectsOf, enemyAt, groupMove, hexDist, hexName, hexType, isNamed, mapOf, pathLength, recordMove, withdrawHex } from './hex-map';
import { MAX_NAMED, isBAPilot, pilotStats } from './pilots';
import { BETWEEN_BLOCKS, briefNodes, byId, uid, type BetweenBlock, type HotSpot, type Publication, type Side } from './publication.model';
import { rulesFor } from './rules';
import {
    activeFormations, betweenBlocked, betweenCostFactor, coverage, fmt, forceValue, note, ownUnits, period, post, repairTimeKind, repairTimeNow, REPAIR_TIME,
    supportStep, unitCount, unitName, variantOf,
} from './runner';
import { monthPlan, nextItem } from './script';
import { isBattleArmor, type CampaignUnitData } from './units';

const otherSide = (s: Side): Side => (s === 'A' ? 'B' : 'A');

// ---------- setup ----------

export interface TrackItem {
    key: string;
    nodeId: string;
    ancestors: string[];
    trackId: string;
    attacker: Side;
    label: string;
}
export function startTrack(c: Campaign, env: RunnerEnv, item: TrackItem): TrackDraft {
    const ct = c.contract;
    if (!ct || ct.status !== 'active') throw new RuleError('No active contract.');
    const tr = byId(env.pub, 'tracks', item.trackId);
    c.draft = {
        id: uid('tk'), itemKey: item.key, nodeId: item.nodeId, ancestors: item.ancestors, trackId: item.trackId, name: tr?.name || item.label || 'Track',
        attacker: item.attacker, system: c.system, scale: ct.scale, unitIds: [], pilotFor: {}, hireIds: [], grantedIds: [], oppHandicap: 0,
        sca: '', complications: [], notes: '', skip: false,
    };
    return c.draft;
}
/** Drop the track being set up. A map battle is called off: the move that started it is undone. */
export function cancelTrack(c: Campaign): void {
    if (c.contract?.map && c.draft?.mapBattle) c.contract.map.battle = null;
    c.draft = null;
}

export function unitAvailable(c: Campaign, cu: CampaignUnit): { ok: boolean; why: string } {
    const ct = c.contract;
    if (isGone(cu.state)) return { ok: false, why: DAMAGE_LABEL[cu.state] };
    if (cu.leftBehind && ct) return { ok: false, why: 'left behind for this contract' };
    if (cu.arrives && ct?.map && ct.month < cu.arrives) return { ok: false, why: `arrives at the landing zone on turn ${cu.arrives}` };
    if (cu.delivery) return { ok: false, why: cu.delivery.collect ? 'awaiting collection from the sponsor' : `delivery due ${cu.delivery.due}` };
    if (cu.scrapCheck) return { ok: false, why: `scrapyard wreck: repairable? known ${cu.scrapCheck.due}` };
    if (cu.granted && ct && ct.month < (cu.fromMonth || 1)) return { ok: false, why: `joins in month ${cu.fromMonth}` };
    const rp = cu.repaired;
    if (rp && !rp.exempt && ct && rp.date === period(c) && rp.after === ct.tracksThisMonth) return { ok: false, why: 'repaired this month; misses the next track' };
    if (cu.crew?.kind === 'none' && !cu.pilotId) return { ok: false, why: 'no crew' };
    return { ok: true, why: cu.state !== 'ok' ? DAMAGE_LABEL[cu.state] + ' (unrepaired)' : '' };
}

export interface HireOffer {
    id: string;
    name: string;
    unit: string;
    g: number;
    p: number;
    skill: number;
    edge: number;
    edgeAbilities: number;
    feePerTrack: number;
    feePerKill: number;
    perSuccess: number;
    eligibility: string;
}
const countList = (s: string | undefined) => String(s || '').split(',').filter(x => x.trim()).length;

/** Temp hires offered by the active contract (its own list plus publication pilots). */
export function contractHires(c: Campaign, env: RunnerEnv): HireOffer[] {
    const ct = c.contract && byId(env.pub, 'contracts', c.contract.contractId);
    if (!ct) return [];
    const out: HireOffer[] = (ct.tempHires || []).map(h => ({
        id: h.id, name: h.name, unit: h.unit, g: h.g ?? 4, p: h.p ?? 5, skill: h.skill ?? 4, edge: h.edge ?? 1,
        edgeAbilities: countList(h.edgeAbilities), feePerTrack: Number(h.feePerTrack) || 0, feePerKill: Number(h.feePerKill) || 0,
        perSuccess: 0, eligibility: h.eligibility || '',
    }));
    for (const pid of ct.tempHirePilotIds || []) {
        const pl = byId(env.pub, 'pilots', pid);
        if (!pl) continue;
        out.push({
            id: pl.id, name: pl.name + (pl.callsign ? ` "${pl.callsign}"` : ''), unit: pl.unit, g: pl.g ?? 4, p: pl.p ?? 5, skill: pl.skill ?? 4, edge: pl.edge ?? 1,
            edgeAbilities: (pl.edgeAbilityIds || []).length + countList(pl.spas), feePerTrack: Number(pl.hire?.perTrack) || 0,
            feePerKill: Number(pl.hire?.perKill) || 0, perSuccess: Number(pl.hire?.perSuccess) || 0, eligibility: pl.hire?.eligibility || '',
        });
    }
    return out;
}
/** Hire a contract temp hire: a contract-scoped unit with fixed skills. */
export function addTempHire(c: Campaign, env: RunnerEnv, hireId: string): CampaignUnit {
    const h = contractHires(c, env).find(x => x.id === hireId);
    if (!h) throw new RuleError('Unknown temporary hire.');
    let cu = c.units.find(u => u.tempHire?.hireId === hireId && !isGone(u.state));
    if (!cu) {
        cu = {
            id: uid('cu'), unit: h.unit, state: 'ok', pilotId: '', crew: { kind: 'regular', wounds: 0 }, acquired: c.date, source: 'hire',
            tempHire: {
                hireId, name: h.name, g: h.g, p: h.p, skill: h.skill, edge: h.edge, edgeAbilities: h.edgeAbilities,
                feePerTrack: h.feePerTrack, feePerKill: h.feePerKill, perSuccess: h.perSuccess, wounds: 0, tracks: 0, successes: 0,
            },
        };
        c.units.push(cu);
    }
    return cu;
}

export type CrewInfo =
    | { kind: 'named'; pilot: CampaignPilot }
    | { kind: 'hire'; pilot: FixedPilot }
    | { kind: 'crew'; pilot: FixedPilot }
    | { kind: 'none'; pilot: null };

const CREW_SKILLS: Readonly<Record<'regular' | 'green', [number, number, number]>> = { regular: [4, 5, 4], green: [5, 6, 5] };

/** Who crews a campaign unit in a track. */
export function crewOf(c: Campaign, cu: CampaignUnit, draft: TrackDraft | null): CrewInfo {
    const pid = draft?.pilotFor[cu.id] ?? cu.pilotId;
    const named = pid ? c.pilots.find(p => p.id === pid && p.status === 'active') : undefined;
    if (named) return { kind: 'named', pilot: named };
    if (cu.tempHire) return { kind: 'hire', pilot: { fixed: true, ...cu.tempHire } };
    const cr = cu.crew || { kind: 'regular', wounds: 0 };
    if (cr.kind === 'fixed') return { kind: 'crew', pilot: { fixed: true, named: false, g: cr.g, p: cr.p, skill: cr.skill, edge: 0 } };
    if (cr.kind === 'none') return { kind: 'none', pilot: null };
    const [g, p, skill] = CREW_SKILLS[cr.kind];
    return { kind: 'crew', pilot: { fixed: true, named: false, g, p, skill, edge: 0 } };
}
const isNamedCrew = (x: CrewInfo): x is Extract<CrewInfo, { kind: 'named' | 'hire' }> => x.kind === 'named' || x.kind === 'hire';

/** Unit list per group, for loading the force into MekBay. */
export interface ForceGroup {
    name: string;
    /** `alias` is the pilot's name for named pilots and temporary hires. */
    units: { unit: string; g: number; p: number; skill: number; alias?: string }[];
}

/** Validate a track force and work out the BSP budget. */
export function trackForce(c: Campaign, env: RunnerEnv, d: TrackDraft) {
    const ct = c.contract;
    if (!ct) throw new RuleError('No active contract.');
    const system = d.system;
    const rules = rulesFor(system);
    const mc = !!c.options.mechCommander;
    const tr = byId(env.pub, 'tracks', d.trackId);
    const errors: string[] = [];
    const warns: string[] = [];
    const toftt = !!(d.toftt || ct.toftt);
    const pick = (ids: string[]) => ids.map(id => c.units.find(u => u.id === id)).filter((u): u is CampaignUnit => !!u);
    const own = toftt ? [] : pick(d.unitIds);
    const hires = toftt ? [] : pick(d.hireIds);
    const granted = pick(d.grantedIds);
    const ownV = forceValue(own, system, env.units);
    const hireV = forceValue(hires, system, env.units);
    const limit = tr?.overrides?.ignoreScale ? Infinity : trackLimit(d.scale, system, mc);
    const total = ownV + hireV;
    if (d.scale > ct.scale) errors.push(`Track Scale ${d.scale} is above the contract Scale ${ct.scale}.`);
    if (total > limit) errors.push(`Track force is ${fmt(total)} ${rules.valueLabel}; the limit at Scale ${d.scale} is ${fmt(limit)}.`);
    const units = unitCount([...own, ...hires], env.units);
    if (units > SCALE.unitsPerScale * d.scale) errors.push(`${units} units; the limit at Scale ${d.scale} is ${SCALE.unitsPerScale * d.scale}.`);
    if (hires.length) {
        const under = rules.limits.tempHireUnderPerScale * d.scale;
        if (ownV >= under) errors.push(`Temporary hires need the rest of the force under ${fmt(under)} ${rules.valueLabel}.`);
    }
    for (const cu of own) {
        const a = unitAvailable(c, cu);
        if (!a.ok) errors.push(`${unitName(cu)}: ${a.why}.`);
        else if (a.why) warns.push(`${unitName(cu)}: ${a.why}.`);
    }
    if (repairTimeNow(c) === 'hasty') warns.push('Hasty repairs in force.');
    const crews = [...own, ...hires].map(cu => ({ cu, crew: crewOf(c, cu, d) }));
    for (const x of crews) if (x.crew.kind === 'none') errors.push(`${unitName(x.cu)} has no crew.`);
    const namedCrews = crews.filter(x => isNamedCrew(x.crew));
    if (namedCrews.length > MAX_NAMED) errors.push(`${namedCrews.length} named pilots; no more than ${MAX_NAMED} per track.`);
    const seen = new Set<string>();
    for (const x of namedCrews) {
        if (x.crew.kind !== 'named') continue;
        const p = x.crew.pilot;
        if (seen.has(p.id)) errors.push(`${p.name} is assigned twice.`);
        seen.add(p.id);
        if (p.wounds >= 6) errors.push(`${p.name} has ${p.wounds} wounds.`);
    }
    // Handicap: average over named pilots (battle armor halved), rounded up.
    const hs = namedCrews.map(x => {
        const h = pilotStats(x.crew.pilot!, system, c.system).handicap;
        return isBattleArmor(env.units(x.cu.unit)) ? h / 2 : h;
    });
    const ourH = hs.length ? Math.ceil(hs.reduce((a, b) => a + b, 0) / hs.length) : 0;
    const oppH = Number(d.oppHandicap) || 0;
    const noBsp = !!tr?.overrides?.noBsp;
    let base = noBsp || mc ? 0 : rules.bsp.perScale * d.scale; // R-12: 'Mech Commander drops only the free BSP
    if (d.bspBase != null && !noBsp) base = Number(d.bspBase) || 0;
    const unused = Number.isFinite(limit) ? Math.max(0, limit - total) : 0;
    // Map battles use the formation's share of the BSP pool instead (R-30).
    const conv = noBsp || d.mapBattle ? 0 : Math.min(Math.floor(unused / rules.bsp.valuePerPoint), rules.bsp.convertCapPerScale * d.scale);
    const ourExtra = ourH < oppH ? oppH - ourH : 0;
    const oppExtra = ourH > oppH ? ourH - oppH : 0;
    const bonusLines = d.mapBattle ? effectsOf(c, env.pub, 'bsp') : [];
    const bonus = bonusLines.reduce((s, e) => s + (Number(e.value) || 0), 0);
    const bsp = {
        base, conv, ourExtra, oppExtra, bonus, bonusLines, total: base + conv + ourExtra + bonus, ourH, oppH,
        opforSkill: oppExtra ? { gunnery: Math.floor(oppExtra / 20), piloting: oppExtra % 20 >= 5 ? 1 : 0 } : null,
    };
    const groups: ForceGroup[] = [{
        name: c.name,
        units: crews.filter(x => x.crew.pilot).map(x => {
            const s = pilotStats(x.crew.pilot!, system, c.system);
            const alias = isNamedCrew(x.crew) ? x.crew.pilot.name : undefined;
            return { unit: x.cu.unit, g: s.g, p: s.p, skill: s.skill, ...(alias ? { alias } : {}) };
        }),
    }];
    if (granted.length) groups.push({ name: 'Granted', units: granted.map(cu => ({ unit: cu.unit, g: cu.crew?.g ?? 4, p: cu.crew?.p ?? 5, skill: cu.crew?.skill ?? 4 })) });
    const formations = activeFormations(c, d);
    return { ok: !errors.length, errors, warns, own, hires, granted, ownV, hireV, total, limit, units, crews, bsp, formations, groups };
}

/** The hot spot offering the active contract. */
export function hotSpotOf(c: Campaign, pub: Publication): HotSpot | undefined {
    const id = c.contract?.contractId;
    return id ? pub.hotSpots.find(h => (h.contractIds || []).includes(id)) : undefined;
}
/** Contract-wide conditions and world circumstances as short label / value pairs (publication text, no rules prose). */
export function contractConditions(c: Campaign, pub: Publication): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    const add = (label: string, value: string | undefined) => value && out.push({ label, value });
    const ct = c.contract;
    const k = ct ? byId(pub, 'contracts', ct.contractId) : undefined;
    const hs = ct ? hotSpotOf(c, pub) : undefined;
    if (k) {
        const l = k.location;
        add('Location', [l.planet, l.faction].filter(Boolean).join(' · '));
        add('Disputed by', l.disputedBy);
        add('Terrain', l.terrain);
    }
    for (const f of hs?.facts || []) add(String(f.label || ''), String(f.value || ''));
    const hall = byId(pub, 'halls', ct ? hs?.hallId : c.hallId);
    if (hall) add('Hiring hall', `${hall.name}, support ${hall.support} (repairs ×${SUPPORT_RATING_MOD[hall.support] ?? 1}${ct ? ' between contracts' : ''})`);
    if (ct) {
        add('Rules variant', variantOf(c, pub)?.name);
        const rt = k?.repairTime || (c.options.repairTimeTable ? 'roll' : '');
        add('Repair time', rt === 'roll' ? 'Repair Time Table' : rt ? REPAIR_TIME[rt] : '');
        const now = repairTimeNow(c);
        if (now !== 'standard') add('Now', REPAIR_TIME[now]);
        const ev = trackEventTables(c, pub);
        add('Track events', [ev.complications?.name, ev.world?.name].filter(Boolean).join(' · '));
    }
    return out;
}
/** Tables rolled once per track: the brief's command complications and the hot spot's world table. */
export function trackEventTables(c: Campaign, pub: Publication) {
    const ct = c.contract;
    const cx = ct ? byId(pub, 'briefs', ct.briefId)?.complications : undefined;
    const hs = hotSpotOf(c, pub);
    return {
        cx, complications: cx?.tableId ? byId(pub, 'tables', cx.tableId) : undefined,
        world: hs?.worldTableId ? byId(pub, 'tables', hs.worldTableId) : undefined,
    };
}
/** Roll the per-track event tables once; their effects apply when the track is applied. */
export function rollComplications(c: Campaign, env: RunnerEnv, d: TrackDraft, rollTable: TableRoller) {
    const ct = c.contract;
    if (!ct) return null;
    const { cx, complications: t, world } = trackEventTables(c, env.pub);
    if (!t && !world) return null;
    if (d.complications.length) throw new RuleError('Track events are already rolled for this track.');
    let band: CommandBand = commandBand(ct.terms.command);
    if (c.skipPenalty) band = ({ Independent: 'Liaison', Liaison: 'House', House: 'Integrated', Integrated: 'Integrated', None: 'None' } as const)[band];
    const mod = Number(cx?.mods?.[band.toLowerCase()] ?? 0);
    const opts = { pub: env.pub, system: d.system, scale: d.scale, side: ct.side };
    const log = [...(t ? rollTable(t, { ...opts, modifier: mod }) : []), ...(world ? rollTable(world, { ...opts, modifier: 0 }) : [])];
    d.complications = log.map(l => ({ depth: l.depth, text: l.text, ...(l.effect ? { effect: l.effect } : {}) }));
    return { band, mod, log };
}

/** Effects of a track's rolled events: SP bonus, support shift, blocks and cost change until the next track. */
export function eventEffects(lines: readonly RollLogLine[], scale: number) {
    let sp = 0;
    let supportShift = 0;
    let costPct = 0;
    const block = new Set<BetweenBlock>();
    const labels: string[] = [];
    for (const l of lines) {
        const e = l.effect;
        if (!e) continue;
        if (e.kind === 'amount' && e.currency === 'SP') sp += (Number(e.value) || 0) * (e.perScale ? scale : 1);
        else if (e.kind === 'step' && e.term === 'support' && e.mode === 'shift') supportShift -= Number(e.value) || 0;
        else if (e.kind === 'between') {
            for (const b of e.block || []) if (BETWEEN_BLOCKS.includes(b)) block.add(b);
            costPct += Number(e.costPct) || 0;
        } else continue;
        labels.push(l.text);
    }
    return { sp, supportShift: Math.max(0, supportShift), costPct, block: [...block], labels };
}

// ---------- per-system checks on destroyed units ----------

export interface SalvageCheck {
    roll: number | null;
    tn: number | null;
    ok: boolean;
    text: string;
}
/** Salvage check for a destroyed unit; null when the system has no such check. */
export function destroyedSalvageCheck(system: GameSystem, u: CampaignUnitData, rng: Rng = Math.random): SalvageCheck | null {
    const target = rulesFor(system).destroyedSalvageTarget;
    if (!target) return null;
    const tn = target(u);
    if (tn == null) return { roll: null, tn: null, ok: false, text: 'Not salvageable.' };
    const r = roll('2D6', rng).total;
    return { roll: r, tn, ok: r >= tn, text: `2D6 ${r} vs ${tn}+: ${r >= tn ? 'salvageable (destroyed)' : 'truly destroyed'}` };
}
export interface CrewCheck {
    roll: number;
    result: 'ok' | 'wounded' | 'killed';
    text: string;
}
/** Crew check for a destroyed unit: 2D6 6+ unhurt, 2–3 killed, else one injury. Null when the system has none. */
export function crewCheck(system: GameSystem, rng: Rng = Math.random): CrewCheck | null {
    const rules = rulesFor(system);
    if (!rules.crewCheckOnDestroyed) return null;
    const r = roll('2D6', rng).total;
    const result = r >= 6 ? 'ok' : r <= 3 ? 'killed' : 'wounded';
    return { roll: r, result, text: `2D6 ${r}: ${result === 'ok' ? 'unhurt' : result === 'killed' ? 'killed' : `wounded (${rules.healing.boxesPerInjury} wounds)`}` };
}

// ---------- results ----------

export interface TierInput {
    objectivesDone?: number;
    objectivesTotal?: number;
    vpUs?: number;
    vpThem?: number;
    oppObjectives?: number;
    losses?: boolean;
}
/** Combat pay tier from what happened. */
export function suggestTier(input: TierInput): CombatTier {
    const { objectivesDone = 0, objectivesTotal = 1, vpUs = 0, vpThem = 0, oppObjectives = 0, losses = false } = input;
    if (objectivesDone === 0 && !losses) return 'none';
    if (!(objectivesDone >= 1 && vpUs > vpThem)) return 'unsuccessful';
    if (objectivesTotal > 0 && objectivesDone >= objectivesTotal) return 'allObjectives';
    if (objectivesTotal === 1 && objectivesDone === 1 && oppObjectives === 0) return 'allObjectives';
    return 'success';
}
export const TIER_LABEL: Readonly<Record<CombatTier, string>> = {
    broke: 'Broke contract', none: 'No objectives, no losses', unsuccessful: 'Unsuccessful', success: 'Successful', allObjectives: 'All objectives (or sole objective, opponent none)',
};
export const TIER_SHORT: Readonly<Record<CombatTier, string>> = {
    broke: 'broke', none: 'no pay', unsuccessful: 'unsuccessful', success: 'successful', allObjectives: 'all objectives',
};

export function rearmCost(env: RunnerEnv, d: TrackDraft, fielded: readonly CampaignUnit[], r: TrackResult): number {
    const units = fielded
        .filter(cu => !r.units?.[cu.id]?.noRearm)
        .map(cu => env.units(cu.unit))
        .filter((u): u is CampaignUnitData => !!u);
    return rulesFor(d.system).rearmCost({ units, ammoTons: Number(r.ammoTons) || 0, advancedAmmoTons: Number(r.advTons) || 0, alternateMunitions: Number(r.altMunitions) || 0 });
}

/** Apply a finished track: combat pay, pilot SP, damage, losses, salvage, rearm, script results. */
export function applyTrack(c: Campaign, env: RunnerEnv, r: TrackResult): TrackRecord {
    const d = c.draft;
    const ct = c.contract;
    if (!d || !ct) throw new RuleError('No track in progress.');
    const pub = env.pub;
    const rules = rulesFor(c.system);
    const f = trackForce(c, env, d);
    const tr = byId(pub, 'tracks', d.trackId);
    const v = variantOf(c, pub);
    const ourWin = r.winner === ct.side;
    delete ct.between; // the previous track's window closes with this track
    const sStep = supportStep(c);
    const battleSupport = supportKind(sStep) === 'battle';
    const supportLater = !!v?.o.supportAtEnd;
    const lines: string[] = [];
    const toftt = !!(d.toftt || ct.toftt);

    // 1. Combat pay and pilot allocation (R-3: at most 200 × track Scale, 100 per pilot).
    const fullPay = combatPay(r.tier, d.scale, v);
    const cp = d.skip || d.mapBattle ? 0 : toftt ? Math.floor(fullPay / 2) : fullPay;
    const named = toftt ? [] : f.crews.map(x => x.crew).filter((x): x is Extract<CrewInfo, { kind: 'named' }> => x.kind === 'named').map(x => x.pilot);
    const n = named.length;
    const maxPer = n ? Math.min(100, Math.floor(Math.min(200 * d.scale, cp) / n)) : 0;
    const per = n ? Math.min(maxPer, Math.floor((Number(r.designated) || 0) / n)) : 0;
    const designated = per * n;
    if (d.mapBattle?.final) for (const po of r.payouts || []) if (po.done && po.sp) post(c, { event: `Final battle: ${po.name}`, cover: Number(po.sp), kind: 'combat' });
    if (toftt) {
        // Half combat pay; on success one unit of the force played becomes a purchase option.
        if (cp) post(c, { event: `Combat pay, Taking One For the Team: ${d.name} (${TIER_SHORT[r.tier]}, half)`, cover: cp, kind: 'combat' });
        if ((r.tier === 'success' || r.tier === 'allObjectives') && r.tofttPick) {
            c.tofttOptions.push({ id: uid('to'), unit: r.tofttPick, half: false, from: ct.name, contractRef: ct.id, betweenContracts: !!ct.toftt });
        }
        ct.tofttPlayed = [...(ct.tofttPlayed || []), ...(r.tofttUnits || [])];
    }
    if (!d.skip && !d.mapBattle && !toftt) {
        post(c, { event: `Combat pay: ${d.name} (${TIER_SHORT[r.tier]}, Scale ${d.scale})${designated ? `, ${designated} SP to pilots` : ''}`, cover: cp - designated, kind: 'combat' });
    }
    if (ct.map) for (const p of named) ct.map.fought[p.id] = (ct.map.fought[p.id] || 0) + 1;
    for (const p of named) {
        const pr = r.pilots?.[p.id] || {};
        p.tracks++;
        p.kills += Number(pr.kills) || 0;
        const share = isBAPilot(p) ? Math.floor(per / 2) : per;
        p.earned += share;
        p.unspent += share;
        p.wounds = Math.min(6, p.wounds + (Number(pr.wounds) || 0) + (pr.injured ? rules.healing.boxesPerInjury : 0));
        if (pr.killed || p.wounds >= 6) p.status = 'dead';
    }
    if (r.mvp) {
        const p = named.find(x => x.id === r.mvp);
        if (p && p.status === 'active') {
            const b = isBAPilot(p) ? 10 : 20; // R-4
            p.earned += b;
            p.unspent += b;
            p.mvp++;
            lines.push(`${p.name} is MVP (+${b} SP, R-4).`);
        }
    }

    // 2. Damage; the winner salvages our wrecks.
    const salvageAllowed = (tr?.salvage || 'winner') !== 'none' && !toftt;
    const enemyWon = !!r.winner && r.winner !== ct.side && r.winner !== 'none';
    for (const cu of [...f.own, ...f.hires, ...f.granted]) {
        const ur: UnitOutcome = r.units?.[cu.id] || {};
        const before = cu.state;
        let st = ur.state || cu.state;
        if (enemyWon && salvageAllowed && (st === 'crippled' || st === 'destroyed') && !cu.granted) {
            st = 'lost';
            cu.lostTo = ct.name;
            cu.lostState = ur.state;
        }
        if (st !== before) {
            cu.state = st;
            if (st !== 'ok') cu.damagedInContract = true;
        }
        if (ur.crewKilled && !cu.pilotId) cu.crew = { ...cu.crew, kind: cu.crew?.kind === 'fixed' ? 'fixed' : 'none', dead: true };
        if (ur.crewWounds && !cu.pilotId) cu.crew.wounds = (cu.crew.wounds || 0) + Number(ur.crewWounds);
        if (cu.tempHire) {
            const t = cu.tempHire;
            t.tracks++;
            if (ourWin) t.successes++;
            const kills = Number(ur.kills) || 0;
            const fee = (t.feePerTrack || 0) + kills * (t.feePerKill || 0) + (ourWin ? t.perSuccess || 0 : 0);
            if (fee) post(c, { event: `Temporary hire fee: ${t.name} (${kills} kill${kills === 1 ? '' : 's'})`, cost: fee, kind: 'hire', allowDebt: true, note: 'R-20: WP treated as SP' });
            if (ur.hireWounds) t.wounds = (t.wounds || 0) + Number(ur.hireWounds);
        }
        // Battle-loss compensation: Battle X% pays X% of a truly destroyed unit's purchase price.
        if (cu.state === 'truly' && before !== 'truly' && !cu.granted) {
            const price = purchasePrice(env.units(cu.unit), c.system);
            const comp = Math.round(price * pct('support', sStep));
            if (cu.tempHire) post(c, { event: `Replace lost temporary hire: ${unitName(cu)}`, cost: price, cover: battleSupport && !supportLater ? comp : 0, kind: 'loss', allowDebt: true });
            else if (battleSupport && supportLater) ct.deferredSupport = (ct.deferredSupport || 0) + comp;
            else if (battleSupport) post(c, { event: `Battle-loss compensation: ${unitName(cu)} (${stepLabel('support', sStep)})`, cover: comp, kind: 'loss' });
        }
    }

    // 3. Salvage: our side won and the track allows it.
    let salvValue = 0;
    const pool: { id: string; unit: string; state: CampaignUnit['state']; price: number; track: string }[] = [];
    if (ourWin && salvageAllowed) {
        for (const s of r.salvage || []) {
            const u = env.units(s.unit);
            if (!u) continue;
            const price = rules.sellingPrice(u);
            for (let i = 0; i < (s.qty || 1); i++) {
                salvValue += price;
                pool.push({ id: uid('sv'), unit: s.unit, state: s.state || 'destroyed', price, track: d.name });
            }
        }
        const sal = stepLabel('salvage', ct.terms.salvage);
        if (salvValue) {
            if (sal === 'Exchange') {
                ct.exchangeCredit += Math.floor(salvValue / 4);
                lines.push(`Exchange: ${Math.floor(salvValue / 4)} SP repair credit this month; salvage can't be bought.`);
            } else if (pct('salvage', ct.terms.salvage) > 0) {
                post(c, { event: `Salvage rights ${sal} of ${fmt(salvValue)} SP`, cover: Math.round(salvValue * pct('salvage', ct.terms.salvage)), kind: 'salvage' });
                ct.salvagePool.push(...pool);
            }
        }
    }

    // 4. Bookkeeping.
    ct.buildings += Number(r.buildings) || 0;
    const rec: TrackRecord = {
        id: d.id, contract: ct.name, contractRef: ct.id, date: c.date, month: ct.month, key: d.itemKey, name: d.name, system: d.system, scale: d.scale,
        attacker: d.attacker, side: ct.side, winner: r.winner, tier: r.tier, combatPay: cp, designated, per, mvp: r.mvp || '',
        objectives: `${r.objectivesDone || 0}/${r.objectivesTotal || 0}`, vp: `${r.vpUs || 0}–${r.vpThem || 0}`,
        force: f.crews.map(x => ({ cuId: x.cu.id, unit: x.cu.unit, pilot: x.crew.kind === 'named' ? x.crew.pilot.name : x.crew.kind === 'hire' ? x.crew.pilot.name || 'Hire' : 'Regular crew', state: x.cu.state })),
        bsp: f.bsp, complications: d.complications, salvage: pool.map(p => p.unit), salvValue, notes: [d.notes, ...lines].filter(Boolean).join(' '), skip: !!d.skip, toftt,
    };
    c.tracks.push(rec);
    ct.trackIds.push(rec.id);
    const w: Winner = r.winner || 'none';
    for (const id of [d.itemKey, d.nodeId, ...(d.ancestors || [])]) ct.results[id] = w;
    ct.tracksThisMonth++;
    if (d.skip) {
        ct.skipTaken = true;
        c.skipUsed = true;
        c.skipPenalty = true;
    } else c.skipPenalty = false;
    if (d.mapBattle) resolveMapBattle(c, env, d.mapBattle, w, rec);
    if (v?.o.noDamagePersists) for (const cu of [...f.own, ...f.hires]) if (cu.state !== 'lost') cu.state = 'ok';
    c.draft = null;
    // 5. Repair time before the next track of this month: script step, then contract, then the command's option.
    const plan = monthPlan(c, pub);
    if (nextItem(plan) || plan.waiting) {
        const brief = byId(pub, 'briefs', ct.briefId);
        const node = brief ? [...briefNodes(brief)].find(x => x.id === d.nodeId) : undefined;
        const fixed = (node?.kind === 'track' && node.repairTime) || byId(pub, 'contracts', ct.contractId)?.repairTime || (c.options.repairTimeTable ? 'roll' : '');
        if (fixed === 'roll' || (fixed && Object.hasOwn(REPAIR_TIME, fixed))) {
            const rr = fixed === 'roll' ? roll('2D6', env.rng ?? Math.random).total : 0;
            const kind = fixed === 'roll' ? repairTimeKind(rr) : fixed;
            ct.repairTime = { roll: rr, kind, date: period(c), after: ct.tracksThisMonth };
            rec.repairTime = rr ? `${rr}: ${REPAIR_TIME[kind]}` : REPAIR_TIME[kind];
        }
    }

    // 6. Track events (complications, world): bonus SP, then effects until the next track.
    const ev = toftt ? null : eventEffects(rec.complications, d.scale);
    // ponytail: a negative event amount may go into debt rather than block applying the track.
    if (ev?.sp) post(c, { event: `Track event: ${d.name}`, cover: Math.max(0, ev.sp), cost: Math.max(0, -ev.sp), kind: 'combat', allowDebt: true });
    if (ev && (ev.block.length || ev.costPct || ev.supportShift)) {
        ct.between = { track: ct.trackIds.length, block: ev.block, costPct: ev.costPct, supportShift: ev.supportShift, labels: ev.labels };
    }

    // 7. Rearm: support covers it, unless there is no time or a track event forbids it.
    const rc = toftt ? 0 : Math.ceil(rearmCost(env, d, [...f.own, ...f.hires], r) * betweenCostFactor(c) - 1e-9);
    const noRearm = rc ? betweenBlocked(c, 'rearm') : '';
    if (noRearm) {
        rec.notes = [rec.notes, `${noRearm} Ammunition carries over.`].filter(Boolean).join(' ');
        note(c, `Rearm skipped (${rc} SP): ${noRearm}`, 'rearm');
    } else if (rc) {
        const cover = coverage(c, pub);
        if (supportLater) ct.deferredSupport = (ct.deferredSupport || 0) + Math.round(rc * cover);
        const tons = r.ammoTons || r.advTons ? ` (${r.ammoTons || 0} t${r.advTons ? `, ${r.advTons} t advanced` : ''})` : '';
        post(c, { event: `Rearm${tons}`, cost: rc, cover: supportLater ? 0 : Math.round(rc * cover), kind: 'rearm' });
    }
    return rec;
}

/** Skip a track: only in Warchest Debt, once per debt; counts as a loss, Command −1 band next track. */
export function skipTrack(c: Campaign, env: RunnerEnv): TrackRecord {
    if (c.debt <= 0) throw new RuleError('Skipping a track is only possible while in Warchest Debt.');
    if (c.skipUsed) throw new RuleError('Already skipped a track during this debt.');
    const d = c.draft;
    if (!d || !c.contract) throw new RuleError('No track in progress.');
    d.skip = true;
    return applyTrack(c, env, { winner: otherSide(c.contract.side), tier: 'none', units: {}, pilots: {} });
}

// ---------- map battles ----------

export function mapCtx(c: Campaign, env: RunnerEnv) {
    const ct = c.contract;
    const ms = ct?.map;
    const map = mapOf(c, env.pub);
    if (!ct || !ms || !map) throw new RuleError('This contract has no campaign map.');
    return { ms, map, R: map.rules, ct };
}

export interface BattleStart {
    hex: string;
    from: string;
    groupId: string;
    enemyId: string;
    ourRole: 'attacker' | 'defender';
}
export function startMapBattle(c: Campaign, env: RunnerEnv, b: BattleStart) {
    const { ms, map, ct } = mapCtx(c, env);
    const t = hexType(map, b.hex);
    const hq = b.hex === ms.lzHex || b.hex === ms.enemyLz;
    if (!t.trackId) throw new RuleError(`${t.name} has no scenario track set in the map.`);
    ms.battles++;
    const label = `${t.name}${hexName(map, b.hex) ? ' ' + hexName(map, b.hex) : ''} (${b.hex})`;
    const item: TrackItem = { key: `mb${ms.battles}`, nodeId: `mb${ms.battles}`, ancestors: [], trackId: t.trackId, attacker: b.ourRole === 'attacker' ? ct.side : otherSide(ct.side), label };
    const d = startTrack(c, env, item);
    const g = ms.groups.find(x => x.id === b.groupId);
    d.name = label + ' — ' + (byId(env.pub, 'tracks', t.trackId)?.name || 'track');
    d.mapBattle = { ...b, hq };
    d.unitIds = (g?.unitIds || []).filter(id => {
        const cu = c.units.find(u => u.id === id);
        return !!cu && unitAvailable(c, cu).ok;
    });
    d.bspBase = Number(g?.bsp) || 0;
    // Defensive garrison: unmoved formations within reach may join; an attacked HQ may recall any one formation.
    if (b.ourRole === 'defender') {
        d.mapBattle.helpers = ms.groups.filter(x => x.id !== b.groupId && x.unitIds.length && (
            hq || (g?.garrison && !x.moved && pathLength(map, x.hex, b.hex, groupMove(c, env, x), { blocked: h => !!enemyAt(ms, h) && h !== b.hex }) != null)
        )).map(x => x.id);
        d.mapBattle.helperMode = hq ? 'recall' : 'garrison';
    }
    ms.battle = d.mapBattle;
    return { battle: d.mapBattle };
}
export function addDefenders(c: Campaign, env: RunnerEnv, gid: string): void {
    const { ms } = mapCtx(c, env);
    const d = c.draft;
    const b = d?.mapBattle;
    if (!d || !b?.helpers?.includes(gid)) throw new RuleError('That formation cannot join this defense.');
    if (b.helperMode === 'recall' && (b.joined || []).length) throw new RuleError('Only one formation can be recalled to the HQ.');
    const g = ms.groups.find(x => x.id === gid);
    if (!g) throw new RuleError('No such formation.');
    b.joined = [...(b.joined || []), gid];
    for (const id of g.unitIds) if (!d.unitIds.includes(id)) d.unitIds.push(id);
    d.bspBase = (Number(d.bspBase) || 0) + (Number(g.bsp) || 0);
}
/** A defending formation that has not moved may give up the hex instead of fighting. */
export function withdrawFromBattle(c: Campaign, env: RunnerEnv): void {
    const { ms, map } = mapCtx(c, env);
    const b = c.draft?.mapBattle;
    if (!b || b.ourRole !== 'defender' || b.hq) throw new RuleError('Only a defending formation can withdraw.');
    const g = ms.groups.find(x => x.id === b.groupId);
    if (!g || g.moved) throw new RuleError('A formation that already moved this turn cannot withdraw.');
    const to = withdrawHex(map, ms, b.hex, ms.lzHex);
    if (!to) throw new RuleError('No adjacent hex to withdraw to.');
    g.hex = to;
    g.moved = true;
    const e = ms.enemy.find(x => x.id === b.enemyId);
    if (e) {
        e.hex = b.hex;
        e.moved = true;
    }
    if (isNamed(map, b.hex)) ms.owner[b.hex] = 'them';
    recordMove(ms, 'them', true); // the withdrawal was the defender's move: the attacker moves next
    c.draft = null;
    ms.battle = null;
}
/** Battle outcome on the map: withdraw, else merge, else destroyed (R-34). */
function resolveMapBattle(c: Campaign, env: RunnerEnv, b: MapBattle, winner: Winner, rec: TrackRecord): void {
    const { ms, map, ct, R } = mapCtx(c, env);
    ms.battle = null;
    if (b.final) {
        ms.finalDone = true;
        ct.status = 'ended';
        ct.endDate = c.date;
        ct.supportOverride = null;
        return;
    }
    const ourWin = winner === ct.side;
    const theyWin = winner !== ct.side && winner !== 'none';
    const g = ms.groups.find(x => x.id === b.groupId);
    const e = ms.enemy.find(x => x.id === b.enemyId);
    // An attack on a defender that had not moved uses up the defender's next move: the attacker moves again.
    const defender = b.ourRole === 'attacker' ? e : g;
    recordMove(ms, b.ourRole === 'attacker' ? 'us' : 'them', !!defender && !defender.moved);
    for (const gr of ms.groups) gr.unitIds = gr.unitIds.filter(id => {
        const cu = c.units.find(u => u.id === id);
        return !!cu && !isGone(cu.state);
    });
    const notes: string[] = [];
    if (b.ourRole === 'attacker') {
        if (ourWin) {
            if (isNamed(map, b.hex)) ms.owner[b.hex] = 'us';
            if (g && g.unitIds.length) g.hex = b.hex;
            if (e) {
                const to = withdrawHex(map, ms, b.hex, ms.enemyLz);
                if (to) {
                    e.hex = to;
                    notes.push(`${e.name} withdraws to ${to}.`);
                } else {
                    e.gone = true;
                    notes.push(`${e.name} has nowhere to withdraw and is destroyed.`);
                }
            }
            if (b.hq) ms.ended = { by: 'hq', winner: 'us', text: "Captured the opponent's landing zone." };
        } else notes.push('Attack repulsed; the formation stays where it attacked from.');
    } else if (theyWin) {
        if (isNamed(map, b.hex)) ms.owner[b.hex] = 'them';
        if (e) e.hex = b.hex;
        const defenders = [g, ...(b.joined || []).map(id => ms.groups.find(x => x.id === id))].filter((x): x is NonNullable<typeof x> => !!x && !!x.unitIds.length);
        for (const dg of defenders) {
            const to = withdrawHex(map, ms, b.hex, ms.lzHex);
            if (to) {
                dg.hex = to;
                notes.push(`${dg.name} withdraws to ${to}.`);
                continue;
            }
            const mate = ms.groups.find(x => x !== dg && x.unitIds.length && hexDist(x.hex, b.hex) === 1 && x.unitIds.length + dg.unitIds.length <= R.groupSize);
            if (mate) {
                mate.unitIds.push(...dg.unitIds);
                mate.bsp = (Number(mate.bsp) || 0) + (Number(dg.bsp) || 0);
                dg.unitIds = [];
                notes.push(`${dg.name} merges into ${mate.name}.`);
                continue;
            }
            for (const id of dg.unitIds) {
                const cu = c.units.find(u => u.id === id);
                if (cu) {
                    cu.state = 'lost';
                    cu.lostTo = ct.name;
                }
            }
            notes.push(`${dg.name} has nowhere to go and is destroyed; its units are lost to the opponent (ransom at contract end).`);
            dg.unitIds = [];
        }
        if (b.hq) ms.ended = { by: 'hq', winner: 'them', text: 'The opponent captured your landing zone.' };
    } else {
        if (e && b.from) e.hex = b.from;
        notes.push('Attack repulsed; the attackers fall back.');
    }
    if (g) g.moved = true;
    for (const id of b.joined || []) {
        const jg = ms.groups.find(x => x.id === id);
        if (jg) {
            jg.moved = true;
            if (jg.unitIds.length && !theyWin) jg.hex = b.hex;
        }
    }
    if (e) e.moved = true;
    if (notes.length) rec.notes = [rec.notes, ...notes].filter(Boolean).join(' ');
}
/** The final battle: the map winner defends its HQ with everything left. */
export function startFinalBattle(c: Campaign, env: RunnerEnv): TrackDraft | null {
    const { ms, R, ct } = mapCtx(c, env);
    if (!ms.ended?.winner) throw new RuleError('Decide who won the map first.');
    const F = R.final;
    if (!F?.enabled || !F.trackId) {
        ct.status = 'ended';
        ct.endDate = c.date;
        ms.finalDone = true;
        return null;
    }
    const weDefend = ms.ended.winner === 'us';
    const d = startTrack(c, env, { key: 'final', nodeId: 'final', ancestors: [], trackId: F.trackId, attacker: weDefend ? otherSide(ct.side) : ct.side, label: 'Final battle' });
    d.name = 'Final battle — ' + (byId(env.pub, 'tracks', F.trackId)?.name || 'track');
    d.mapBattle = { final: true, hex: weDefend ? ms.lzHex : ms.enemyLz, ourRole: weDefend ? 'defender' : 'attacker', groupId: '', enemyId: '' };
    d.unitIds = ownUnits(c).filter(cu => unitAvailable(c, cu).ok).map(cu => cu.id);
    d.bspBase = Number(F.bsp) || 0;
    d.payouts = (F.payouts || []).map(p => ({ name: p.name, sp: Number(p.sp) || 0, done: false }));
    if (F.support != null) ct.supportOverride = Number(F.support);
    return d;
}
