// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DAMAGE_LABEL, DAMAGE_STATES, type DamageState, type PilotOutcome, type TrackResult, type UnitOutcome, type Winner } from '../core/campaign.model';
import type { CombatTier } from '../core/engine';
import type { Side } from '../core/publication.model';
import { TIER_LABEL, type trackForce } from '../core/track';

type Force = ReturnType<typeof trackForce>;
const TIERS: CombatTier[] = ['none', 'unsuccessful', 'success', 'allObjectives'];
const num = (e: Event) => Number((e.target as HTMLInputElement).value) || 0;

/** The after-action form: everything applyTrack needs, emitted as a TrackResult. */
@Component({
    selector: 'track-result-form',
    changeDetection: ChangeDetectionStrategy.OnPush,
    styleUrl: './campaign.shared.scss',
    template: `
        <section class="cp-card">
            <h3>Record result</h3>
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
                <label>SP to pilots <input class="bt-input" type="number" min="0" [value]="designated()" (input)="designated.set(num($event))"></label>
                <label>MVP
                    <select class="bt-select" (change)="mvp.set($any($event.target).value)">
                        <option value="">None</option>
                        @for (p of named(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                    </select>
                </label>
                <label>Ammo tons <input class="bt-input" type="number" min="0" [value]="ammo()" (input)="ammo.set(num($event))"></label>
                <label>Buildings destroyed <input class="bt-input" type="number" min="0" [value]="buildings()" (input)="buildings.set(num($event))"></label>
            </div>

            <h4>Units</h4>
            <table class="cp-table">
                <thead><tr><th>Unit</th><th>State after</th></tr></thead>
                <tbody>
                    @for (x of fielded(); track x.id) {
                        <tr>
                            <td>{{ x.label }}</td>
                            <td>
                                <select class="bt-select" (change)="setState(x.id, $any($event.target).value)">
                                    @for (s of states; track s) { <option [value]="s" [selected]="s === (unitStates()[x.id] ?? x.state)">{{ damage[s] }}</option> }
                                </select>
                            </td>
                        </tr>
                    }
                </tbody>
            </table>

            @if (named().length) {
                <h4>Named pilots</h4>
                <table class="cp-table">
                    <thead><tr><th>Pilot</th><th>Wounds taken</th><th>Kills</th><th>Killed</th></tr></thead>
                    <tbody>
                        @for (p of named(); track p.id) {
                            <tr>
                                <td>{{ p.name }}</td>
                                <td><input class="bt-input" type="number" min="0" max="6" [value]="pilot(p.id).wounds ?? 0" (input)="setPilot(p.id, { wounds: num($event) })"></td>
                                <td><input class="bt-input" type="number" min="0" [value]="pilot(p.id).kills ?? 0" (input)="setPilot(p.id, { kills: num($event) })"></td>
                                <td><input type="checkbox" [checked]="!!pilot(p.id).killed" (change)="setPilot(p.id, { killed: $any($event.target).checked })"></td>
                            </tr>
                        }
                    </tbody>
                </table>
            }

            <label class="cp-block">Salvage (one unit per line, chassis and model)
                <textarea class="bt-input" rows="3" [value]="salvage()" (input)="salvage.set($any($event.target).value)"></textarea>
            </label>

            <button type="button" class="bt-button" [disabled]="!winner()" (click)="submit()">Apply result</button>
        </section>
    `,
})
export class TrackResultFormComponent {
    readonly force = input.required<Force>();
    readonly side = input.required<Side>();
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly apply = output<TrackResult>();

    protected readonly tiers = TIERS;
    protected readonly tierLabel = TIER_LABEL;
    protected readonly states = DAMAGE_STATES;
    protected readonly damage = DAMAGE_LABEL;
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
    protected readonly designated = signal(0);
    protected readonly mvp = signal('');
    protected readonly ammo = signal(0);
    protected readonly buildings = signal(0);
    protected readonly salvage = signal('');
    protected readonly unitStates = signal<Partial<Record<string, DamageState>>>({});
    protected readonly pilots = signal<Record<string, PilotOutcome>>({});

    protected readonly fielded = computed(() => {
        const f = this.force();
        return [...f.own, ...f.hires, ...f.granted].map(cu => ({ id: cu.id, label: cu.name || this.labelOf()(cu.unit), state: cu.state }));
    });
    protected readonly named = computed(() =>
        this.force().crews.flatMap(x => (x.crew.kind === 'named' ? [x.crew.pilot] : [])),
    );

    protected setState(id: string, s: DamageState): void {
        this.unitStates.update(m => ({ ...m, [id]: s }));
    }
    protected pilot(id: string): PilotOutcome {
        return this.pilots()[id] ?? {};
    }
    protected setPilot(id: string, patch: PilotOutcome): void {
        this.pilots.update(m => ({ ...m, [id]: { ...m[id], ...patch } }));
    }

    protected submit(): void {
        const units: Record<string, UnitOutcome> = {};
        for (const [id, state] of Object.entries(this.unitStates())) if (state) units[id] = { state };
        const salvage = this.salvage().split('\n').map(s => s.trim()).filter(Boolean).map(unit => ({ unit }));
        this.apply.emit({
            winner: this.winner(), tier: this.tier(), objectivesDone: this.objDone(), objectivesTotal: this.objTotal(),
            designated: this.designated(), mvp: this.mvp() || undefined, ammoTons: this.ammo(), buildings: this.buildings(),
            units, pilots: this.pilots(), salvage,
        });
    }
}
