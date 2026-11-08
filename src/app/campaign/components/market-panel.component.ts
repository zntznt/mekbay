// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { isGone, type Campaign, type RunnerEnv, type UnitSource } from '../core/campaign.model';
import { purchasePrice } from '../core/engine';
import { inSponsorScope, purchasePeriod, SCRAP_CONDITION, sellQuote, sponsorOf, sponsorQuote, type DeliveryZone } from '../core/market';
import { byId } from '../core/publication.model';
import { factionOf, fmt, period } from '../core/runner';

export interface BuyRequest {
    unit: string;
    breakDeal: boolean;
    source?: UnitSource;
}

/** Buying, selling, purchase rolls, scrapyard and sponsor. */
@Component({
    selector: 'market-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        @if (campaign().debt > 0) {
            <h4>Warchest Debt <small>{{ fmt(campaign().debt) }} SP</small></h4>
            <div class="cp-row">
                <input class="bt-input cp-num" type="number" min="1" [max]="debtMax()" [value]="debtAmount() || debtMax()" (input)="debtAmount.set(+$any($event.target).value || 0)">
                <button type="button" class="bt-button tiny" [disabled]="!debtMax()" (click)="payDebt.emit(debtAmount() || debtMax()); debtAmount.set(0)">Pay down</button>
                <small class="cp-muted">No purchases or training until it is paid.</small>
            </div>
        }

        <h4>Buy</h4>
        <input class="bt-input" type="search" placeholder="Chassis or model" [value]="query()" (input)="query.set($any($event.target).value)">
        <table class="cp-table">
            <tbody>
                @for (r of results(); track r.name) {
                    <tr>
                        <td>{{ r.label }}</td><td class="num">{{ fmt(r.price) }} SP</td>
                        <td>
                            <div class="cp-row">
                                <button type="button" class="bt-button tiny" (click)="buyOne(r.name)">{{ r.breaks ? 'Buy (ends sponsor)' : 'Buy' }}</button>
                                @if (r.sponsorPrice != null) {
                                    <button type="button" class="bt-button tiny" (click)="order.emit({ unit: r.name, zone: zone() })">Order {{ fmt(r.sponsorPrice) }} SP</button>
                                }
                            </div>
                        </td>
                    </tr>
                }
            </tbody>
        </table>

        <h4>Sell</h4>
        <table class="cp-table">
            <tbody>
                @for (u of sellable(); track u.id) {
                    <tr>
                        <td>{{ u.label }}</td><td class="num">{{ fmt(u.price) }} SP</td>
                        <td><button type="button" class="bt-button tiny" (click)="sell.emit(u.id)">Sell</button></td>
                    </tr>
                } @empty { <tr><td>Nothing to sell.</td></tr> }
            </tbody>
        </table>

        @if (purchase(); as p) {
            <h4>Contract purchases</h4>
            @if (p.gate; as g) {
                <p>Availability {{ g.roll }}: {{ g.logs.length }}/{{ g.count }} rolls
                    @if (g.logs.length < g.count) { <button type="button" class="bt-button tiny" (click)="rollTable.emit()">Roll</button> }
                </p>
                <ul class="cp-list">
                    @for (l of g.logs.flat(); track $index) {
                        <li [style.margin-left.em]="l.depth">
                            @if (l.units?.length) {
                                @for (u of l.units; track $index) {
                                    {{ labelOf()(u.unit) }}
                                    <button type="button" class="bt-button tiny" (click)="buyOne(u.unit, 'contract')">Buy {{ priceOf(u.unit) }} SP</button>
                                }
                            } @else { {{ l.text }} }
                        </li>
                    }
                </ul>
            } @else {
                <button type="button" class="bt-button tiny" (click)="rollGate.emit()">Roll availability</button>
            }
        }

        @if (faction(); as f) {
            <h4>Faction purchase options <small>{{ f.name }}</small></h4>
            @if (f.log; as log) {
                <ul class="cp-list">
                    @for (l of log; track $index) {
                        <li [style.margin-left.em]="l.depth">
                            @if (l.units?.length) {
                                @for (u of l.units; track $index) {
                                    {{ labelOf()(u.unit) }}
                                    <button type="button" class="bt-button tiny" (click)="buyOne(u.unit)">Buy {{ priceOf(u.unit) }} SP</button>
                                }
                            } @else { {{ l.text }} }
                        </li>
                    }
                </ul>
            } @else {
                <div class="cp-row">
                    @if (f.adjust) {
                        <label>Roll ±1 <select class="bt-select" (change)="factionMod.set(+$any($event.target).value)">
                            <option value="0">0</option><option value="1">+1</option><option value="-1">−1</option>
                        </select></label>
                    }
                    <button type="button" class="bt-button tiny" (click)="rollFaction.emit({ mod: factionMod() })">Roll (once a month)</button>
                </div>
            }
        }

        @if (toftt().length) {
            <h4>Taking One For the Team options</h4>
            <table class="cp-table">
                <tbody>
                    @for (o of toftt(); track o.id) {
                        <tr>
                            <td>{{ labelOf()(o.unit) }} <small class="cp-muted">from {{ o.from }}{{ o.half ? ', half price' : '' }}</small></td>
                            <td class="num">{{ fmt(o.price) }} SP</td>
                            <td><button type="button" class="bt-button tiny" (click)="buyToftt.emit(o.id)">Buy</button></td>
                        </tr>
                    }
                </tbody>
            </table>
        }

        @if (scrapTables().length) {
            <h4>Scrapyard</h4>
            @if (scrap(); as s) {
                @if (s.unit) {
                    <p>{{ labelOf()(s.unit) }}: {{ s.condLabel }}, {{ fmt(s.price) }} SP
                        @if (!s.bought) { <button type="button" class="bt-button tiny" (click)="buyScrapyard.emit(s.breaks)">{{ s.breaks ? 'Buy (ends sponsor)' : 'Buy' }}</button> } @else { (bought) }
                    </p>
                } @else { <p class="cp-muted">Nothing found.</p> }
            } @else {
                <div class="cp-row">
                    <select class="bt-select" (change)="scrapTable.set($any($event.target).value)">
                        @for (t of scrapTables(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }
                    </select>
                    <button type="button" class="bt-button tiny" (click)="searchScrapyard.emit(scrapTable() || scrapTables()[0].id)">Search</button>
                </div>
            }
        }

        @if (sponsors().length) {
            <h4>Sponsor</h4>
            <div class="cp-row">
                <select class="bt-select" (change)="setSponsor.emit($any($event.target).value)">
                    <option value="" [selected]="!campaign().sponsorId">None</option>
                    @for (s of sponsors(); track s.id) {
                        <option [value]="s.id" [selected]="s.id === campaign().sponsorId" [disabled]="s.banned">{{ s.name }} (−{{ s.discountPct }}%){{ s.banned ? ' · banned' : '' }}</option>
                    }
                </select>
                @if (campaign().sponsorId) {
                    <select class="bt-select" (change)="zone.set($any($event.target).value)">
                        <option value="territory">In territory</option>
                        <option value="near">Nearby</option>
                        <option value="far">Far: collect</option>
                    </select>
                }
            </div>
            <ul class="cp-list">
                @for (u of deliveries(); track u.id) {
                    <li>{{ u.label }}: {{ u.due ? 'due ' + u.due : 'awaiting collection' }}
                        @if (!u.due) { <button type="button" class="bt-button tiny" (click)="collect.emit(u.id)">Collected</button> }
                    </li>
                }
            </ul>
        }
    `,
    styles: ['.cp-num { width: 6em; }'],
})
export class MarketPanelComponent {
    readonly campaign = input.required<Campaign>();
    readonly env = input.required<RunnerEnv>();
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly search = input<(q: string) => { name: string; label: string }[]>(() => []);
    readonly buy = output<BuyRequest>();
    readonly sell = output<string>();
    readonly rollGate = output<void>();
    readonly rollTable = output<void>();
    readonly searchScrapyard = output<string>();
    readonly buyScrapyard = output<boolean>();
    readonly setSponsor = output<string>();
    readonly order = output<{ unit: string; zone: DeliveryZone }>();
    readonly collect = output<string>();
    readonly payDebt = output<number>();
    readonly rollFaction = output<{ mod: number }>();
    readonly buyToftt = output<string>();

    protected readonly fmt = fmt;
    protected readonly query = signal('');
    protected readonly zone = signal<DeliveryZone>('territory');
    protected readonly scrapTable = signal('');
    protected readonly debtAmount = signal(0);
    protected readonly factionMod = signal(0);

    protected readonly debtMax = computed(() => Math.min(this.campaign().debt, this.campaign().warchest));
    /** Regular military: this month's Faction Purchase Options roll (from rank 2 it may be adjusted by ±1). */
    protected readonly faction = computed(() => {
        const c = this.campaign();
        const f = factionOf(c, this.env().pub);
        if (!f?.purchaseTableId || !c.regular) return null;
        return { name: f.name, adjust: (c.regular.rank || 1) >= 2, log: c.factionRolls[period(c)] ?? null };
    });
    protected readonly toftt = computed(() => {
        const c = this.campaign();
        const env = this.env();
        return c.tofttOptions.map(o => ({ ...o, price: Math.ceil(purchasePrice(env.units(o.unit), c.system) * (o.half ? 0.5 : 1)) }));
    });

    private readonly sponsor = computed(() => sponsorOf(this.campaign(), this.env()));
    private breaks(unit: string): boolean {
        return inSponsorScope(this.sponsor(), this.env().units(unit));
    }
    protected priceOf(unit: string): string {
        return fmt(purchasePrice(this.env().units(unit), this.campaign().system));
    }
    protected buyOne(unit: string, source?: UnitSource): void {
        this.buy.emit({ unit, breakDeal: this.breaks(unit), source });
    }

    protected readonly results = computed(() => {
        const c = this.campaign();
        const env = this.env();
        return this.search()(this.query()).map(r => {
            const u = env.units(r.name);
            return {
                ...r, price: purchasePrice(u, c.system), breaks: this.breaks(r.name),
                sponsorPrice: u ? sponsorQuote(c, env, u)?.price ?? null : null,
            };
        });
    });
    protected readonly sellable = computed(() => {
        const c = this.campaign();
        const env = this.env();
        return c.units
            .filter(u => !u.granted && !u.tempHire && !u.delivery && !isGone(u.state))
            .map(u => ({ id: u.id, label: u.name || this.labelOf()(u.unit), price: sellQuote(c, env, u) }));
    });
    protected readonly purchase = computed(() => {
        const c = this.campaign();
        const ct = c.contract;
        const k = ct ? byId(this.env().pub, 'contracts', ct.contractId)?.purchase : undefined;
        return ct && k?.tableId ? { gate: ct.purchase?.[purchasePeriod(c)] ?? null } : null;
    });
    protected readonly scrapTables = computed(() => this.env().pub.tables.filter(t => t.purpose === 'scrapyard'));
    protected readonly scrap = computed(() => {
        const c = this.campaign();
        const s = c.scrapyard;
        if (!s || s.date !== period(c)) return null;
        return { ...s, condLabel: SCRAP_CONDITION.find(x => x[2] === s.cond)?.[3] ?? s.cond, breaks: this.breaks(s.unit) };
    });
    protected readonly sponsors = computed(() => {
        const c = this.campaign();
        return this.env().pub.sponsors.map(s => ({ ...s, banned: c.sponsorBanned.includes(s.id) }));
    });
    protected readonly deliveries = computed(() =>
        this.campaign().units.filter(u => u.delivery).map(u => ({ id: u.id, label: u.name || this.labelOf()(u.unit), due: u.delivery!.due })),
    );
}
