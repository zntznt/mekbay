// SPDX-License-Identifier: GPL-3.0-or-later

import {
    DAMAGE_LABEL, RuleError, isGone,
    type Campaign, type CampaignUnit, type CrewKind, type PurchaseState, type RollLogLine, type RunnerEnv, type ScrapCondition,
    type ScrapyardOffer, type TableRoller, type UnitSource,
} from './campaign.model';
import { roll } from './dice';
import { SUPPORT_RATING_MOD, purchasePrice, sponsorPrice, stepLabel } from './engine';
import { effectsOf, mapOf, type ActiveEffect } from './hex-map';
import { MAX_NAMED, newPilot } from './pilots';
import { byId, uid, type Sponsor } from './publication.model';
import { REPAIR_TONNAGE_MULT, rulesFor, type RepairLevel } from './rules';
import {
    addMonths, coverage, factionOf, note, parentOf, period, post, REPAIR_TIME, repairTimeNow, requireNoDebt, supportStep, trackFreeMonth,
    unitName, variantOf,
} from './runner';
import { isBattleArmor, isVehicle, isOmni, unitGroup, type CampaignUnitData } from './units';

/** Flat SP costs. */
export const COSTS = {
    hireNamed: 150, hireRegular: 100, hireGreen: 0, hireTrooper: 20, heal: 30, healTrooper: 10,
    formationCommander: 500, changeFormation: 250, sca: [250, 500, 750], replaceSca: 250,
} as const;

const isRepairLevel = (s: string): s is RepairLevel => s in REPAIR_TONNAGE_MULT;

const newUnit = (c: Campaign, unit: string, source: UnitSource, state: CampaignUnit['state'] = 'ok', crew: CrewKind = 'none'): CampaignUnit => ({
    id: uid('cu'), unit, state, pilotId: '', crew: { kind: crew, wounds: 0 }, acquired: c.date, source,
});

// ---------- repairs ----------

