// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { GameSystem } from '../models/common.model';
import { LoadForceEntry } from '../models/load-force-entry.model';
import { DataService } from '../services/data.service';
import { ForceBuilderService } from '../services/force-builder.service';
import { CampaignStorageService, parseCampaignSave, type CampaignSave, type CampaignSummary } from './campaign-storage.service';
import type { Campaign, RunnerEnv, TrackResult } from './core/campaign.model';
import type { Terms } from './core/engine';
import {
    breakSponsor, buyFromSponsor, buySalvage, buyScrapyard, buyTofttOption, buyUnit, collectDelivery, goToHall, healPilot, hirePilot, hireRecruit, joinSponsor,
    reconfigure, repairUnit, rollFactionPurchase, rollPurchaseGate, rollPurchaseTable, scrapyardRoll, sellUnit, trainFormation, trainSca,
    type BuyOptions, type DeliveryZone, type HireInput,
} from './core/market';
import { investSp } from './core/pilots';
import { tableRoller } from './core/roller';
import type { LadderColumn } from './core/rules';
import { migratePublication, newPublication, type CampaignMap, type Publication } from './core/publication.model';
import { withMap, withMapContract } from './core/map-edit';
import {
    acceptContract, beginMonth, campaignChecks, closeContract, endContractNow, endMonth, evaluateVictory, migrateCampaign, newCampaign, payDebt, waitMonth,
    type AcceptInput, type NewCampaignInput,
} from './core/runner';
import { declineOffer, generateOffer, offerSource, signOffer } from './core/offer';
import { briefFlow, loopDecision, makeChoice, monthPlan, nextItem, rollRandomNode, type PlanItem } from './core/script';
import { addDefenders, addTempHire, applyTrack, cancelTrack, rollComplications, startFinalBattle, startTrack, trackForce, withdrawFromBattle } from './core/track';
import {
    addEnemy, addGroup, beginMapTurns, chooseMapOrder, deployArrivals, editGroup, endMapTurn, landAt, moveEnemy, moveGroup, reinforceUnit, removeEnemy, removeGroup,
    rollMapInitiative, setEnemyLz, setMapWinner, stayEnemy, stayGroup,
} from './core/map-play';
import type { MapSide } from './core/campaign.model';
import type { UnitLookup } from './core/units';
import { validate, type Issue } from './core/validate';

function fieldUnits(c: Campaign, ids: string[]): void {
    if (!c.draft) return;
    const granted = new Set(c.units.filter(u => u.granted).map(u => u.id));
    c.draft.unitIds = ids.filter(id => !granted.has(id));
    c.draft.grantedIds = ids.filter(id => granted.has(id));
}

/** A map battle fields a formation's units, granted ones included; file them where the track form expects. */
function splitGranted(c: Campaign): void {
    if (c.draft) fieldUnits(c, [...c.draft.unitIds, ...c.draft.grantedIds]);
}

/**
 * Campaign state for the /campaign page. Holds the open campaign and its
 * publication as signals and runs every action through the pure core on a
 * copy, keeping the copy only when no rule was broken.
 */
@Injectable({ providedIn: 'root' })
export class CampaignService {
    private readonly data = inject(DataService);
    private readonly storage = inject(CampaignStorageService);
    private readonly injector = inject(Injector);

    readonly pub = signal<Publication | null>(null);
    readonly issues = signal<Issue[]>([]);
    readonly campaign = signal<Campaign | null>(null);
    readonly error = signal('');
    readonly saves = signal<CampaignSummary[]>([]);

    readonly units: UnitLookup = name => this.data.getUnitByName(name);
    readonly pubErrors = computed(() => this.issues().filter(i => i.level === 'error'));
    readonly env = computed<RunnerEnv | null>(() => {
        const pub = this.pub();
        return pub ? { pub, units: this.units } : null;
    });
    readonly plan = computed(() => {
        const c = this.campaign();
        const pub = this.pub();
        return c && pub ? monthPlan(c, pub) : null;
    });
    readonly nextTrack = computed(() => {
        const p = this.plan();
        return p ? nextItem(p) : null;
    });
    /** The contract's brief as a tree, focused on the track in play. */
    readonly flow = computed(() => {
        const c = this.campaign();
        const pub = this.pub();
        return c && pub ? briefFlow(c, pub, c.draft?.itemKey) : [];
    });
    /** Why no random contract can be generated now ('' = it can). */
    readonly offerBlocked = computed(() => {
        const c = this.campaign();
        const pub = this.pub();
        return c && pub ? offerSource(c, pub).why : '';
    });
    readonly force = computed(() => {
        const c = this.campaign();
        const env = this.env();
        if (!c?.draft || !env) return null;
        return trackForce(c, env, c.draft);
    });
    readonly checks = computed(() => {
        const c = this.campaign();
        const env = this.env();
        return c && env ? campaignChecks(c, env) : [];
    });
    readonly victory = computed(() => {
        const c = this.campaign();
        const pub = this.pub();
        return c?.contract && pub ? evaluateVictory(c, pub) : null;
    });

