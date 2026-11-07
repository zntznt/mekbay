// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DAMAGE_LABEL, type Campaign } from '../core/campaign.model';
import { stepLabel, TERMS, TERM_LABEL } from '../core/engine';
import type { Publication } from '../core/publication.model';
import { betweenNow, fmt } from '../core/runner';
import { contractConditions } from '../core/track';
import { hexIncome } from '../core/hex-map';

/** Read-only campaign state: money, contract, units, pilots and ledger. */
@Component({
    selector: 'campaign-status',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        @let c = campaign();
        <section class="cp-card">
            <div class="cp-stats">
                <div><span class="cp-label">Date</span>{{ c.date }}</div>
                <div><span class="cp-label">Warchest</span>{{ fmt(c.warchest) }} SP</div>
                @if (c.debt) { <div class="cp-danger"><span class="cp-label">Debt</span>{{ fmt(c.debt) }} SP</div> }
                <div><span class="cp-label">Reputation</span>{{ c.reputation }}</div>
                <div><span class="cp-label">Scale</span>{{ c.scale }}</div>
                <div><span class="cp-label">System</span>{{ c.system === 'as' ? 'Alpha Strike' : 'Classic' }}</div>
            </div>
            @if (c.contract; as ct) {
                <h3>{{ ct.name }} <small>{{ ct.employer }} · month {{ ct.month }}/{{ ct.length }} · side {{ ct.side }}{{ ct.status === 'ended' ? ' · ended' : '' }}</small></h3>
                <div class="cp-terms">
                    @for (t of terms; track t) { <span><span class="cp-label">{{ termLabel[t] }}</span>{{ step(t, ct.terms[t]) }}</span> }
                </div>
                @if (mapStatus(); as m) {
                    <div class="cp-terms">
                        <span><span class="cp-label">Map</span>{{ m.phase }}</span>
                        <span><span class="cp-label">Income / turn</span>{{ fmt(m.income) }} SP</span>
                        <span><span class="cp-label">Hexes held</span>{{ m.us }} (opponent {{ m.them }})</span>
                        <span><span class="cp-label">Reinforcements</span>{{ m.reinforcements }}</span>
                        @if (m.hold) { <span><span class="cp-label">Strategic points</span>{{ m.hold }}</span> }
                    </div>
                }
            } @else {
                <h3>No contract</h3>
            }
            @if (conditions().length) {
                <div class="cp-terms">
                    @for (x of conditions(); track $index) { <span><span class="cp-label">{{ x.label }}</span>{{ x.value }}</span> }
                </div>
            }
            @if (events().length) {
                <h4>Track events in force</h4>
                <ul class="cp-list">@for (e of events(); track $index) { <li class="cp-warn">{{ e }}</li> }</ul>
            }
        </section>

        <section class="cp-card">
            <h3>Units</h3>
            <table class="cp-table">
                <thead><tr><th>Unit</th><th>State</th><th>Pilot</th>@if (c.setup) {<th></th>}</tr></thead>
                <tbody>
                    @for (u of c.units; track u.id) {
                        <tr>
                            <td>{{ u.name || labelOf()(u.unit) }}@if (u.granted) { <small> ({{ u.grantedName || 'granted' }})</small> }</td>
                            <td>{{ damage[u.state] }}</td>
                            <td>
                                @if (!u.granted && !u.tempHire) {
                                    <select class="bt-select" [value]="u.pilotId" (change)="assignPilot.emit({ cuId: u.id, pilotId: $any($event.target).value })">
                                        <option value="">Regular crew</option>
                                        @for (p of activePilots(); track p.id) { <option [value]="p.id" [selected]="p.id === u.pilotId">{{ p.name }}</option> }
                                    </select>
                                } @else { Fixed crew }
                            </td>
                            @if (c.setup) { <td><button type="button" class="bt-button tiny" (click)="removeUnit.emit(u.id)">Remove</button></td> }
                        </tr>
                    } @empty { <tr><td colspan="4">No units yet.</td></tr> }
                </tbody>
            </table>
        </section>

        <section class="cp-card">
            <h3>Pilots</h3>
            <table class="cp-table">
                <thead><tr><th>Name</th><th>Status</th><th>Wounds</th><th>SP earned</th><th>SP unspent</th><th>Tracks</th><th>Kills</th></tr></thead>
                <tbody>
                    @for (p of c.pilots; track p.id) {
                        <tr [class.cp-muted]="p.status === 'dead'">
                            <td>{{ p.name }}</td><td>{{ p.status }}</td><td>{{ p.wounds }}</td><td>{{ p.earned }}</td><td>{{ p.unspent }}</td><td>{{ p.tracks }}</td><td>{{ p.kills }}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </section>

        <section class="cp-card">
            <h3>Ledger</h3>
            <table class="cp-table">
                <thead><tr><th>Date</th><th>Event</th><th class="num">Cost</th><th class="num">Cover</th><th class="num">Net</th><th class="num">Warchest</th></tr></thead>
                <tbody>
                    @for (e of ledger(); track e.id) {
                        <tr>
                            <td>{{ e.date }}</td><td>{{ e.event }}</td>
                            <td class="num">{{ e.cost ? fmt(e.cost) : '' }}</td><td class="num">{{ e.cover ? fmt(e.cover) : '' }}</td>
                            <td class="num" [class.cp-danger]="e.net < 0">{{ e.net ? fmt(e.net) : '' }}</td><td class="num">{{ fmt(e.warchest) }}</td>
                        </tr>
                    }
                </tbody>
            </table>
        </section>
    `,
})
export class CampaignStatusComponent {
    readonly campaign = input.required<Campaign>();
    /** Display label for a MekBay unit name. */
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly pub = input<Publication | null>(null);
    readonly assignPilot = output<{ cuId: string; pilotId: string }>();
    readonly removeUnit = output<string>();

    protected readonly fmt = fmt;
    protected readonly damage = DAMAGE_LABEL;
    protected readonly terms = TERMS;
    protected readonly termLabel = TERM_LABEL;
    protected readonly step = stepLabel;
    protected readonly conditions = computed(() => {
        const pub = this.pub();
        return pub ? contractConditions(this.campaign(), pub) : [];
    });
    protected readonly mapStatus = computed(() => {
        const c = this.campaign();
        const pub = this.pub();
        const ms = c.contract?.map;
        if (!ms || !pub) return null;
        const held = Object.values(ms.owner);
        return {
            phase: ms.phase === 'turns' ? `turn ${c.contract!.month}/${c.contract!.length}` : ms.phase,
            income: hexIncome(c, pub).total,
            us: held.filter(x => x === 'us').length,
            them: held.filter(x => x === 'them').length,
            reinforcements: ms.reinforcements,
            hold: ms.hold.us ? `held ${ms.hold.us} turn(s)` : ms.hold.them ? `opponent ${ms.hold.them} turn(s)` : '',
        };
    });
    protected readonly events = computed(() => betweenNow(this.campaign())?.labels ?? []);
    protected readonly activePilots = computed(() => this.campaign().pilots.filter(p => p.status === 'active'));
    /** Newest first. */
    // ponytail: core writes MekBay unit ids (e.g. BMLocust_LCT1V) into ledger text; ids carry
    // an underscore, so relabel those tokens here instead of giving core a unit lookup.
    protected readonly ledger = computed(() => {
        const label = this.labelOf();
        return [...this.campaign().ledger].reverse().map(e => ({ ...e, event: e.event.replace(/\b[A-Za-z][\w-]*_[\w-]+/g, t => label(t)) }));
    });
}