export interface RepairQuote {
    level: RepairLevel;
    cost: number;
    cover: number;
    credit: number;
    deferred: number;
    net: number;
    notes: string[];
    /** Ready for the next track despite being repaired this month. */
    exempt: boolean;
    blocked?: string;
}
export function repairQuote(c: Campaign, env: RunnerEnv, cu: CampaignUnit): RepairQuote | null {
    const u = env.units(cu.unit);
    const lvl = cu.state;
    if (!u || !isRepairLevel(lvl) || cu.scrapCheck || cu.delivery) return null;
    const rtk = repairTimeNow(c);
    if (rtk === 'hasty' && lvl !== 'armor') {
        return { blocked: 'Hasty repairs: only armor repairs and rearming before the next track.', level: lvl, cost: 0, cover: 0, credit: 0, deferred: 0, net: 0, notes: [], exempt: false };
    }
    const base = rulesFor(c.system).baseRepairCost(u, lvl, { sizeRepairs: !!c.options.asSizeRepairs });
    let cost = base.cost;
    const notes = [base.note];
    if (u.techBase === 'Clan') {
        cost *= 1.5;
        notes.push('Clan ×1.5');
    }
    if (isVehicle(u) || isBattleArmor(u)) {
        cost *= 0.5;
        notes.push(isBattleArmor(u) ? 'battle armor ½' : 'vehicle ½');
    }
    if (c.modifiers?.mechBay) {
        cost *= 0.8;
        notes.push("'Mech Bay −20%");
    }
    const hall = !c.contract && c.hallId ? byId(env.pub, 'halls', c.hallId) : undefined;
    if (hall) {
        const k = SUPPORT_RATING_MOD[hall.support] ?? 1;
        if (k !== 1) {
            cost *= k;
            notes.push(`${hall.name} support ${hall.support} ×${k}`);
        }
    }
    cost = Math.ceil(cost - 1e-9); // R-16: round up at the end
    let cover = 0;
    let deferred = 0;
    const ct = c.contract;
    if (ct && cu.damagedInContract) {
        const would = Math.round(cost * coverage(c, env.pub));
        if (variantOf(c, env.pub)?.o.supportAtEnd) {
            deferred = would;
            if (would) notes.push(`${would} support deferred to contract end`);
        } else {
            cover = would;
            if (cover) notes.push(`${stepLabel('support', supportStep(c))}${ct.map && effectsOf(c, env.pub, 'supportPct').length ? ' + map' : ''} covers ${cover}`);
        }
    }
    const credit = ct ? Math.min(ct.exchangeCredit || 0, cost - cover) : 0;
    if (credit) notes.push(`Exchange credit ${credit}`);
    const omni = isOmni(u) || !!cu.omni;
    const exempt = lvl === 'armor' || (lvl === 'structure' && omni) || (rtk === 'extended' && lvl === 'structure') || (rtk === 'all' && lvl !== 'destroyed');
    if (rtk !== 'standard' && exempt && lvl !== 'armor') notes.push(`${REPAIR_TIME[rtk]}: ready for the next track`);
    return { level: lvl, cost, cover: cover + credit, credit, deferred, net: cost - cover - credit, notes, exempt };
}
export function repairUnit(c: Campaign, env: RunnerEnv, cuId: string): RepairQuote {
    const cu = c.units.find(u => u.id === cuId);
    if (!cu) throw new RuleError('Unit not found.');
    if (cu.granted) throw new RuleError('Granted units are repaired by the employer.');
    const q = repairQuote(c, env, cu);
    if (!q) throw new RuleError(`${unitName(cu)} can't be repaired (${cu.scrapCheck ? 'scrapyard check pending' : cu.delivery ? 'not delivered yet' : DAMAGE_LABEL[cu.state]}).`);
    if (q.blocked) throw new RuleError(q.blocked);
    post(c, { event: `Repair ${unitName(cu)} (${DAMAGE_LABEL[q.level]})`, cost: q.cost, cover: q.cover, kind: 'repair', note: q.notes.join('; ') });
    if (c.contract) {
        if (q.credit) c.contract.exchangeCredit -= q.credit;
        if (q.deferred) c.contract.deferredSupport = (c.contract.deferredSupport || 0) + q.deferred;
    }
    cu.state = 'ok';
    cu.damagedInContract = false;
    cu.repaired = { date: period(c), after: c.contract?.tracksThisMonth ?? 0, exempt: q.exempt };
    return q;
}
export function reconfigure(c: Campaign, env: RunnerEnv, cuId: string, newUnit: string): void {
    const cu = c.units.find(u => u.id === cuId);
    if (!cu) throw new RuleError('Unit not found.');
    if (cu.state !== 'ok') throw new RuleError('An Omni unit must be fully repaired before reconfiguring.');
    const u = env.units(cu.unit);
    const nu = env.units(newUnit);
    if (!u || !nu || nu.chassis !== u.chassis) throw new RuleError('Pick a configuration of the same chassis.');
    post(c, { event: `Reconfigure ${u.name} → ${nu.model}`, cost: rulesFor(c.system).reconfigureCost(u, { sizeRepairs: !!c.options.asSizeRepairs }), kind: 'repair' });
    cu.unit = newUnit;
    cu.omni = true;
}

// ---------- healing ----------

