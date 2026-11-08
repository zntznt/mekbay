// SPDX-License-Identifier: GPL-3.0-or-later

import { DialogRef } from '@angular/cdk/dialog';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GameSystem } from '../../models/common.model';
import { DialogsService } from '../../services/dialogs.service';
import { CampaignService } from '../campaign.service';
import { DAMAGE_LABEL, isGone, type TrackResult } from '../core/campaign.model';
import { sellQuote } from '../core/market';
import { basePay, ECON, pct, selectableSteps, stepLabel, TERMS, TERM_LABEL, transportCost, type TermKey, type Terms } from '../core/engine';
import { offerSource, playerInputs } from '../core/offer';
import { byId, type CampaignMap } from '../core/publication.model';
import { starterMap } from '../core/map-edit';
import { monthPlan, nextItem, type PlanItem } from '../core/script';
import { availableContracts, contractLimitCheck, fmt, negotiationCheck, ownUnits, period, regularTermOptions } from '../core/runner';
import { hexName, hexType, mapOf } from '../core/hex-map';
import { contractHires, trackEventTables, unitAvailable } from '../core/track';
import { BriefFlowComponent } from './brief-flow.component';
import { CampaignStatusComponent } from './campaign-status.component';
import { downloadText, MapEditorComponent } from './map-editor.component';
import { MapPanelComponent } from './map-panel.component';
import { MarketPanelComponent } from './market-panel.component';
import { PilotsPanelComponent } from './pilots-panel.component';
import { RepairsPanelComponent } from './repairs-panel.component';
import { SalvagePanelComponent } from './salvage-panel.component';
import { TrackResultFormComponent } from './track-result-form.component';

const SYSTEM_LABEL: Record<GameSystem, string> = { [GameSystem.CLASSIC]: 'Classic', [GameSystem.ALPHA_STRIKE]: 'Alpha Strike' };

/** The /campaign page: container that wires the campaign service to its views. */
@Component({
    selector: 'campaign-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [NgTemplateOutlet, BriefFlowComponent, CampaignStatusComponent, MapEditorComponent, MapPanelComponent, MarketPanelComponent, PilotsPanelComponent, RepairsPanelComponent, SalvagePanelComponent, TrackResultFormComponent],
    host: { class: 'fullscreen-dialog-host nopadding fullheight tv-fade' },
    templateUrl: './campaign-dialog.component.html',
    styleUrls: ['./campaign.shared.scss', './campaign-dialog.component.scss'],
})
export class CampaignDialogComponent {
    private readonly dialogRef = inject(DialogRef<void>);
    protected readonly svc = inject(CampaignService);
    private readonly dialogs = inject(DialogsService);

    protected readonly fmt = fmt;
    protected readonly systemLabel = SYSTEM_LABEL;
    protected readonly termKeys = TERMS;
    protected readonly termLabel = TERM_LABEL;
    protected readonly stepLabel = stepLabel;
    protected readonly steps = Object.fromEntries(TERMS.map(t => [t, selectableSteps(t)])) as Record<TermKey, number[]>;

    protected readonly tabs = ['Repairs', 'Pilots', 'Market', 'Salvage'] as const;
    protected readonly tab = signal<(typeof this.tabs)[number]>('Repairs');
    protected readonly search = (q: string) => this.svc.searchUnits(q, 10);

    protected readonly campaignName = signal('');
    protected readonly system = signal<GameSystem | ''>('');
    protected readonly unitQuery = signal('');
    protected readonly suggestions = computed(() => this.svc.searchUnits(this.unitQuery()));
    protected readonly backgroundId = signal('');
    protected readonly factionId = signal('');
    protected readonly parentId = signal('');
    protected readonly parents = computed(() => this.svc.pub()?.factions.find(f => f.id === this.factionId())?.parents ?? []);
    protected readonly contractId = signal('');
    protected readonly terms = signal<Terms | null>(null);
    /** Units left behind for the contract being negotiated (all others are brought). */
    protected readonly leaveBehind = signal<string[]>([]);
    protected readonly signToftt = signal(false);
    protected readonly genInputs = signal<Record<string, string>>({});
    protected readonly tofttBonus = signal('');
    /** Whether the terms being edited are the random contract offer's. */
    protected readonly negotiatingOffer = computed(() => {
        const o = this.svc.campaign()?.offer;
        return !!o && this.contractId() === o.contract.id;
    });

