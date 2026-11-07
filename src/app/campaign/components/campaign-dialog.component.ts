// SPDX-License-Identifier: GPL-3.0-or-later

import { DialogRef } from '@angular/cdk/dialog';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GameSystem } from '../../models/common.model';
import { DialogsService } from '../../services/dialogs.service';
import { CampaignService } from '../campaign.service';
import { DAMAGE_LABEL, isGone, type TrackResult } from '../core/campaign.model';
import { sellQuote } from '../core/market';
import { selectableSteps, stepLabel, TERMS, TERM_LABEL, type TermKey, type Terms } from '../core/engine';
import type { PlanItem } from '../core/script';
import { availableContracts, fmt, period } from '../core/runner';
import { trackEventTables, unitAvailable } from '../core/track';
import { BriefFlowComponent } from './brief-flow.component';
import { CampaignStatusComponent } from './campaign-status.component';
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
    imports: [NgTemplateOutlet, BriefFlowComponent, CampaignStatusComponent, MarketPanelComponent, PilotsPanelComponent, RepairsPanelComponent, SalvagePanelComponent, TrackResultFormComponent],
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
    protected readonly contractId = signal('');
    protected readonly terms = signal<Terms | null>(null);
    /** Whether the terms being edited are the random contract offer's. */
    protected readonly negotiatingOffer = computed(() => {
        const o = this.svc.campaign()?.offer;
        return !!o && this.contractId() === o.contract.id;
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
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${c.name.replace(/[^\w-]+/g, '_') || 'campaign'}.campaign.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    // ---------- actions ----------

    protected start(): void {
        const s = this.system();
        if (s) void this.svc.startCampaign(this.campaignName(), s);
    }
    protected addUnit(name: string): void {
        void this.svc.addUnit(name);
        this.unitQuery.set('');
    }
    protected pickContract(id: string): void {
        const ct = this.svc.pub()?.contracts.find(x => x.id === id);
        this.contractId.set(ct ? id : '');
        this.terms.set(ct ? { ...ct.terms } : null);
    }
    protected setTerm(t: TermKey, v: string): void {
        this.terms.update(x => (x ? { ...x, [t]: Number(v) } : x));
    }
    protected negotiateOffer(): void {
        const o = this.svc.campaign()?.offer;
        this.contractId.set(o ? o.contract.id : '');
        this.terms.set(o ? { ...o.contract.terms } : null);
    }
    protected async sign(): Promise<void> {
        const t = this.terms();
        if (!t) return;
        const ok = this.negotiatingOffer() ? await this.svc.signOffer(t) : await this.svc.signContract(this.contractId(), t);
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