/** Wound boxes a pilot can heal right now. */
export function healLimit(c: Campaign, pl: Campaign['pilots'][number], env: RunnerEnv | null = null): number {
    const h = rulesFor(c.system).healing;
    const ct = c.contract;
    const done = pl.healMonth === period(c) ? pl.healedMonth : 0;
    const extra = ct?.map && env ? effectsOf(c, env.pub, 'heal').reduce((s, e) => s + (Number(e.value) || 0), 0) : 0;
    const perMonth = h.boxesPerMonth + extra - done;
    const rtk = repairTimeNow(c);
    if (rtk === 'hasty') return 0;
    let between = Infinity;
    if (h.boxesBetweenTracks != null && rtk !== 'all' && ct && ct.tracksThisMonth > 0) {
        between = pl.healedGap === ct.tracksThisMonth ? 0 : h.boxesBetweenTracks;
    }
    return Math.max(0, Math.min(perMonth, between, pl.wounds));
}
export function healPilot(c: Campaign, env: RunnerEnv, pid: string, boxes = 1): void {
    const pl = c.pilots.find(p => p.id === pid);
    if (!pl || pl.status !== 'active') throw new RuleError('Pilot not found.');
    const injury = rulesFor(c.system).healing.boxesPerInjury;
    const lim = healLimit(c, pl, env);
    const whole = Math.min(injury, pl.wounds);
    // Systems that count injuries heal one whole injury at a time.
    if (injury > 1 && boxes < injury && lim >= whole) boxes = whole;
    if (boxes > lim) throw new RuleError(repairTimeNow(c) === 'hasty' ? 'Hasty repairs: no healing before the next track.' : `${pl.name} can heal ${lim} more wound(s) now.`);
    if (injury > 1) boxes = Math.max(boxes, whole);
    const cost = (pl.unitType === 'Battle Armor' ? COSTS.healTrooper : COSTS.heal) * boxes;
    const ct = c.contract;
    const would = ct ? Math.round(cost * coverage(c, env.pub)) : 0;
    const later = !!ct && !!variantOf(c, env.pub)?.o.supportAtEnd;
    if (later && would && ct) ct.deferredSupport = (ct.deferredSupport || 0) + would;
    post(c, { event: `Heal ${pl.name} (${boxes} wound${boxes > 1 ? 's' : ''})`, cost, cover: later ? 0 : would, kind: 'heal' });
    pl.wounds -= boxes;
    if (pl.healMonth !== period(c)) {
        pl.healMonth = period(c);
        pl.healedMonth = 0;
    }
    pl.healedMonth += boxes;
    if (ct) pl.healedGap = ct.tracksThisMonth;
}

// ---------- hiring and training ----------

export function mapRecruit(c: Campaign, env: RunnerEnv): { needed: boolean; options: ActiveEffect[] } | null {
    if (!c.contract?.map) return null;
    return { needed: !!mapOf(c, env.pub)?.rules.recruitNeedsHex, options: effectsOf(c, env.pub, 'recruit') };
}
export interface HireInput {
    kind: 'named' | 'regular' | 'green';
    name?: string;
    /** Unit the crew is for (regular / green). */
    cuId?: string;
}
export function hirePilot(c: Campaign, env: RunnerEnv, input: HireInput) {
    const { kind, name = 'New pilot', cuId = '' } = input;
    const mr = mapRecruit(c, env);
    if (mr?.needed && kind !== 'green' && !mr.options.length) throw new RuleError('Recruiting MechWarriors needs a hex that allows it.');
    if (kind === 'named') {
        requireNoDebt(c, 'Hiring');
        if (c.pilots.filter(p => p.status === 'active').length >= MAX_NAMED) throw new RuleError(`No more than ${MAX_NAMED} named pilots.`);
        post(c, { event: `Hire named pilot ${name}`, cost: COSTS.hireNamed, kind: 'hire' });
        const p = newPilot(name, 0);
        c.pilots.push(p);
        return p;
    }
    const cu = c.units.find(u => u.id === cuId);
    if (!cu) throw new RuleError('Choose the unit the crew is for.');
    if (kind === 'regular') {
        requireNoDebt(c, 'Hiring');
        post(c, { event: `Hire regular crew for ${unitName(cu)}`, cost: COSTS.hireRegular, kind: 'hire' });
    } else note(c, `Green crew for ${unitName(cu)} (free)`, 'hire');
    cu.crew = { kind, wounds: 0 };
    return cu;
}
/** Hire a crew through a map recruit effect. */
export function hireRecruit(c: Campaign, env: RunnerEnv, cuId: string, idx: number): void {
    requireNoDebt(c, 'Hiring');
    const opt = mapRecruit(c, env)?.options[idx];
    const cu = c.units.find(u => u.id === cuId);
    if (!opt || !cu) throw new RuleError('Choose a recruit option and a unit.');
    const g = Number(opt.g);
    const p = Number(opt.p);
    const skill = Number(opt.skill);
    post(c, { event: `Recruit ${rulesFor(c.system).skillLabel({ gunnery: g, piloting: p, skill })} crew for ${unitName(cu)}`, cost: Number(opt.cost) || 0, kind: 'hire' });
    cu.crew = { kind: 'fixed', g, p, skill, wounds: 0, name: 'Recruited' };
}
/** Formation training: one named pilot per track-less month. */
export function trainFormation(c: Campaign, env: RunnerEnv, pid: string, formation: string): void {
    requireNoDebt(c, 'Training');
    if (!formation) throw new RuleError('Name the formation type.');
    if (!trackFreeMonth(c, env.pub)) throw new RuleError('Formation training needs a month without a track.');
    if (c.trainedMonth === period(c)) throw new RuleError('One named pilot trains in a formation per track-less month.');
    const pl = c.pilots.find(p => p.id === pid && p.status === 'active');
    if (!pl) throw new RuleError('Pilot not found.');
    const cost = pl.formation ? COSTS.changeFormation : COSTS.formationCommander;
    post(c, { event: `${pl.name} trains as ${formation} commander${pl.formation ? ` (was ${pl.formation})` : ''}`, cost, kind: 'training' });
    pl.formation = formation;
    c.trainedMonth = period(c);
}
/** Special Command Ability training: escalating cost per pilot, track-less month (R-15). */
export function trainSca(c: Campaign, env: RunnerEnv, pid: string, name: string): void {
    requireNoDebt(c, 'Training');
    if (!trackFreeMonth(c, env.pub)) throw new RuleError('Command training needs a month without a track (R-15).');
    const pl = c.pilots.find(p => p.id === pid);
    if (!pl) throw new RuleError('Pilot not found.');
    let cost: number = COSTS.sca[Math.min(pl.scas.length, 2)];
    const par = parentOf(c, env.pub);
    if (par && (par.scaIds || []).some(id => byId(env.pub, 'scas', id)?.name === name)) cost = Math.ceil(cost / 2);
    post(c, { event: `${pl.name} learns ${name}`, cost, kind: 'training' });
    pl.scas.push(name);
}