    /** The contract whose terms are being edited: a publication contract or the random offer. */
    private readonly negotiated = computed(() => {
        const c = this.svc.campaign();
        const id = this.contractId();
        if (!c || !id) return null;
        return c.offer?.contract.id === id ? c.offer.contract : this.svc.pub()?.contracts.find(x => x.id === id) ?? null;
    });
    /** What the terms on the table cost in Reputation and pay per month, before signing. */
    protected readonly preview = computed(() => {
        const c = this.svc.campaign();
        const ct = this.negotiated();
        const t = this.terms();
        const env = this.svc.env();
        if (!c || !ct || !t || !env) return null;
        const toftt = this.signToftt();
        const scale = c.scale;
        const jumps = c.offer?.contract.id === ct.id ? c.offer.jumps : null;
        const neg = c.regular || toftt ? null : negotiationCheck(c, ct, t, scale);
        const tc = transportCost(scale, jumps);
        const bring = ownUnits(c).filter(u => !this.leaveBehind().includes(u.id)).map(u => u.id);
        const lim = contractLimitCheck(c, env.units, scale, bring);
        return {
            neg, toftt, map: !!ct.mapId,
            basePay: toftt ? 0 : basePay(scale, t), maint: ECON.maintenancePerScale * scale,
            transport: toftt ? 0 : tc, transportCover: toftt ? 0 : Math.round(tc * pct('transport', t.transport)),
            lim, allowed: !c.regular || !!availableContracts(c, env.pub).find(x => x.ct.id === ct.id)?.allowed,
        };
    });
    protected readonly regularOptions = computed(() => {
        const c = this.svc.campaign();
        return c?.regular ? regularTermOptions(c) : [];
    });
    protected readonly bringable = computed(() => {
        const c = this.svc.campaign();
        return c ? ownUnits(c).map(u => ({ id: u.id, label: u.name || this.svc.unitLabel(u.unit) })) : [];
    });
    /** Generator inputs the player answers before a random offer is rolled, with the tags the generator reacts to. */
    protected readonly offerInputs = computed(() => {
        const c = this.svc.campaign();
        const pub = this.svc.pub();
        const gen = c && pub ? offerSource(c, pub).gen : undefined;
        return playerInputs(gen).map(i => {
            const tags = new Set<string>();
            for (const st of gen!.steps) {
                for (const r of [...(st.dieMods || []), ...(st.shifts || [])]) if (r.from === i.key && r.tag) tags.add(r.tag);
                if (st.when?.from === i.key && st.when.tag) tags.add(st.when.tag);
                if (st.tableFrom === i.key) for (const m of st.tableMap || []) if (m.tag) tags.add(m.tag);
            }
            return { key: i.key, label: i.label || i.key, tags: [...tags].slice(0, 50) };
        });
    });
    /** Contract end nodes the brief has reached with nothing left to play this month. */
    protected readonly endReached = computed(() => {
        const c = this.svc.campaign();
        const pub = this.svc.pub();
        if (!c?.contract || c.contract.status !== 'active' || c.draft || !pub) return null;
        const plan = monthPlan(c, pub);
        if (plan.waiting || nextItem(plan)) return null;
        return plan.ends.find(e => e.scope === 'contract') ?? plan.ends[0] ?? null;
    });
    protected readonly hires = computed(() => {
        const c = this.svc.campaign();
        const env = this.svc.env();
        if (!c?.draft || !env || c.draft.mapBattle) return [];
        const fielded = new Set(c.draft.hireIds.map(id => c.units.find(u => u.id === id)?.tempHire?.hireId));
        return contractHires(c, env).map(h => ({ ...h, on: fielded.has(h.id), label: this.svc.unitLabel(h.unit) }));
    });
    /** Whole contract played for the other side: the bonus half-price unit is picked at close. */
    protected readonly allToftt = computed(() => {
        const c = this.svc.campaign();
        const ct = c?.contract;
        if (!ct) return false;
        const tr = c.tracks.filter(t => t.contractRef === ct.id && !t.skip);
        return !!tr.length && tr.every(t => t.toftt);
    });
    protected readonly background = computed(() => {
        const c = this.svc.campaign();
        const pub = this.svc.pub();
        return c?.setup && pub ? byId(pub, 'backgrounds', c.backgroundId) ?? null : null;
    });

