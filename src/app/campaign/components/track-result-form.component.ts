// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { GameSystem } from '../../models/common.model';
import {
    DAMAGE_LABEL, DAMAGE_STATES, type DamageState, type Payout, type PilotOutcome, type TrackResult, type UnitOutcome, type Winner,
} from '../core/campaign.model';
import type { CombatTier } from '../core/engine';
import type { Side } from '../core/publication.model';
import { rulesFor, type RearmField } from '../core/rules';
import { suggestTier, TIER_LABEL, type trackForce } from '../core/track';

type Force = ReturnType<typeof trackForce>;
const TIERS: CombatTier[] = ['none', 'unsuccessful', 'success', 'allObjectives'];
const num = (e: Event) => Number((e.target as HTMLInputElement).value) || 0;
const REARM_LABEL: Readonly<Record<RearmField, string>> = { ammoTons: 'Ammo tons', advTons: 'Advanced ammo tons', altMunitions: 'Alternate munitions' };
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);

/** The after-action form: everything applyTrack needs, emitted as a TrackResult. */
@Component({
    selector: 'track-result-form',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        <section class="cp-card">
            <h3>Record result @if (toftt()) { <small>Taking One For the Team: you played the opposing force</small> }</h3>
            <div class="cp-grid">
                <label>Winner
                    <select class="bt-select" (change)="pickWinner($any($event.target).value)">
                        <option value="" [selected]="winner() === ''">Choose</option>
                        <option value="A" [selected]="winner() === 'A'">Side A{{ side() === 'A' ? ' (us)' : '' }}</option>
                        <option value="B" [selected]="winner() === 'B'">Side B{{ side() === 'B' ? ' (us)' : '' }}</option>
                        <option value="none" [selected]="winner() === 'none'">No winner</option>
                    </select>
                </label>
                <label>Combat pay
                    <select class="bt-select" (change)="tier.set($any($event.target).value)">
                        @for (t of tiers; track t) { <option [value]="t" [selected]="t === tier()">{{ tierLabel[t] }}</option> }
                    </select>
                </label>
                <label>Objectives done <input class="bt-input" type="number" min="0" [value]="objDone()" (input)="objDone.set(num($event))"></label>
                <label>Objectives total <input class="bt-input" type="number" min="0" [value]="objTotal()" (input)="objTotal.set(num($event))"></label>
                <label>Our VP <input class="bt-input" type="number" min="0" [value]="vpUs()" (input)="vpUs.set(num($event))"></label>
                <label>Their VP <input class="bt-input" type="number" min="0" [value]="vpThem()" (input)="vpThem.set(num($event))"></label>
                @if (!toftt()) {
                    <label>SP to pilots <input class="bt-input" type="number" min="0" [value]="designated()" (input)="designated.set(num($event))"></label>
                    <label>MVP
                        <select class="bt-select" (change)="mvp.set($any($event.target).value)">
                            <option value="">None</option>
                            @for (p of named(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                        </select>
                    </label>
                    @for (f of rearmFields(); track f) {
                        <label>{{ rearmLabel[f] }} <input class="bt-input" type="number" min="0" [value]="rearm()[f] ?? 0" (input)="setRearm(f, num($event))"></label>
                    }
                }
                <label>Buildings destroyed <input class="bt-input" type="number" min="0" [value]="buildings()" (input)="buildings.set(num($event))"></label>
            </div>
            @if (suggested() !== tier()) {
                <p class="cp-muted">From objectives and VP: {{ tierLabel[suggested()] }} <button type="button" class="bt-button tiny" (click)="tier.set(suggested())">Use</button></p>
            }

            @if (fielded().length) {
                <h4>Units</h4>
                <table class="cp-table">
                    <thead><tr><th>Unit</th><th>State after</th><th>Crew / hire</th><th>No rearm</th></tr></thead>
                    <tbody>
                        @for (x of fielded(); track x.id) {
                            <tr>
                                <td>{{ x.label }}</td>
                                <td>
                                    <select class="bt-select" (change)="setUnit(x.id, { state: $any($event.target).value })">
                                        @for (s of states; track s) { <option [value]="s" [selected]="s === (unit(x.id).state ?? x.state)">{{ damage[s] }}</option> }
                                    </select>
                                </td>
                                <td>
                                    @switch (x.crew) {
                                        @case ('hire') {
                                            <div class="cp-row">
                                                <label>Kills <input class="bt-input cp-num" type="number" min="0" [value]="unit(x.id).kills ?? 0" (input)="setUnit(x.id, { kills: num($event) })"></label>
                                                <label>Wounds <input class="bt-input cp-num" type="number" min="0" max="6" [value]="unit(x.id).hireWounds ?? 0" (input)="setUnit(x.id, { hireWounds: num($event) })"></label>
                                            </div>
                                        }
                                        @case ('crew') {
                                            <div class="cp-row">
                                                <label>Wounds <input class="bt-input cp-num" type="number" min="0" max="6" [value]="unit(x.id).crewWounds ?? 0" (input)="setUnit(x.id, { crewWounds: num($event) })"></label>
                                                <label><input type="checkbox" [checked]="!!unit(x.id).crewKilled" (change)="setUnit(x.id, { crewKilled: $any($event.target).checked })"> Killed</label>
                                            </div>
                                        }
                                        @default { <span class="cp-muted">{{ x.crew === 'named' ? 'Named pilot' : '' }}</span> }
                                    }
                                </td>
                                <td>@if (x.rearm) { <input type="checkbox" [attr.aria-label]="'No rearm for ' + x.label" [checked]="!!unit(x.id).noRearm" (change)="setUnit(x.id, { noRearm: $any($event.target).checked })"> }</td>
                            </tr>
                        }
                    </tbody>
                </table>
            }

            @if (named().length) {
                <h4>Named pilots</h4>
                <table class="cp-table">
                    <thead><tr><th>Pilot</th><th>{{ byInjury() ? 'Injured' : 'Wounds taken' }}</th><th>Kills</th><th>Killed</th></tr></thead>
                    <tbody>
                        @for (p of named(); track p.id) {
                            <tr>
                                <td>{{ p.name }}</td>
                                <td>
                                    @if (byInjury()) {
                                        <input type="checkbox" [attr.aria-label]="p.name + ' injured'" [checked]="!!pilot(p.id).injured" (change)="setPilot(p.id, { injured: $any($event.target).checked })">
                                    } @else {
                                        <input class="bt-input cp-num" type="number" min="0" max="6" [value]="pilot(p.id).wounds ?? 0" (input)="setPilot(p.id, { wounds: num($event) })">
                                    }
                                </td>
                                <td><input class="bt-input cp-num" type="number" min="0" [value]="pilot(p.id).kills ?? 0" (input)="setPilot(p.id, { kills: num($event) })"></td>
                                <td><input type="checkbox" [attr.aria-label]="p.name + ' killed'" [checked]="!!pilot(p.id).killed" (change)="setPilot(p.id, { killed: $any($event.target).checked })"></td>
                            </tr>
                        }
                    </tbody>
                </table>
            }

            @if (payoutState().length) {
                <h4>Final battle payouts</h4>
                <div class="cp-row">
                    @for (po of payoutState(); track $index) {
                        <label><input type="checkbox" [checked]="po.done" (change)="setPayout($index, $any($event.target).checked)"> {{ po.name }} ({{ po.sp }} SP)</label>
                    }
                </div>
            }

            @if (toftt()) {
                <div class="cp-grid">
                    <label class="cp-block">Opposing units you played (one per line)
                        <textarea class="bt-input" rows="3" [value]="tofttUnits()" (input)="tofttUnits.set($any($event.target).value)"></textarea>
                    </label>
                    <label class="cp-block">On a success: unit kept as a purchase option
                        <select class="bt-select" (change)="tofttPick.set($any($event.target).value)">
                            <option value="">None</option>
                            @for (u of tofttList(); track u) { <option [value]="u" [selected]="u === tofttPick()">{{ u }}</option> }
                        </select>
                    </label>
                </div>
            } @else {
                <label class="cp-block">Salvage (one unit per line, chassis and model)
                    <textarea class="bt-input" rows="3" [value]="salvage()" (input)="salvage.set($any($event.target).value)"></textarea>
                </label>
            }

            <button type="button" class="bt-button" [disabled]="!winner()" (click)="submit()">Apply result</button>
        </section>
    `,
    styles: ['.cp-num { width: 4.5em; }'],
})
export class TrackResultFormComponent {
    readonly force = input.required<Force>();
    readonly side = input.required<Side>();
    readonly system = input.required<GameSystem>();
    /** Taking One For the Team: the command played the opposing force. */
    readonly toftt = input(false);
    /** Final battle: payouts the employer pays per achievement. */
    readonly payouts = input<Payout[] | undefined>(undefined);
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly apply = output<TrackResult>();

    protected readonly tiers = TIERS;
    protected readonly tierLabel = TIER_LABEL;
    protected readonly states = DAMAGE_STATES;
    protected readonly damage = DAMAGE_LABEL;
    protected readonly rearmLabel = REARM_LABEL;
    protected readonly num = num;

    protected readonly winner = signal<Winner | ''>('');
    protected readonly tier = signal<CombatTier>('success');

    /** A lost track defaulting to a paid tier is easy to miss at the table: follow the winner, still editable. */
    protected pickWinner(w: Winner | ''): void {
        this.winner.set(w);
        if (w === 'none') this.tier.set('none');
        else if (w) this.tier.set(w === this.side() ? 'success' : 'unsuccessful');
    }
    protected readonly objDone = signal(0);
    protected readonly objTotal = signal(1);
    protected readonly vpUs = signal(0);
    protected readonly vpThem = signal(0);
    protected readonly designated = signal(0);
    protected readonly mvp = signal('');
    protected readonly rearm = signal<Partial<Record<RearmField, number>>>({});
    protected readonly buildings = signal(0);
    protected readonly salvage = signal('');
    protected readonly tofttUnits = signal('');
    protected readonly tofttPick = signal('');
    protected readonly units = signal<Record<string, UnitOutcome>>({});
    protected readonly pilots = signal<Record<string, PilotOutcome>>({});
    private readonly payoutDone = signal<Record<number, boolean>>({});

    protected readonly rearmFields = computed(() => rulesFor(this.system()).rearmFields);
    /** Systems that count whole injuries take a checkbox instead of wound boxes. */
    protected readonly byInjury = computed(() => rulesFor(this.system()).healing.boxesPerInjury > 1);
    protected readonly suggested = computed(() => suggestTier({
        objectivesDone: this.objDone(), objectivesTotal: this.objTotal(), vpUs: this.vpUs(), vpThem: this.vpThem(),
        losses: Object.values(this.units()).some(u => u.state && u.state !== 'ok'),
    }));
    protected readonly fielded = computed(() => {
        const f = this.force();
        const crewOf = new Map(f.crews.map(x => [x.cu.id, x.crew.kind]));
        const rearmed = new Set([...f.own, ...f.hires].map(cu => cu.id));
        return [...f.own, ...f.hires, ...f.granted].map(cu => ({
            id: cu.id, label: cu.name || this.labelOf()(cu.unit), state: cu.state, rearm: rearmed.has(cu.id),
            crew: cu.tempHire ? 'hire' : crewOf.get(cu.id) === 'crew' && !cu.pilotId ? 'crew' : crewOf.get(cu.id) === 'named' ? 'named' : '',
        }));
    });
    protected readonly named = computed(() =>
        this.force().crews.flatMap(x => (x.crew.kind === 'named' ? [x.crew.pilot] : [])),
    );
    protected readonly payoutState = computed(() => (this.payouts() || []).map((p, i) => ({ ...p, done: this.payoutDone()[i] ?? p.done })));
    protected readonly tofttList = computed(() => lines(this.tofttUnits()));

    protected unit(id: string): UnitOutcome {
        return this.units()[id] ?? {};
    }
    protected setUnit(id: string, patch: UnitOutcome): void {
        this.units.update(m => ({ ...m, [id]: { ...m[id], ...patch } }));
    }
    protected pilot(id: string): PilotOutcome {
        return this.pilots()[id] ?? {};
    }
    protected setPilot(id: string, patch: PilotOutcome): void {
        this.pilots.update(m => ({ ...m, [id]: { ...m[id], ...patch } }));
    }
    protected setRearm(f: RearmField, v: number): void {
        this.rearm.update(m => ({ ...m, [f]: v }));
    }
    protected setPayout(i: number, done: boolean): void {
        this.payoutDone.update(m => ({ ...m, [i]: done }));
    }

    protected submit(): void {
        const r = this.rearm();
        const toftt = this.toftt();
        const payouts = this.payoutState().map(({ name, sp, done }) => ({ name, sp, done }));
        this.apply.emit({
            winner: this.winner(), tier: this.tier(), objectivesDone: this.objDone(), objectivesTotal: this.objTotal(),
            vpUs: this.vpUs(), vpThem: this.vpThem(),
            designated: toftt ? 0 : this.designated(), mvp: (!toftt && this.mvp()) || undefined,
            ammoTons: r.ammoTons || 0, advTons: r.advTons || 0, altMunitions: r.altMunitions || 0, buildings: this.buildings(),
            units: this.units(), pilots: this.pilots(),
            salvage: toftt ? [] : lines(this.salvage()).map(unit => ({ unit })),
            ...(payouts.length ? { payouts } : {}),
            ...(toftt ? { tofttUnits: this.tofttList(), tofttPick: this.tofttPick() || undefined } : {}),
        });
    }
}