// ---------- sponsors ----------

export function sponsorOf(c: Campaign, env: RunnerEnv): Sponsor | undefined {
    return c.sponsorId ? byId(env.pub, 'sponsors', c.sponsorId) : undefined;
}
export function inSponsorScope(sp: Sponsor | undefined, u: CampaignUnitData | undefined): boolean {
    return !!sp && !!u && (sp.scope || []).includes(unitGroup(u));
}
/** Breaking the agreement: permanent ban; pending deliveries refunded. */
export function breakSponsor(c: Campaign, env: RunnerEnv, reason = 'agreement broken'): void {
    const sp = sponsorOf(c, env);
    if (!sp) return;
    for (const cu of c.units.filter(u => u.delivery)) post(c, { event: `Refund: undelivered ${unitName(cu)} (${sp.name})`, cover: cu.delivery!.paid || 0, kind: 'sale' });
    c.units = c.units.filter(u => !u.delivery);
    c.sponsorBanned.push(sp.id);
    c.sponsorId = '';
    note(c, `Sponsorship with ${sp.name} ended: ${reason}`);
}
export function joinSponsor(c: Campaign, env: RunnerEnv, id: string): void {
    if (c.sponsorBanned.includes(id)) throw new RuleError('That sponsor will never deal with you again.');
    if (c.sponsorId && c.sponsorId !== id) breakSponsor(c, env, 'joined another sponsor');
    c.sponsorId = id;
}
export function sponsorQuote(c: Campaign, env: RunnerEnv, u: CampaignUnitData): { price: number; sponsor: Sponsor } | null {
    const sp = sponsorOf(c, env);
    if (!sp || !inSponsorScope(sp, u)) return null;
    return { price: sponsorPrice(u, c.system, Number(sp.discountPct) || 0), sponsor: sp };
}
export type DeliveryZone = 'territory' | 'near' | 'far';
/** Buy through the sponsor: discounted, delivered later (far: collect in person). */
export function buyFromSponsor(c: Campaign, env: RunnerEnv, unit: string, zone: DeliveryZone = 'territory'): CampaignUnit {
    requireNoDebt(c, 'Purchasing');
    const sp = sponsorOf(c, env);
    const u = env.units(unit);
    if (!sp || !u) throw new RuleError('No sponsor or unknown unit.');
    if (!inSponsorScope(sp, u)) throw new RuleError(`${sp.name} doesn't sell that unit type.`);
    const price = sponsorPrice(u, c.system, Number(sp.discountPct) || 0);
    post(c, { event: `Purchase ${u.name} from ${sp.name} (−${sp.discountPct}%)`, cost: price, kind: 'purchase' });
    const months = zone === 'territory' ? Number(sp.deliveryInTerritory) || 1 : zone === 'near' ? Number(sp.deliveryNear) || 2 : null;
    const cu = newUnit(c, unit, 'sponsor');
    cu.delivery = months ? { due: addMonths(c.date, months), paid: price } : { collect: true, paid: price };
    c.units.push(cu);
    return cu;
}
export function collectDelivery(c: Campaign, cuId: string): void {
    const cu = c.units.find(u => u.id === cuId);
    if (cu?.delivery) {
        note(c, `Collected ${unitName(cu)}`);
        delete cu.delivery;
    }
}