    protected readonly contracts = computed(() => {
        const c = this.svc.campaign();
        const pub = this.svc.pub();
        return c && pub ? availableContracts(c, pub) : [];
    });
    protected readonly monthPending = computed(() => {
        const c = this.svc.campaign();
        return !!c && c.maintPaid !== period(c);
    });
    /** Whether the active contract has per-track event tables to roll. */
    protected readonly hasEvents = computed(() => {
        const c = this.svc.campaign();
        const pub = this.svc.pub();
        if (!c?.contract || !pub) return false;
        const t = trackEventTables(c, pub);
        return !!(t.complications || t.world);
    });
    /** Units that can be picked for the current track. */
    protected readonly trackUnits = computed(() => {
        const c = this.svc.campaign();
        if (!c?.draft) return [];
        const picked = new Set([...c.draft.unitIds, ...c.draft.grantedIds]);
        return c.units
            .filter(u => !u.tempHire && !isGone(u.state))
            .map(u => ({ id: u.id, label: (u.name || this.svc.unitLabel(u.unit)) + (u.granted ? ' (granted)' : ''), picked: picked.has(u.id), why: unitAvailable(c, u).why }));
    });

    constructor() {
        void this.svc.refreshSaves();
    }

    close(): void {
        this.dialogRef.close();
    }

    // ---------- files ----------

    protected async onPublicationFile(e: Event): Promise<void> {
        const text = await readFile(e);
        if (text != null && this.svc.importPublication(text)) this.system.set(this.svc.pub()!.systems[0]);
    }
    protected async onSaveFile(e: Event): Promise<void> {
        const text = await readFile(e);
        if (text != null) await this.svc.importSave(text);
    }
    protected exportSave(): void {
        const c = this.svc.campaign();
        const json = this.svc.exportSave();
        if (!c || !json) return;
        downloadText(`${c.name.replace(/[^\w-]+/g, '_') || 'campaign'}.campaign.json`, json);
    }

    // ---------- map editor ----------

    /** The map open in the editor (from the page's publication, or a new one). */
    protected readonly editingMap = signal<CampaignMap | null>(null);
    protected newMap(): void {
        this.editingMap.set(starterMap());
    }
    protected closeEditor(): void {
        this.editingMap.set(null);
        const pub = this.svc.pub();
        if (pub && !this.system()) this.system.set(pub.systems[0]);
    }

    // ---------- actions ----------

    protected start(): void {
        const s = this.system();
        if (!s) return;
        void this.svc.startCampaign(this.campaignName(), s, { backgroundId: this.backgroundId(), factionId: this.factionId(), parentId: this.factionId() ? this.parentId() : '' }).then(ok => {
            if (!ok) return;
            this.campaignName.set('');
            this.backgroundId.set('');
            this.factionId.set('');
            this.parentId.set('');
        });
    }
    protected addUnit(name: string): void {
        void this.svc.addUnit(name);
        this.unitQuery.set('');
    }
    protected pickContract(id: string): void {
        const ct = this.svc.pub()?.contracts.find(x => x.id === id);
        this.contractId.set(ct ? id : '');
        this.terms.set(ct ? { ...(this.regularOptions()[0]?.terms ?? ct.terms) } : null);
        this.leaveBehind.set([]);
        this.signToftt.set(false);
    }
    protected setLeaveBehind(id: string, bring: boolean): void {
        this.leaveBehind.update(ids => (bring ? ids.filter(x => x !== id) : [...ids, id]));
    }
    protected setGenInput(key: string, v: string): void {
        this.genInputs.update(m => ({ ...m, [key]: v }));
    }
    protected async endFromBrief(text: string): Promise<void> {
        if (await this.dialogs.requestConfirmation(`The mission brief ends the contract here${text ? `: ${text}` : ''}. End the contract now and close it?`, 'End contract', 'warning')) {
            await this.svc.endContractNow(text);
        }
    }
    protected async closeContract(won: boolean): Promise<void> {
        if (await this.svc.closeContract(won, this.allToftt() ? this.tofttBonus() : '')) this.tofttBonus.set('');
    }
    protected setTerm(t: TermKey, v: string): void {
        this.terms.update(x => (x ? { ...x, [t]: Number(v) } : x));
    }
    protected negotiateOffer(): void {
        const o = this.svc.campaign()?.offer;
        this.contractId.set(o ? o.contract.id : '');
        this.terms.set(o ? { ...(this.regularOptions()[0]?.terms ?? o.contract.terms) } : null);
        this.leaveBehind.set([]);
        this.signToftt.set(false);
    }
    protected async sign(): Promise<void> {
        const t = this.terms();
        if (!t) return;
        const left = this.leaveBehind();
        const opts = { toftt: this.signToftt(), bring: left.length ? this.bringable().map(u => u.id).filter(id => !left.includes(id)) : null };
        const ok = this.negotiatingOffer() ? await this.svc.signOffer(t, opts) : await this.svc.signContract(this.contractId(), t, opts);
        if (ok) this.pickContract('');
    }
    protected async declineOffer(): Promise<void> {
        const o = this.svc.campaign()?.offer;
        if (!o || !(await this.dialogs.requestConfirmation(`Decline ${o.contract.name}? The offer is gone for good; the hall's next offer may mean waiting a month.`, 'Decline offer', 'warning'))) return;
        if (await this.svc.declineOffer()) this.pickContract('');
    }
    protected setupTrack(item: PlanItem): void {
        const c = this.svc.campaign()!;
        const ids = c.units.filter(u => !u.tempHire && unitAvailable(c, u).ok).map(u => u.id);
        void this.svc.startTrack(item, ids);
    }
    protected toggleUnit(id: string, on: boolean): void {
        const ids = this.trackUnits().filter(u => (u.id === id ? on : u.picked)).map(u => u.id);
        void this.svc.setTrackUnits(ids);
    }
    protected applyResult(r: TrackResult): void {
        void this.svc.applyTrack(r);
    }
    protected async loadInMekBay(): Promise<void> {
        if (await this.svc.loadForceInMekBay()) this.close();
    }
    protected async removeSave(id: string): Promise<void> {
        const name = this.svc.saves().find(s => s.id === id)?.name || 'this campaign';
        if (await this.dialogs.requestConfirmation(`Delete ${name}? This cannot be undone.`, 'Delete campaign', 'danger')) await this.svc.remove(id);
    }

