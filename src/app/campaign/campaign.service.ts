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
    breakSponsor, buyFromSponsor, buySalvage, buyScrapyard, buyUnit, collectDelivery, goToHall, healPilot, hirePilot, joinSponsor, reconfigure,
    repairUnit, rollPurchaseGate, rollPurchaseTable, scrapyardRoll, sellUnit, trainFormation, trainSca,
    type BuyOptions, type DeliveryZone, type HireInput,
} from './core/market';
import { investSp } from './core/pilots';
import { tableRoller } from './core/roller';
import type { LadderColumn } from './core/rules';
import { migratePublication, type Publication } from './core/publication.model';
import {
    acceptContract, beginMonth, campaignChecks, closeContract, endMonth, evaluateVictory, migrateCampaign, newCampaign, waitMonth,
} from './core/runner';
import { declineOffer, generateOffer, offerSource, signOffer } from './core/offer';
import { briefFlow, loopDecision, makeChoice, monthPlan, nextItem, rollRandomNode, type PlanItem } from './core/script';
import { applyTrack, cancelTrack, rollComplications, startTrack, trackForce } from './core/track';
import type { UnitLookup } from './core/units';
import { validate, type Issue } from './core/validate';

function fieldUnits(c: Campaign, ids: string[]): void {
    if (!c.draft) return;
    const granted = new Set(c.units.filter(u => u.granted).map(u => u.id));
    c.draft.unitIds = ids.filter(id => !granted.has(id));
    c.draft.grantedIds = ids.filter(id => granted.has(id));
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
            return true;
        } catch (e) {
            this.error.set(`Not a publication file: ${(e as Error).message}`);
            return false;
        }
    }

    // ---------- campaigns ----------

    async refreshSaves(): Promise<void> {
        this.saves.set(await this.storage.list());
    }

    async startCampaign(name: string, system: GameSystem): Promise<boolean> {
        const pub = this.pub();
        if (!pub) return this.fail('Import a publication first.');
        if (this.pubErrors().length) return this.fail('Fix the publication errors first.');
        if (!pub.systems.includes(system)) return this.fail('The publication does not support that game system.');
        this.campaign.set(newCampaign({ pub, name: name.trim() || undefined, system }));
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
    generateOffer() { return this.act((c, env) => void generateOffer(c, env)); }
    declineOffer() { return this.act(c => declineOffer(c)); }
    /** Signing adds the offered contract and its brief to the publication. */
    signOffer(terms: Terms) { return this.act((c, env) => void signOffer(c, env, terms), true); }
    signContract(contractId: string, terms: Terms) { return this.act((c, env) => void acceptContract(c, env, { contractId, terms })); }
    beginMonth() { return this.act((c, env) => beginMonth(c, env)); }
    endMonth() { return this.act((c, env) => (c.contract ? endMonth(c, env) : waitMonth(c, env))); }
    closeContract(won: boolean) { return this.act((c, env) => closeContract(c, env, { won })); }
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
            applyTrack(c, env, { ...result, salvage });
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
    /** Join a sponsor; an empty id ends the current sponsorship for good. */
    setSponsor(id: string) { return this.act((c, env) => (id ? joinSponsor(c, env, id) : breakSponsor(c, env, 'ended by the command'))); }
    orderFromSponsor(unit: string, zone: DeliveryZone) { return this.act((c, env) => void buyFromSponsor(c, env, unit, zone)); }
    goToHall(hallId: string) { return this.act((c, env) => goToHall(c, env, hallId)); }
    collectDelivery(cuId: string) { return this.act(c => collectDelivery(c, cuId)); }

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