// ---------- buying and selling ----------

export interface BuyOptions {
    price?: number | null;
    source?: UnitSource;
    note?: string;
    /** Accept breaking a sponsorship that covers this unit type. */
    breakDeal?: boolean;
}
export function buyUnit(c: Campaign, env: RunnerEnv, unit: string, opts: BuyOptions = {}): CampaignUnit {
    const { price = null, source = 'purchase', note: n = '', breakDeal = false } = opts;
    const u = env.units(unit);
    if (!u) throw new RuleError('Unknown unit.');
    if (c.setup) {
        const cu = newUnit(c, unit, 'start', 'ok', 'regular');
        c.units.push(cu);
        return cu;
    }
    requireNoDebt(c, 'Purchasing');
    const sp = sponsorOf(c, env);
    if (sp && inSponsorScope(sp, u)) {
        if (!breakDeal) throw new RuleError(`Buying ${u.type === 'Mek' ? "a 'Mech" : 'that unit'} outside ${sp.name} breaks the sponsorship.`);
        breakSponsor(c, env, `bought ${u.name} elsewhere`);
    }
    let premium = 0;
    if (c.contract?.map) {
        const pe = effectsOf(c, env.pub, 'purchase').filter(e => (e.types || ['Mek']).includes(u.type));
        if (u.type === 'Mek' && mapOf(c, env.pub)?.rules.purchaseNeedsHex && !pe.length) throw new RuleError("'Mech purchases need a hex that allows them.");
        if (pe.length) {
            const rng = env.rng ?? Math.random;
            premium = Math.min(...pe.map(e => (e.die ? roll(e.die, rng).total * (Number(e.mult) || 10) : Number(e.pct) || 0)));
        }
    }
    if (c.regular && source === 'contract') premium += 50; // regular military pay +50% for contract purchase options
    const cost = Math.ceil((price ?? purchasePrice(u, c.system)) * (1 + premium / 100));
    post(c, { event: `Purchase ${u.name}${n ? ` (${n})` : ''}${premium ? ` (+${premium}% premium)` : ''}`, cost, kind: 'purchase' });
    const cu = newUnit(c, unit, source);
    if (c.contract?.map) cu.arrives = c.contract.month + 1; // deploys at the landing zone next map turn
    c.units.push(cu);
    return cu;
}
/** Taking One For the Team purchase options: standard price, or half for the whole-contract bonus. */
export function buyTofttOption(c: Campaign, env: RunnerEnv, id: string): CampaignUnit {
    requireNoDebt(c, 'Purchasing');
    const o = c.tofttOptions.find(x => x.id === id);
    if (!o) throw new RuleError('Option not found.');
    const u = env.units(o.unit);
    const price = Math.ceil(purchasePrice(u, c.system) * (o.half ? 0.5 : 1));
    post(c, { event: `Purchase ${u?.name || o.unit} (Taking One For the Team option${o.half ? ', half price' : ''})`, cost: price, kind: 'purchase' });
    c.tofttOptions = c.tofttOptions.filter(x => x !== o);
    const cu = newUnit(c, o.unit, 'toftt');
    if (c.contract?.map) cu.arrives = c.contract.month + 1;
    c.units.push(cu);
    return cu;
}
export function sellQuote(c: Campaign, env: RunnerEnv, cu: CampaignUnit): number {
    const base = rulesFor(c.system).sellingPrice(env.units(cu.unit));
    return cu.state === 'ok' ? base : Math.floor(base / 2);
}
export function sellUnit(c: Campaign, env: RunnerEnv, cuId: string): number {
    const cu = c.units.find(u => u.id === cuId);
    if (!cu || cu.tempHire || cu.granted) throw new RuleError('Only your own units can be sold.');
    if (isGone(cu.state)) throw new RuleError(`${unitName(cu)} is ${DAMAGE_LABEL[cu.state].toLowerCase()}.`);
    if (c.setup) {
        c.units = c.units.filter(u => u !== cu);
        return 0;
    }
    const v = sellQuote(c, env, cu);
    post(c, { event: `Sell ${unitName(cu)}${cu.state !== 'ok' ? ' (unrepaired, half price)' : ''}`, cover: v, kind: 'sale' });
    c.units = c.units.filter(u => u !== cu);
    return v;
}
export function buySalvage(c: Campaign, svId: string): CampaignUnit {
    const ct = c.contract;
    const s = ct?.salvagePool.find(x => x.id === svId);
    if (!ct || !s) throw new RuleError('Salvage not found.');
    if (stepLabel('salvage', ct.terms.salvage) === 'Exchange') throw new RuleError('Exchange salvage cannot be bought.');
    requireNoDebt(c, 'Purchasing salvage');
    post(c, { event: `Buy salvage ${s.unit}`, cost: s.price, kind: 'purchase' });
    ct.salvagePool = ct.salvagePool.filter(x => x !== s);
    const cu = newUnit(c, s.unit, 'salvage', s.state || 'destroyed');
    c.units.push(cu);
    return cu;
}