    // ---------- confirmations for irreversible actions ----------

    protected async confirmSell(cuId: string): Promise<void> {
        const c = this.svc.campaign();
        const env = this.svc.env();
        const cu = c?.units.find(u => u.id === cuId);
        if (!c || !env || !cu) return;
        const name = cu.name || this.svc.unitLabel(cu.unit);
        const msg = c.setup
            ? `Remove ${name} from the starting force?`
            : `Sell ${name} for ${fmt(sellQuote(c, env, cu))} SP${cu.state !== 'ok' ? ` (${DAMAGE_LABEL[cu.state].toLowerCase()}, half price)` : ''}? This cannot be undone.`;
        if (await this.dialogs.requestConfirmation(msg, c.setup ? 'Remove unit' : 'Sell unit', 'warning')) await this.svc.removeUnit(cuId);
    }
    protected async confirmLanding(hex: string): Promise<void> {
        const c = this.svc.campaign();
        const map = c && this.svc.pub() ? mapOf(c, this.svc.pub()!) : undefined;
        if (!map) return;
        const t = hexType(map, hex);
        if (!t.lz) {
            void this.svc.landAt(hex); // let the core say why not
            return;
        }
        const fx = t.lzEffects.length ? ' Its landing effects are rolled now.' : '';
        if (await this.dialogs.requestConfirmation(`Land at ${hexName(map, hex) || t.name} (${hex})? The landing zone cannot be changed.${fx}`, 'Land', 'warning')) await this.svc.landAt(hex);
    }
    protected async confirmReinforce(cuId: string): Promise<void> {
        const c = this.svc.campaign();
        const cu = c?.units.find(u => u.id === cuId);
        const left = c?.contract?.map?.reinforcements ?? 0;
        if (!cu) return;
        const name = cu.name || this.svc.unitLabel(cu.unit);
        if (await this.dialogs.requestConfirmation(`Replace ${name} with a fresh unit? Uses 1 of ${left} strategic reinforcement(s); it arrives at the landing zone next map turn.`, 'Strategic reinforcement', 'warning')) await this.svc.reinforce(cuId);
    }
    protected async setSponsor(id: string): Promise<void> {
        if (!id && !(await this.dialogs.requestConfirmation('End the sponsorship? The sponsor will never deal with you again; undelivered orders are refunded.', 'End sponsorship', 'danger'))) return;
        await this.svc.setSponsor(id);
    }
}

async function readFile(e: Event): Promise<string | null> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    return file ? file.text() : null;
}