    // ---------- publication ----------

    /** Load a publication from JSON text and validate it. */
    importPublication(text: string): boolean {
        try {
            const pub = migratePublication(JSON.parse(text) as Publication);
            this.pub.set(pub);
            this.issues.set(validate(pub, this.units));
            this.error.set('');
            void this.storage.saveDraft(pub);
            return true;
        } catch (e) {
            this.error.set(`Not a publication file: ${(e as Error).message}`);
            return false;
        }
    }

    /**
     * Save an edited map into the page's publication (a new publication when none
     * is loaded); refused while the map has errors. Saved campaigns on the same
     * publication get the map (and the contracts that play on it) for their next
     * load, except campaigns with a contract on this map: they keep the map they
     * started with, so their map state never points at hexes that changed.
     */
    async saveMap(map: CampaignMap, addContract = false): Promise<{ updated: number; kept: number } | null> {
        let pub = withMap(this.pub() ?? newPublication(), map);
        if (addContract) pub = withMapContract(pub, map);
        const issues = validate(pub, this.units);
        if (issues.some(i => i.level === 'error' && i.coll === 'maps' && i.id === map.id)) {
            this.fail('Fix the map errors before saving.');
            return null;
        }
        this.pub.set(pub);
        this.issues.set(issues);
        this.error.set('');
        await this.storage.saveDraft(pub);
        let updated = 0;
        let kept = 0;
        for (const rec of await this.storage.all()) {
            if (rec.pub?.id !== pub.id) continue;
            if (rec.campaign.contract?.map?.mapId === map.id) {
                kept++;
                continue;
            }
            let p = withMap(migratePublication(rec.pub), map);
            const missing = pub.contracts.filter(c => c.mapId === map.id && !p.contracts.some(x => x.id === c.id));
            if (missing.length) p = { ...p, contracts: [...p.contracts, ...missing] };
            await this.storage.put({ ...rec, pub: p });
            updated++;
        }
        return { updated, kept };
    }

    // ---------- campaigns ----------

    async refreshSaves(): Promise<void> {
        this.saves.set(await this.storage.list());
        if (!this.pub()) {
            const draft = await this.storage.loadDraft();
            if (draft && !this.pub()) {
                const pub = migratePublication(draft);
                this.pub.set(pub);
                this.issues.set(validate(pub, this.units));
            }
        }
    }

    /** `opts`: background, regular military faction and parent command, when the publication has them. */
    async startCampaign(name: string, system: GameSystem, opts: Pick<NewCampaignInput, 'backgroundId' | 'factionId' | 'parentId'> = {}): Promise<boolean> {
        const pub = this.pub();
        if (!pub) return this.fail('Import a publication first.');
        if (this.pubErrors().length) return this.fail('Fix the publication errors first.');
        if (!pub.systems.includes(system)) return this.fail('The publication does not support that game system.');
        if (opts.factionId && !pub.factions.some(f => f.id === opts.factionId)) return this.fail('Faction not found.');
        this.campaign.set(newCampaign({ pub, name: name.trim() || undefined, system, ...opts }));
        this.error.set('');
        await this.persist();
        return true;
    }

    async open(id: string): Promise<boolean> {
        const rec = await this.storage.load(id);
        if (!rec) return this.fail('Campaign not found.');
        this.useSave(rec);
        return true;
    }

    async remove(id: string): Promise<void> {
        await this.storage.remove(id);
        if (this.campaign()?.id === id) this.campaign.set(null);
        await this.refreshSaves();
    }

    close(): void {
        this.campaign.set(null);
        this.error.set('');
    }

    exportSave(): string {
        const c = this.campaign();
        const pub = this.pub();
        if (!c || !pub) return '';
        const save: CampaignSave = { kind: 'mekbay-campaign', campaign: c, pub, savedAt: new Date().toISOString() };
        return JSON.stringify(save, null, 2);
    }

    async importSave(text: string): Promise<boolean> {
        let rec: CampaignSave;
        try {
            rec = parseCampaignSave(text);
        } catch (e) {
            return this.fail((e as Error).message);
        }
        this.useSave(rec);
        await this.persist();
        return true;
    }