// ---------- scrapyard: once per month, on top of other purchases ----------

/** [min, max, condition, label] on 2D6. */
export const SCRAP_CONDITION: readonly [number, number, ScrapCondition, string][] = [
    [2, 4, 'impossible', 'Nearly impossible'], [5, 9, 'destroyed', 'Destroyed'], [10, 12, 'crippled', 'Crippled'],
];
const firstUnit = (log: readonly RollLogLine[]): string => log.find(l => l.units?.length)?.units?.[0]?.unit || '';

export function scrapyardRoll(c: Campaign, env: RunnerEnv, tableId: string, rollTable: TableRoller): ScrapyardOffer {
    if (c.scrapyard?.date === period(c)) throw new RuleError('The scrapyard can be searched once per month.');
    const t = byId(env.pub, 'tables', tableId);
    if (!t) throw new RuleError('No scrapyard table.');
    const log = rollTable(t, { pub: env.pub, system: c.system, modifier: 0 });
    const unit = firstUnit(log);
    const cr = roll('2D6', env.rng ?? Math.random).total;
    const cond = SCRAP_CONDITION.find(([a, b]) => cr >= a && cr <= b)!;
    c.scrapyard = { date: period(c), unit, cond: cond[2], condRoll: cr, price: rulesFor(c.system).sellingPrice(env.units(unit)), log: log.map(l => ({ depth: l.depth, text: l.text })), bought: false };
    return c.scrapyard;
}
export function buyScrapyard(c: Campaign, env: RunnerEnv, { breakDeal = false } = {}): CampaignUnit {
    const s = c.scrapyard;
    if (!s || s.date !== period(c) || s.bought || !s.unit) throw new RuleError('Nothing on offer at the scrapyard this month.');
    requireNoDebt(c, 'Purchasing');
    const u = env.units(s.unit);
    const sp = sponsorOf(c, env);
    if (sp && inSponsorScope(sp, u)) {
        if (!breakDeal) throw new RuleError(`Buying ${s.unit} outside ${sp.name} breaks the sponsorship.`);
        breakSponsor(c, env, `bought ${s.unit} at a scrapyard`);
    }
    const label = SCRAP_CONDITION.find(x => x[2] === s.cond)?.[3] ?? s.cond;
    post(c, { event: `Scrapyard: ${s.unit} (${label}, salvage price)`, cost: s.price, kind: 'purchase' });
    const cu = newUnit(c, s.unit, 'scrapyard', s.cond === 'crippled' ? 'crippled' : 'destroyed');
    if (s.cond === 'impossible') cu.scrapCheck = { due: addMonths(c.date, 1) };
    c.units.push(cu);
    s.bought = true;
    return cu;
}

