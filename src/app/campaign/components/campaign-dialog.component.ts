// SPDX-License-Identifier: GPL-3.0-or-later

import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GameSystem } from '../../models/common.model';
import { CampaignService } from '../campaign.service';
import { isGone, type TrackResult } from '../core/campaign.model';
import { selectableSteps, stepLabel, TERMS, TERM_LABEL, type TermKey, type Terms } from '../core/engine';
import type { PlanItem } from '../core/script';
import { availableContracts, fmt, period } from '../core/runner';
import { unitAvailable } from '../core/track';
import { CampaignStatusComponent } from './campaign-status.component';
import { TrackResultFormComponent } from './track-result-form.component';

const SYSTEM_LABEL: Record<GameSystem, string> = { [GameSystem.CLASSIC]: 'Classic', [GameSystem.ALPHA_STRIKE]: 'Alpha Strike' };

/** The /campaign page: container that wires the campaign service to its views. */
@Component({
    selector: 'campaign-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [CampaignStatusComponent, TrackResultFormComponent],
    host: { class: 'fullscreen-dialog-host nopadding fullheight tv-fade' },
    templateUrl: './campaign-dialog.component.html',
    styleUrls: ['./campaign.shared.scss', './campaign-dialog.component.scss'],
})
export class CampaignDialogComponent {
    private readonly dialogRef = inject(DialogRef<void>);
    protected readonly svc = inject(CampaignService);

    protected readonly fmt = fmt;
    protected readonly systemLabel = SYSTEM_LABEL;
    protected readonly termKeys = TERMS;
    protected readonly termLabel = TERM_LABEL;
    protected readonly stepLabel = stepLabel;
    protected readonly steps = Object.fromEntries(TERMS.map(t => [t, selectableSteps(t)])) as Record<TermKey, number[]>;

    protected readonly campaignName = signal('');
    protected readonly system = signal<GameSystem | ''>('');
    protected readonly unitQuery = signal('');
    protected readonly suggestions = computed(() => this.svc.searchUnits(this.unitQuery()));
    protected readonly contractId = signal('');
    protected readonly terms = signal<Terms | null>(null);

    protected readonly contracts = computed(() => {
        const c = this.svc.campaign();
        const pub = this.svc.pub();
        return c && pub ? availableContracts(c, pub) : [];
    });
    protected readonly monthPending = computed(() => {
        const c = this.svc.campaign();
        return !!c && c.maintPaid !== period(c);
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

    protected trackName(id: string): string {
        return this.svc.pub()?.tracks.find(t => t.id === id)?.name || 'Track';
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
    protected async sign(): Promise<void> {
        const t = this.terms();
        if (t && (await this.svc.signContract(this.contractId(), t))) this.pickContract('');
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
        await this.svc.remove(id);
    }
}

async function readFile(e: Event): Promise<string | null> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    return file ? file.text() : null;
}