    private useSave(rec: CampaignSave): void {
        const pub = migratePublication(rec.pub);
        this.pub.set(pub);
        this.issues.set(validate(pub, this.units));
        this.campaign.set(migrateCampaign(rec.campaign));
        this.error.set('');
    }

    /** "Chassis Model" for a MekBay unit name; the name itself when unknown. */
    readonly unitLabel = (name: string): string => {
        const u = this.data.getUnitByName(name);
        return u ? `${u.chassis} ${u.model}`.trim() : name;
    };

    /** A MekBay unit name from either its name or its "Chassis Model" label. */
    resolveUnit(text: string): string | undefined {
        const t = text.trim();
        if (this.data.getUnitByName(t)) return t;
        const q = t.toLowerCase();
        return this.data.getUnits().find(u => `${u.chassis} ${u.model}`.trim().toLowerCase() === q)?.name;
    }

    /** Matching MekBay units for the starting-force picker. */
    searchUnits(query: string, limit = 20): { name: string; label: string }[] {
        const q = query.trim().toLowerCase();
        if (q.length < 2) return [];
        const out: { name: string; label: string }[] = [];
        // ponytail: linear scan of the catalog per keystroke; use the search index if it ever feels slow
        for (const u of this.data.getUnits()) {
            const label = `${u.chassis} ${u.model}`.trim();
            if (label.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)) out.push({ name: u.name, label });
            if (out.length >= limit) break;
        }
        return out;
    }

    // ---------- actions ----------

    /** Other configurations of a unit's chassis (Omni reconfiguration). */
    readonly configsOf = (name: string): { name: string; label: string }[] => {
        const chassis = this.data.getUnitByName(name)?.chassis;
        return chassis ? this.data.getUnits().filter(u => u.chassis === chassis && u.name !== name).map(u => ({ name: u.name, label: `${u.chassis} ${u.model}`.trim() })) : [];
    };

    addUnit(name: string, opts?: BuyOptions) { return this.act((c, env) => void buyUnit(c, env, name, opts)); }
    removeUnit(cuId: string) { return this.act((c, env) => void sellUnit(c, env, cuId)); }
    assignPilot(cuId: string, pilotId: string) {
        return this.act(c => {
            for (const u of c.units) if (pilotId && u.pilotId === pilotId) u.pilotId = '';
            const cu = c.units.find(u => u.id === cuId);
            if (cu) cu.pilotId = pilotId;
        });
    }
    generateOffer(inputs: Record<string, string> = {}) { return this.act((c, env) => void generateOffer(c, env, inputs)); }
    declineOffer() { return this.act(c => declineOffer(c)); }
    /** Signing adds the offered contract and its brief to the publication. */
    signOffer(terms: Terms, opts: Pick<AcceptInput, 'bring' | 'toftt'> = {}) { return this.act((c, env) => void signOffer(c, env, terms, opts), true); }
    signContract(contractId: string, terms: Terms, opts: Pick<AcceptInput, 'bring' | 'toftt'> = {}) {
        return this.act((c, env) => void acceptContract(c, env, { ...opts, contractId, terms }));
    }
    beginMonth() { return this.act((c, env) => beginMonth(c, env)); }
    endMonth() { return this.act((c, env) => (c.contract ? endMonth(c, env) : waitMonth(c, env))); }
    /** `tofttBonus`: half-price unit picked after a whole contract of Taking One For the Team tracks ("Chassis Model" accepted). */
    closeContract(won: boolean, tofttBonus = '') {
        return this.act((c, env) => {
            const unit = tofttBonus ? this.resolveUnit(tofttBonus) : '';
            if (tofttBonus && !unit) throw new Error(`Unknown unit: ${tofttBonus}`);
            closeContract(c, env, { won, tofttBonus: unit || '' });
        });
    }
    /** A contract end node in the brief was reached. */
    endContractNow(reason: string) { return this.act(c => endContractNow(c, reason)); }
    payDebt(amount: number) { return this.act(c => payDebt(c, amount)); }
    rollRandom() {
        return this.act((c, env) => {
            const w = monthPlan(c, env.pub).waiting;
            if (w?.type === 'random') rollRandomNode(c, env, w.key, w.node);
        });
    }
    choose(key: string, idx: number) { return this.act(c => makeChoice(c, key, idx)); }
    loop(key: string, again: boolean) { return this.act(c => loopDecision(c, key, again)); }

    /** Start the track; `unitIds` may mix own and granted units. */
    startTrack(item: PlanItem, unitIds: string[]) {
        return this.act((c, env) => {
            startTrack(c, env, item);
            fieldUnits(c, unitIds);
        });
    }
    /** Roll this track's events (command complications, world table); effects apply with the result. */
    rollEvents() {
        return this.act((c, env) => {
            if (!c.draft) throw new Error('Set up a track first.');
            if (!rollComplications(c, env, c.draft, tableRoller(env.rng))) throw new Error('This contract has no track events to roll.');
        });
    }
    setTrackUnits(unitIds: string[]) { return this.act(c => fieldUnits(c, unitIds)); }
    /** Taking One For the Team: play the opposing force in this track. */
    setTrackToftt(on: boolean) {
        return this.act(c => {
            if (!c.draft || c.draft.mapBattle) throw new Error('Only a contract track can be played for the other side.');
            c.draft.toftt = on;
        });
    }
    /** Field (or drop) one of the contract's temporary hires in this track. */
    setTrackHire(hireId: string, on: boolean) {
        return this.act((c, env) => {
            const d = c.draft;
            if (!d) throw new Error('Set up a track first.');
            if (on) d.hireIds = [...new Set([...d.hireIds, addTempHire(c, env, hireId).id])];
            else d.hireIds = d.hireIds.filter(id => c.units.find(u => u.id === id)?.tempHire?.hireId !== hireId);
        });
    }
    cancelTrack() { return this.act(c => cancelTrack(c)); }
    /** Apply a track result; salvage may name units by "Chassis Model". */
    applyTrack(result: TrackResult) {
        return this.act((c, env) => {
            const f = trackForce(c, env, c.draft!);
            if (!f.ok) throw new Error(f.errors.join(' '));
            const salvage = (result.salvage || []).map(s => {
                const unit = this.resolveUnit(s.unit);
                if (!unit) throw new Error(`Unknown salvage unit: ${s.unit}`);
                return { ...s, unit };
            });
            const named = (s: string) => {
                const unit = this.resolveUnit(s);
                if (!unit) throw new Error(`Unknown unit: ${s}`);
                return unit;
            };
            const tofttUnits = result.tofttUnits?.map(named);
            const tofttPick = result.tofttPick ? named(result.tofttPick) : undefined;
            applyTrack(c, env, { ...result, salvage, tofttUnits, tofttPick });
        });
    }

    /** Put the current track's force into MekBay's force builder. */
    async loadForceInMekBay(): Promise<boolean> {
        const c = this.campaign();
        const f = this.force();
        if (!c?.draft || !f) return this.fail('Set up a track first.');
        const entry = new LoadForceEntry({
            name: `${c.name}: ${c.draft.name}`,
            type: c.draft.system,
            groups: f.groups.map(g => ({
                name: g.name,
                units: g.units.map(u => ({ unit: this.data.getUnitByName(u.unit), alias: u.alias, destroyed: false, gunnery: u.g, piloting: u.p, skill: u.skill })),
            })),
        });
        const created = await this.injector.get(ForceBuilderService).createGeneratedForce(entry);
        return created ? true : this.fail('Could not load the force.');
    }

    // ---------- between tracks ----------

    repair(cuId: string) { return this.act((c, env) => void repairUnit(c, env, cuId)); }
    reconfigure(cuId: string, unit: string) { return this.act((c, env) => reconfigure(c, env, cuId, unit)); }
    heal(pilotId: string) { return this.act((c, env) => healPilot(c, env, pilotId)); }
    investSp(pilotId: string, col: LadderColumn, amount: number) { return this.act(c => investSp(c, pilotId, col, amount)); }
    hire(input: HireInput) { return this.act((c, env) => void hirePilot(c, env, input)); }
    /** Hire a crew through a recruit effect of a held map hex. */
    hireRecruit(cuId: string, idx: number) { return this.act((c, env) => hireRecruit(c, env, cuId, idx)); }
    trainSca(pilotId: string, name: string) { return this.act((c, env) => trainSca(c, env, pilotId, name)); }
    trainFormation(pilotId: string, formation: string) { return this.act((c, env) => trainFormation(c, env, pilotId, formation)); }
    buySalvage(svId: string) { return this.act(c => void buySalvage(c, svId)); }
    declineSalvage(svId: string) {
        return this.act(c => {
            if (c.contract) c.contract.salvagePool = c.contract.salvagePool.filter(s => s.id !== svId);
        });
    }
    searchScrapyard(tableId: string) { return this.act((c, env) => void scrapyardRoll(c, env, tableId, tableRoller(env.rng))); }
    buyScrapyard(breakDeal = false) { return this.act((c, env) => void buyScrapyard(c, env, { breakDeal })); }
    rollPurchaseGate() { return this.act((c, env) => void rollPurchaseGate(c, env)); }
    rollPurchaseTable() { return this.act((c, env) => void rollPurchaseTable(c, env, tableRoller(env.rng))); }
    rollFactionPurchase(mod = 0, subMod = 0) { return this.act((c, env) => void rollFactionPurchase(c, env, tableRoller(env.rng), { mod, subMod })); }
    buyToftt(id: string) { return this.act((c, env) => void buyTofttOption(c, env, id)); }
    /** Join a sponsor; an empty id ends the current sponsorship for good. */
    setSponsor(id: string) { return this.act((c, env) => (id ? joinSponsor(c, env, id) : breakSponsor(c, env, 'ended by the command'))); }
    orderFromSponsor(unit: string, zone: DeliveryZone) { return this.act((c, env) => void buyFromSponsor(c, env, unit, zone)); }
    goToHall(hallId: string) { return this.act((c, env) => goToHall(c, env, hallId)); }
    collectDelivery(cuId: string) { return this.act(c => collectDelivery(c, cuId)); }

    // ---------- campaign map ----------

    landAt(hex: string) { return this.act((c, env) => landAt(c, env, hex)); }
    setEnemyLz(hex: string) { return this.act((c, env) => setEnemyLz(c, env, hex)); }
    addGroup(name = '') { return this.act((c, env) => void addGroup(c, env, name, [])); }
    editGroup(gid: string, patch: { name?: string; unitIds?: string[]; bsp?: number }) { return this.act((c, env) => editGroup(c, env, gid, patch)); }
    removeGroup(gid: string) { return this.act((c, env) => removeGroup(c, env, gid)); }
    beginMapTurns() { return this.act((c, env) => beginMapTurns(c, env)); }
    /** Move a formation; moving onto the opponent sets up the battle as the current track. */
    moveGroup(gid: string, to: string) { return this.act((c, env) => (moveGroup(c, env, gid, to), splitGranted(c))); }
    stayGroup(gid: string) { return this.act((c, env) => stayGroup(c, env, gid)); }
    stayEnemy(eid: string) { return this.act((c, env) => stayEnemy(c, env, eid)); }
    rollMapInitiative() { return this.act((c, env) => void rollMapInitiative(c, env)); }
    chooseMapOrder(first: MapSide) { return this.act((c, env) => chooseMapOrder(c, env, first)); }
    /** Units waiting at the landing zone form a new formation there, or join `gid` at the landing zone. */
    deployArrivals(unitIds: string[], gid = '') { return this.act((c, env) => void deployArrivals(c, env, unitIds, gid)); }
    addEnemy(name: string) { return this.act((c, env) => addEnemy(c, env, name)); }
    moveEnemy(eid: string, to: string) { return this.act((c, env) => (moveEnemy(c, env, eid, to), splitGranted(c))); }
    removeEnemy(eid: string) { return this.act((c, env) => removeEnemy(c, env, eid)); }
    reinforce(cuId: string) { return this.act((c, env) => reinforceUnit(c, env, cuId)); }
    endMapTurn(designated: number) { return this.act((c, env) => void endMapTurn(c, env, { designated })); }
    setMapWinner(side: MapSide) { return this.act((c, env) => setMapWinner(c, env, side)); }
    startFinalBattle() {
        return this.act((c, env) => {
            startFinalBattle(c, env);
            splitGranted(c);
        });
    }
    joinDefense(gid: string) { return this.act((c, env) => (addDefenders(c, env, gid), splitGranted(c))); }
    withdrawFromBattle() { return this.act((c, env) => withdrawFromBattle(c, env)); }

    // ---------- plumbing ----------

    private fail(msg: string): false {
        this.error.set(msg);
        return false;
    }

    /** Run a core action on a copy (of the publication too, when it changes it); keep it only if nothing threw, then save. */
    private async act(fn: (c: Campaign, env: RunnerEnv) => void, changesPub = false): Promise<boolean> {
        const cur = this.campaign();
        const base = this.env();
        if (!cur || !base) return this.fail('No campaign open.');
        const c = structuredClone(cur);
        const env = changesPub ? { ...base, pub: structuredClone(base.pub) } : base;
        try {
            fn(c, env);
        } catch (e) {
            return this.fail((e as Error).message);
        }
        if (changesPub) this.pub.set(env.pub);
        this.campaign.set(c);
        this.error.set('');
        await this.persist();
        return true;
    }

    private async persist(): Promise<void> {
        const c = this.campaign();
        const pub = this.pub();
        if (!c || !pub) return;
        await this.storage.save(c, pub);
        await this.refreshSaves();
    }
}
