// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DAMAGE_LABEL, type Campaign } from '../core/campaign.model';
import { stepLabel } from '../core/engine';
import { fmt } from '../core/runner';

/** Salvage from the last track and the contract's salvage pool. */
@Component({
    selector: 'salvage-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        @if (last(); as t) {
            <p>{{ t.name }}: {{ t.salvage.length ? t.salvage.length + ' unit(s), ' + fmt(t.salvValue) + ' SP' : 'no salvage' }}</p>
        }
        @if (contract(); as ct) {
            <div class="cp-stats">
                <div><span class="cp-label">Salvage rights</span>{{ rights() }}</div>
                @if (ct.exchangeCredit) { <div><span class="cp-label">Repair credit</span>{{ fmt(ct.exchangeCredit) }} SP</div> }
            </div>
            <table class="cp-table">
                <thead><tr><th>Unit</th><th>State</th><th>Track</th><th class="num">Price</th><th></th></tr></thead>
                <tbody>
                    @for (s of ct.salvagePool; track s.id) {
                        <tr>
                            <td>{{ labelOf()(s.unit) }}</td><td>{{ damage[s.state] }}</td><td>{{ s.track }}</td><td class="num">{{ fmt(s.price) }}</td>
                            <td>
                                <div class="cp-row">
                                    <button type="button" class="bt-button tiny" [disabled]="exchange()" (click)="buy.emit(s.id)">Keep</button>
                                    <button type="button" class="bt-button tiny" (click)="decline.emit(s.id)">Decline</button>
                                </div>
                            </td>
                        </tr>
                    } @empty { <tr><td colspan="5">No salvage on offer.</td></tr> }
                </tbody>
            </table>
        } @else {
            <p class="cp-muted">No contract.</p>
        }
    `,
})
export class SalvagePanelComponent {
    readonly campaign = input.required<Campaign>();
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly buy = output<string>();
    readonly decline = output<string>();

    protected readonly fmt = fmt;
    protected readonly damage = DAMAGE_LABEL;
    protected readonly contract = computed(() => this.campaign().contract);
    protected readonly rights = computed(() => {
        const ct = this.contract();
        return ct ? stepLabel('salvage', ct.terms.salvage) : '';
    });
    protected readonly exchange = computed(() => this.rights() === 'Exchange');
    /** The last track of the current contract. */
    protected readonly last = computed(() => {
        const c = this.campaign();
        const t = c.tracks.at(-1);
        return t && t.contractRef === c.contract?.id ? t : null;
    });
}