// ---------- faction and contract purchase rolls ----------

const keepLog = (log: readonly RollLogLine[]): RollLogLine[] =>
    log.map(l => ({ depth: l.depth, text: l.text, units: l.units ? l.units.map(x => ({ unit: x.unit })) : null }));

/** Faction Purchase Options: one roll per month; from rank 2 the roll may be adjusted by ±1 (R-35). */
export function rollFactionPurchase(c: Campaign, env: RunnerEnv, rollTable: TableRoller, { mod = 0, subMod = 0 } = {}): RollLogLine[] {
    const f = factionOf(c, env.pub);
    const t = f?.purchaseTableId ? byId(env.pub, 'tables', f.purchaseTableId) : undefined;
    if (!t || !c.regular) throw new RuleError('Your faction has no purchase table.');
    if (c.factionRolls[period(c)]) throw new RuleError('One Faction Purchase Options roll per month.');
    if ((mod || subMod) && (c.regular.rank || 1) < 2) throw new RuleError('Adjusting the roll needs rank 2.');
    if (Math.abs(mod) > 1 || Math.abs(subMod) > 1) throw new RuleError('Adjust by ±1 at most.');
    const log = rollTable(t, { pub: env.pub, system: c.system, modifier: mod, subModifier: subMod });
    c.factionRolls[period(c)] = keepLog(log);
    return c.factionRolls[period(c)];
}
export function purchasePeriod(c: Campaign): string {
    const ct = c.contract;
    return ct?.purchaseCfg?.freq === 'track' ? `track-${ct.trackIds.length}` : period(c);
}
/** Contract purchase availability: the gate roll sets how many table rolls this period. */
export function rollPurchaseGate(c: Campaign, env: RunnerEnv): PurchaseState {
    const ct = c.contract;
    const k = ct ? byId(env.pub, 'contracts', ct.contractId)?.purchase : undefined;
    if (!ct || !k?.tableId) throw new RuleError('This contract offers no purchase table.');
    ct.purchaseCfg = { freq: k.freq || 'month' };
    ct.purchase ||= {};
    const key = purchasePeriod(c);
    if (ct.purchase[key]) throw new RuleError(`Purchase availability already rolled this ${k.freq === 'track' ? 'track' : 'month'}.`);
    const r = roll(k.gateDie || '2D6', env.rng ?? Math.random).total;
    const g = [...(k.gate || [])].sort((a, b) => b.min - a.min).find(x => r >= x.min);
    ct.purchase[key] = { roll: r, count: g ? g.count : 0, logs: [] };
    return ct.purchase[key];
}
export function rollPurchaseTable(c: Campaign, env: RunnerEnv, rollTable: TableRoller): PurchaseState {
    const ct = c.contract;
    const k = ct ? byId(env.pub, 'contracts', ct.contractId)?.purchase : undefined;
    const st = ct?.purchase?.[purchasePeriod(c)];
    if (!st || !k) throw new RuleError('Roll purchase availability first.');
    if (st.logs.length >= st.count) throw new RuleError(`No purchase rolls left (${st.count} this period).`);
    const t = byId(env.pub, 'tables', k.tableId);
    if (!t) throw new RuleError('This contract offers no purchase table.');
    st.logs.push(keepLog(rollTable(t, { pub: env.pub, system: c.system, modifier: 0 })));
    return st;
}
