// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DAMAGE_LABEL, isGone, type Campaign, type RunnerEnv } from '../core/campaign.model';
import { repairQuote } from '../core/market';
import { fmt, REPAIR_TIME, repairTimeNow } from '../core/runner';
import { isOmni } from '../core/units';

/** Repairs and Omni reconfiguration for the command's own units. */
@Component({
    selector: 'repairs-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        @if (repairTime(); as rt) { <p class="cp-warn">{{ rt }}</p> }
        <table class="cp-table">
            <thead><tr><th>Unit</th><th>State</th><th class="num">Cost</th><th class="num">Covered</th><th class="num">Pay</th><th></th></tr></thead>
            <tbody>
                @for (r of rows(); track r.id) {
                    <tr>
                        <td>{{ r.label }}</td>
                        <td>{{ damage[r.state] }}</td>
                        @if (r.quote; as q) {
                            @if (q.blocked) {
                                <td colspan="4" class="cp-muted">{{ q.blocked }}</td>
                            } @else {
                                <td class="num">{{ fmt(q.cost) }}</td>
                                <td class="num">{{ q.cover ? fmt(q.cover) : '' }}</td>
                                <td class="num">{{ fmt(q.net) }}</td>
                                <td><button type="button" class="bt-button tiny" [title]="q.notes.join('; ')" (click)="repair.emit(r.id)">Repair</button></td>
                            }
                        } @else if (r.configs.length) {
                            <td colspan="4">
                                <select class="bt-select" (change)="reconfigure.emit({ cuId: r.id, unit: $any($event.target).value })">
                                    <option value="">Reconfigure…</option>
                                    @for (o of r.configs; track o.name) { <option [value]="o.name">{{ o.label }}</option> }
                                </select>
                            </td>
                        } @else {
                            <td colspan="4" class="cp-muted">{{ r.why }}</td>
                        }
                    </tr>
                } @empty { <tr><td colspan="6">Nothing to repair.</td></tr> }
            </tbody>
        </table>
    `,
})
export class RepairsPanelComponent {
    readonly campaign = input.required<Campaign>();
    readonly env = input.required<RunnerEnv>();
    readonly labelOf = input<(unit: string) => string>(u => u);
    /** Other configurations of the same chassis. */
    readonly configsOf = input<(unit: string) => { name: string; label: string }[]>(() => []);
    readonly repair = output<string>();
    readonly reconfigure = output<{ cuId: string; unit: string }>();

    protected readonly fmt = fmt;
    protected readonly damage = DAMAGE_LABEL;

    protected readonly repairTime = computed(() => {
        const k = repairTimeNow(this.campaign());
        return k === 'standard' ? '' : REPAIR_TIME[k];
    });
    /** Damaged units with their quote, plus operational Omnis that can reconfigure. */
    protected readonly rows = computed(() => {
        const c = this.campaign();
        const env = this.env();
        return c.units
            .filter(u => !u.granted && !u.tempHire && !isGone(u.state))
            .map(cu => {
                const omni = isOmni(env.units(cu.unit)) || !!cu.omni;
                return {
                    id: cu.id, state: cu.state, label: cu.name || this.labelOf()(cu.unit),
                    quote: cu.state === 'ok' ? null : repairQuote(c, env, cu),
                    configs: cu.state === 'ok' && omni ? this.configsOf()(cu.unit) : [],
                    why: cu.delivery ? 'Awaiting delivery' : cu.scrapCheck ? 'Scrapyard check pending' : '',
                };
            })
            .filter(r => r.state !== 'ok' || r.configs.length);
    });
}
