// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { isGone, type Campaign, type RunnerEnv } from '../core/campaign.model';
import { COSTS, healLimit, mapRecruit, type HireInput } from '../core/market';
import { COL_LABEL, isBAPilot, ladderIndex, nextThreshold, pilotStats } from '../core/pilots';
import { LADDER, rulesFor, type LadderColumn } from '../core/rules';

/** Healing, SP investment, training and hiring for named pilots and crews. */
@Component({
    selector: 'pilots-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        @for (p of pilots(); track p.id) {
            <h4>{{ p.name }} <small>{{ p.skill }} · {{ p.wounds }} wounds · {{ p.unspent }} SP unspent</small></h4>
            <div class="cp-row">
                @if (p.wounds) {
                    <button type="button" class="bt-button tiny" [disabled]="!p.healLimit" (click)="heal.emit(p.id)">Heal ({{ p.healCost }} SP)</button>
                }
                @let sca = p.scas.includes(val(p.id + ':sca')) ? '' : val(p.id + ':sca');
                @let fm = val(p.id + ':fm') === p.formation ? '' : val(p.id + ':fm');
                <select class="bt-select" (change)="setVal(p.id + ':sca', $event)">
                    <option value="" [selected]="!sca">Command ability…</option>
                    @for (s of scaNames(); track s) { <option [value]="s" [disabled]="p.scas.includes(s)" [selected]="s === sca">{{ s }}</option> }
                </select>
                <button type="button" class="bt-button tiny" [disabled]="!sca" (click)="trainSca.emit({ pilotId: p.id, name: sca })">Train ({{ p.scaCost }} SP)</button>
                <input class="bt-input" type="text" placeholder="Formation type" [value]="fm" (input)="setVal(p.id + ':fm', $event)">
                <button type="button" class="bt-button tiny" [disabled]="!fm" (click)="trainFormation.emit({ pilotId: p.id, formation: fm })">Train formation</button>
            </div>
            @if (p.unspent) {
                <table class="cp-table">
                    <thead><tr><th>Skill</th><th class="num">Now</th><th class="num">SP in</th><th class="num">Next at</th><th></th></tr></thead>
                    <tbody>
                        @for (l of p.ladder; track l.col) {
                            <tr>
                                <td>{{ l.label }}</td><td class="num">{{ l.level }}</td><td class="num">{{ l.invested }}</td><td class="num">{{ l.next ?? 'max' }}</td>
                                <td>
                                    @if (l.next != null) {
                                        <div class="cp-row">
                                            <input class="bt-input cp-num" type="number" min="1" [max]="p.unspent" [value]="amount(p.id, l.col, l.suggest)" (input)="setVal(p.id + ':' + l.col, $event)">
                                            <button type="button" class="bt-button tiny" (click)="doInvest(p.id, l.col, l.suggest)">Invest</button>
                                        </div>
                                    }
                                </td>
                            </tr>
                        }
                    </tbody>
                </table>
            }
        } @empty { <p class="cp-muted">No named pilots.</p> }

        <h4>Hire</h4>
        <div class="cp-row">
            <input class="bt-input" type="text" placeholder="Pilot name" [value]="hireName()" (input)="hireName.set($any($event.target).value)">
            <button type="button" class="bt-button tiny" (click)="hire.emit({ kind: 'named', name: hireName() || undefined })">Hire named ({{ costs.hireNamed }} SP)</button>
        </div>
        <div class="cp-row">
            <select class="bt-select" (change)="crewUnit.set($any($event.target).value)">
                <option value="">Crew for unit…</option>
                @for (u of crewless(); track u.id) { <option [value]="u.id">{{ u.label }}</option> }
            </select>
            <button type="button" class="bt-button tiny" [disabled]="!crewUnit()" (click)="hire.emit({ kind: 'regular', cuId: crewUnit() })">Regular crew ({{ costs.hireRegular }} SP)</button>
            <button type="button" class="bt-button tiny" [disabled]="!crewUnit()" (click)="hire.emit({ kind: 'green', cuId: crewUnit() })">Green crew (free)</button>
        </div>
        @if (recruit(); as r) {
            <h4>Recruit on the map</h4>
            @if (r.needed && !r.options.length) { <p class="cp-warn">Recruiting MechWarriors needs a held hex that allows it; green crews are still free.</p> }
            @for (o of r.options; track $index) {
                <div class="cp-row">
                    <span>{{ o.label }}</span>
                    <button type="button" class="bt-button tiny" [disabled]="!crewUnit()" (click)="recruitCrew.emit({ cuId: crewUnit(), idx: $index })">Recruit for unit ({{ o.cost }} SP)</button>
                </div>
            }
            @if (r.options.length && !crewUnit()) { <p class="cp-muted">Pick the unit above first.</p> }
        }
    `,
    styles: ['.cp-num { width: 5em; }'],
})
export class PilotsPanelComponent {
    readonly campaign = input.required<Campaign>();
    readonly env = input.required<RunnerEnv>();
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly heal = output<string>();
    readonly invest = output<{ pilotId: string; col: LadderColumn; amount: number }>();
    readonly trainSca = output<{ pilotId: string; name: string }>();
    readonly trainFormation = output<{ pilotId: string; formation: string }>();
    readonly hire = output<HireInput>();
    readonly recruitCrew = output<{ cuId: string; idx: number }>();

    protected readonly costs = COSTS;
    protected readonly hireName = signal('');
    protected readonly crewUnit = signal('');
    /** Per-pilot form values, keyed "pilotId:field". Training fields read as empty once the pilot has what they name. */
    private readonly vals = signal<Record<string, string>>({});

    protected readonly scaNames = computed(() => this.env().pub.scas.map(s => s.name));
    protected readonly pilots = computed(() => {
        const c = this.campaign();
        const env = this.env();
        const rules = rulesFor(c.system);
        return c.pilots.filter(p => p.status === 'active').map(p => {
            const s = pilotStats(p, c.system);
            const half = isBAPilot(p);
            return {
                id: p.id, name: p.name, wounds: p.wounds, unspent: p.unspent, scas: p.scas, formation: p.formation,
                skill: rules.skillLabel({ gunnery: s.g, piloting: s.p, skill: s.skill }),
                healLimit: healLimit(c, p, env),
                healCost: (half ? COSTS.healTrooper : COSTS.heal) * Math.min(rules.healing.boxesPerInjury, p.wounds || 1),
                scaCost: COSTS.sca[Math.min(p.scas.length, 2)],
                ladder: rules.ladderColumns.map(col => {
                    const invested = p.cols[col] || 0;
                    const next = nextThreshold(col, invested, half);
                    return {
                        col, label: COL_LABEL[col], invested, next,
                        level: LADDER[col].levels[ladderIndex(col, invested, half)],
                        suggest: next == null ? 0 : Math.min(p.unspent, next - invested),
                    };
                }),
            };
        });
    });
    /** Crews a held map hex lets the command recruit (null off the map). */
    protected readonly recruit = computed(() => {
        const c = this.campaign();
        const r = mapRecruit(c, this.env());
        if (!r) return null;
        const rules = rulesFor(c.system);
        return {
            needed: r.needed,
            options: r.options.map(o => ({
                label: `${rules.skillLabel({ gunnery: Number(o.g), piloting: Number(o.p), skill: Number(o.skill) })} crew${o.typeName ? ` (${o.typeName}${o.lz ? ', landing zone' : ''})` : o.lz ? ' (landing zone)' : ''}`,
                cost: Number(o.cost) || 0,
            })),
        };
    });
    protected readonly crewless = computed(() =>
        this.campaign().units
            .filter(u => !u.tempHire && !u.granted && !u.pilotId && !isGone(u.state))
            .map(u => ({ id: u.id, label: u.name || this.labelOf()(u.unit) })),
    );

    protected val(key: string): string {
        return this.vals()[key] ?? '';
    }
    protected setVal(key: string, e: Event): void {
        const v = (e.target as HTMLInputElement).value;
        this.vals.update(m => ({ ...m, [key]: v }));
    }
    protected amount(pid: string, col: LadderColumn, fallback: number): number {
        return Number(this.val(`${pid}:${col}`)) || fallback;
    }
    protected doInvest(pid: string, col: LadderColumn, fallback: number): void {
        this.invest.emit({ pilotId: pid, col, amount: this.amount(pid, col, fallback) });
        this.vals.update(m => ({ ...m, [`${pid}:${col}`]: '' }));
    }
}
