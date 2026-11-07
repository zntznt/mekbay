// SPDX-License-Identifier: GPL-3.0-or-later

import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { isGone, type Campaign, type MapSide, type RunnerEnv } from '../core/campaign.model';
import { activeEffects, describeEffect, enemyAt, groupAt, groupChecks, groupMove, hexIncome, hexName, hexType, mapOf } from '../core/hex-map';
import { legalMoves } from '../core/map-play';
import { byId } from '../core/publication.model';
import { fmt } from '../core/runner';
import { HexMapComponent, type HexMarker } from './hex-map.component';

export interface GroupEdit {
    gid: string;
    name?: string;
    unitIds?: string[];
    bsp?: number;
}

const initials = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';

/** Campaign-map play: landing, formations, movement, opponent markers, end of map turn and the final battle. */
@Component({
    selector: 'map-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [HexMapComponent, NgTemplateOutlet],
    styleUrl: './campaign.shared.scss',
    template: `
        @if (view(); as v) {
            <section class="cp-card">
                <h3>{{ v.map.name }} <small>{{ phaseLabel() }}</small></h3>
                <p class="cp-muted" aria-live="polite">{{ hint() }}</p>
                <hex-map [map]="v.map" [owner]="v.ms.owner" [markers]="markers()" [reach]="reach()" [selected]="info()"
                    [lz]="{ us: v.ms.lzHex, them: v.ms.enemyLz }" (hexTap)="tap($event)" />

                @if (hexInfo(); as h) {
                    <div class="cp-card">
                        <strong>{{ h.id }}{{ h.name ? ' ' + h.name : '' }}: {{ h.type }}</strong>
                        <ul class="cp-list">
                            @if (h.income) { <li>{{ fmt(h.income) }} SP per map turn</li> }
                            @if (h.track) { <li>Scenario: {{ h.track }}</li> }
                            @if (h.terrain) { <li class="cp-muted">{{ h.terrain }}</li> }
                            @for (e of h.effects; track $index) { <li class="cp-muted">{{ e }}</li> }
                            @if (h.owner) { <li>Held by {{ h.owner === 'us' ? 'you' : 'the opponent' }}</li> }
                            @if (h.steps != null) { <li>{{ h.steps }} hex(es) away</li> }
                        </ul>
                    </div>
                }
            </section>

            @if (v.battle; as b) {
                <section class="cp-card">
                    <h3>Map battle <small>{{ b.hex }} · you {{ b.ourRole === 'attacker' ? 'attack' : 'defend' }}</small></h3>
                    @if (helpers().length) {
                        <p>{{ b.helperMode === 'recall' ? 'The base may recall one formation, even one that has moved.' : 'Unmoved formations in range may join the garrison.' }}</p>
                        <div class="cp-row">
                            @for (g of helpers(); track g.id) {
                                <button type="button" class="bt-button" [disabled]="g.joined || (b.helperMode === 'recall' && !!b.joined?.length)" (click)="joinDefense.emit(g.id)">{{ g.joined ? g.name + ' joined' : 'Join: ' + g.name }}</button>
                            }
                        </div>
                    }
                    @if (canWithdraw()) { <button type="button" class="bt-button" (click)="withdraw.emit()">Withdraw instead of fighting</button> }
                    <p class="cp-muted">Set up and play the track below; its result moves the formations on the map.</p>
                </section>
            }

            @if (v.ms.phase === 'landing' && v.ms.lzHex && v.ms.enemyLz) {
                <section class="cp-card">
                    <h3>Formations</h3>
                    <ng-container *ngTemplateOutlet="formations" />
                    <button type="button" class="bt-button" [disabled]="checks().length > 0" (click)="beginTurns.emit()">Deploy and start turn 1</button>
                </section>
            }

            <!-- During a battle the track setup below matters; movement and the end of turn wait for its result. -->
            @if (v.ms.phase === 'turns' && !v.draft) {
                <section class="cp-card">
                    <h3>Your formations</h3>
                    <table class="cp-table">
                        <tbody>
                            @for (g of groups(); track g.id) {
                                <tr [class.cp-muted]="g.moved">
                                    <td><button type="button" class="bt-button tiny" [class.selected]="selG() === g.id" (click)="pickGroup(g.id, g.hex)">{{ g.name }}</button></td>
                                    <td>{{ g.hex }} · {{ g.units }} unit(s) · {{ g.bsp }} BSP · moves {{ g.move }}{{ g.moved ? ' · moved' : '' }}</td>
                                    <td>@if (!g.moved) { <button type="button" class="bt-button tiny" (click)="stay.emit(g.id)">Stay</button> }</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                    <h4>Opponent formations</h4>
                    <table class="cp-table">
                        <tbody>
                            @for (e of enemies(); track e.id) {
                                <tr [class.cp-muted]="e.moved">
                                    <td><button type="button" class="bt-button tiny" [class.selected]="selE() === e.id" (click)="pickEnemy(e.id, e.hex)">{{ e.name }}</button></td>
                                    <td>{{ e.hex }}{{ e.moved ? ' · moved' : '' }}</td>
                                    <td><button type="button" class="bt-button tiny" (click)="removeEnemy.emit(e.id)">Remove</button></td>
                                </tr>
                            } @empty { <tr><td class="cp-muted">No opponent formations on the map.</td></tr> }
                        </tbody>
                    </table>
                    <div class="cp-row">
                        <input class="bt-input" type="text" placeholder="Opponent formation name" [value]="enemyName()" (input)="enemyName.set($any($event.target).value)">
                        <button type="button" class="bt-button" (click)="addEnemy.emit(enemyName()); enemyName.set('')">Add at their landing zone</button>
                    </div>
                    <p class="cp-muted">You move the opponent's markers (or a GM does): select one, then tap a hex.</p>
                </section>

                @if (canReorganise()) {
                    <section class="cp-card">
                        <details>
                            <summary>Reorganise formations (start of the turn only)</summary>
                            <ng-container *ngTemplateOutlet="formations" />
                        </details>
                    </section>
                }

                <section class="cp-card">
                    <h3>End of map turn</h3>
                    <p>Income {{ fmt(income().total) }} SP@if (income().lines.length) {: {{ incomeLines() }}}.</p>
                    @if (fought().count) {
                        <label class="cp-block">SP to the {{ fought().count }} named pilot(s) who fought (max {{ fought().cap }})
                            <input class="bt-input" type="number" min="0" [max]="fought().cap" [value]="designated()" (input)="designated.set(+$any($event.target).value || 0)">
                        </label>
                    }
                    @if (reinforceable().length) {
                        <h4>Strategic reinforcement <small>{{ v.ms.reinforcements }} left</small></h4>
                        <div class="cp-row">
                            @for (u of reinforceable(); track u.id) {
                                <button type="button" class="bt-button tiny" [disabled]="v.ms.reinforcements <= 0" (click)="reinforce.emit(u.id)">Replace {{ u.label }}</button>
                            }
                        </div>
                    }
                    <button type="button" class="bt-button" (click)="endTurn.emit(designated()); designated.set(0)">End map turn</button>
                </section>
            }

            @if (v.ms.phase === 'ended') {
                <section class="cp-card">
                    <h3>Map campaign over</h3>
                    <p><strong>{{ v.ms.ended?.text }}</strong></p>
                    @if (!v.ms.ended?.winner) {
                        <p>Who has the higher Warchest?</p>
                        <div class="cp-row">
                            <button type="button" class="bt-button" (click)="setWinner.emit('us')">We do</button>
                            <button type="button" class="bt-button" (click)="setWinner.emit('them')">The opponent</button>
                        </div>
                    } @else if (!v.ms.finalDone && !v.draft) {
                        <p>{{ v.ms.ended.winner === 'us' ? 'You won the map: you defend your base in the final battle.' : 'The opponent won the map: you attack their HQ in the final battle.' }}</p>
                        <button type="button" class="bt-button" (click)="finalBattle.emit()">{{ v.map.rules.final.enabled ? 'Set up the final battle' : 'End the contract' }}</button>
                    }
                </section>
            }

            <ng-template #formations>
                <p class="cp-muted">Up to {{ v.map.rules.maxGroups }} formations of up to {{ v.map.rules.groupSize }} units, each with at least {{ v.map.rules.minMechs }} 'Mech.@if (pool()) { Divide {{ pool() }} BSP among them ({{ bspUsed() }} assigned).}</p>
                @for (g of v.ms.groups; track g.id) {
                    <div class="cp-card cp-formation">
                        <div class="cp-row">
                            <label class="cp-block">Formation <input class="bt-input" type="text" [value]="g.name" (change)="edit.emit({ gid: g.id, name: $any($event.target).value })"></label>
                            @if (pool()) { <label class="cp-block">BSP <input class="bt-input" type="number" min="0" [value]="g.bsp" (change)="edit.emit({ gid: g.id, bsp: +$any($event.target).value })"></label> }
                            <button type="button" class="bt-button tiny" (click)="removeGroup.emit(g.id)">Remove</button>
                        </div>
                        <div class="cp-row">
                            @for (u of ownUnits(); track u.id) {
                                @let other = u.group && u.group !== g.id;
                                <label [class.cp-muted]="other"><input type="checkbox" [checked]="g.unitIds.includes(u.id)" [disabled]="other" (change)="toggleUnit(g.id, g.unitIds, u.id, $any($event.target).checked)"> {{ u.label }}</label>
                            }
                        </div>
                    </div>
                }
                <button type="button" class="bt-button" [disabled]="v.ms.groups.length >= v.map.rules.maxGroups" (click)="addGroup.emit()">Add formation</button>
                <ul class="cp-list">@for (x of checks(); track $index) { <li class="cp-warn">{{ x }}</li> }</ul>
            </ng-template>
        } @else {
            <section class="cp-card cp-danger">The contract's campaign map is missing from the publication.</section>
        }
    `,
})
export class MapPanelComponent {
    readonly campaign = input.required<Campaign>();
    readonly env = input.required<RunnerEnv>();
    readonly labelOf = input<(unit: string) => string>(u => u);
    readonly land = output<string>();
    readonly enemyLz = output<string>();
    readonly addGroup = output<void>();
    readonly edit = output<GroupEdit>();
    readonly removeGroup = output<string>();
    readonly beginTurns = output<void>();
    readonly move = output<{ gid: string; to: string }>();
    readonly stay = output<string>();
    readonly addEnemy = output<string>();
    readonly moveEnemy = output<{ eid: string; to: string }>();
    readonly removeEnemy = output<string>();
    readonly reinforce = output<string>();
    readonly endTurn = output<number>();
    readonly setWinner = output<MapSide>();
    readonly finalBattle = output<void>();
    readonly joinDefense = output<string>();
    readonly withdraw = output<void>();

    protected readonly fmt = fmt;
    protected readonly selG = signal('');
    protected readonly selE = signal('');
    protected readonly info = signal('');
    protected readonly enemyName = signal('');
    protected readonly designated = signal(0);

    protected readonly view = computed(() => {
        const c = this.campaign();
        const env = this.env();
        const ms = c.contract?.map;
        const map = mapOf(c, env.pub);
        return ms && map ? { c, env, ms, map, draft: c.draft, battle: c.draft?.mapBattle && !c.draft.mapBattle.final ? c.draft.mapBattle : null } : null;
    });
    protected readonly phaseLabel = computed(() => {
        const v = this.view();
        if (!v) return '';
        const ct = v.c.contract!;
        return v.ms.phase === 'landing' ? 'landing' : v.ms.phase === 'ended' ? 'map campaign over' : `map turn ${ct.month} of ${ct.length}`;
    });
    protected readonly hint = computed(() => {
        const v = this.view();
        if (!v) return '';
        const { ms } = v;
        if (ms.phase === 'landing') return !ms.lzHex ? 'Tap one of your landing zones (LZ).' : !ms.enemyLz ? "Tap the opponent's landing zone, on the other end of the map." : 'Organise your formations, then deploy.';
        if (ms.phase !== 'turns') return '';
        if (v.draft) return 'A battle is in progress: finish its track first.';
        const g = ms.groups.find(x => x.id === this.selG());
        const e = ms.enemy.find(x => x.id === this.selE());
        if (g) return g.moved ? `${g.name} has moved this turn.` : `Tap a highlighted hex to move ${g.name} (${groupMove(v.c, v.env, g)} hexes). Moving onto the opponent starts a battle.`;
        if (e) return `Tap a hex to move ${e.name}. Moving onto your formation or base starts a battle.`;
        return 'Tap a formation to select it.';
    });
    protected readonly reach = computed(() => {
        const v = this.view();
        return v && this.selG() ? legalMoves(v.c, v.env, this.selG()) : null;
    });
    protected readonly markers = computed<HexMarker[]>(() => {
        const v = this.view();
        if (!v) return [];
        const us = v.ms.phase === 'landing' ? [] : v.ms.groups.filter(g => g.unitIds.length && g.hex).map(g => ({ hex: g.hex, label: initials(g.name), side: 'us' as const, selected: g.id === this.selG() }));
        const them = v.ms.enemy.filter(e => !e.gone && e.hex).map(e => ({ hex: e.hex, label: initials(e.name), side: 'them' as const, selected: e.id === this.selE() }));
        return [...us, ...them];
    });
    protected readonly hexInfo = computed(() => {
        const v = this.view();
        const id = this.info();
        if (!v || !id) return null;
        const t = hexType(v.map, id);
        return {
            id, name: hexName(v.map, id), type: t.name, income: t.income, owner: v.ms.owner[id],
            track: t.trackId ? byId(v.env.pub, 'tracks', t.trackId)?.name || '' : '',
            terrain: t.terrain?.[v.c.system] || '',
            effects: [...t.effects.map(e => describeEffect(v.map, e, v.c.system)), ...(t.lz ? t.lzEffects.map(e => 'Landing: ' + describeEffect(v.map, e, v.c.system)) : [])],
            steps: this.reach()?.get(id),
        };
    });
    protected readonly groups = computed(() => {
        const v = this.view();
        return v ? v.ms.groups.filter(g => g.unitIds.length).map(g => ({ id: g.id, name: g.name, hex: g.hex, units: g.unitIds.length, bsp: g.bsp, moved: g.moved, move: groupMove(v.c, v.env, g) })) : [];
    });
    protected readonly enemies = computed(() => this.view()?.ms.enemy.filter(e => !e.gone) ?? []);
    protected readonly helpers = computed(() => {
        const v = this.view();
        const b = v?.battle;
        if (!v || !b) return [];
        return (b.helpers || []).map(id => v.ms.groups.find(g => g.id === id)).filter(g => !!g).map(g => ({ id: g.id, name: g.name, joined: !!b.joined?.includes(g.id) }));
    });
    protected readonly canWithdraw = computed(() => {
        const v = this.view();
        const b = v?.battle;
        return !!v && !!b && b.ourRole === 'defender' && !b.hq && !v.ms.groups.find(g => g.id === b.groupId)?.moved;
    });
    protected readonly canReorganise = computed(() => {
        const v = this.view();
        return !!v && !v.draft && !v.ms.groups.some(g => g.moved) && !v.ms.enemy.some(e => e.moved);
    });
    protected readonly checks = computed(() => {
        const v = this.view();
        return v ? groupChecks(v.c, v.env) : [];
    });
    protected readonly pool = computed(() => {
        const v = this.view();
        return v ? (Number(v.map.rules.bspPerScale) || 0) * v.c.contract!.scale : 0;
    });
    protected readonly bspUsed = computed(() => this.view()?.ms.groups.reduce((s, g) => s + (Number(g.bsp) || 0), 0) ?? 0);
    protected readonly ownUnits = computed(() => {
        const v = this.view();
        if (!v) return [];
        const ct = v.c.contract!;
        return v.c.units
            .filter(u => !u.tempHire && !isGone(u.state) && !(u.arrives && ct.month < u.arrives))
            .map(u => ({ id: u.id, label: u.name || this.labelOf()(u.unit), group: v.ms.groups.find(g => g.unitIds.includes(u.id))?.id || '' }));
    });
    protected readonly income = computed(() => {
        const v = this.view();
        return v ? hexIncome(v.c, v.env.pub) : { total: 0, lines: [] };
    });
    protected readonly incomeLines = computed(() => this.income().lines.map(l => `${l.name} ${fmt(l.value)}`).join(', '));
    /** Named pilots who fought this turn and the most SP the end of turn can give them (mirrors endMapTurn). */
    protected readonly fought = computed(() => {
        const v = this.view();
        if (!v) return { count: 0, cap: 0 };
        const count = v.c.pilots.filter(p => v.ms.fought[p.id]).length;
        const mult = activeEffects(v.c, v.env.pub).filter(e => e.kind === 'pilotSpMult').reduce((m, e) => m * (Number(e.value) || 1), 1);
        return { count, cap: count ? Math.min(this.income().total, 200 * v.c.contract!.scale * mult) : 0 };
    });
    /** Damaged or lost own 'Mechs a strategic reinforcement can replace. */
    protected readonly reinforceable = computed(() => {
        const v = this.view();
        if (!v || !v.ms.reinforcements) return [];
        return v.c.units
            .filter(u => !u.tempHire && !u.granted && u.state !== 'ok' && v.env.units(u.unit)?.type === 'Mek')
            .map(u => ({ id: u.id, label: u.name || this.labelOf()(u.unit) }));
    });

    protected pickGroup(id: string, hex: string): void {
        this.selG.set(this.selG() === id ? '' : id);
        this.selE.set('');
        this.info.set(hex);
    }
    protected pickEnemy(id: string, hex: string): void {
        this.selE.set(this.selE() === id ? '' : id);
        this.selG.set('');
        this.info.set(hex);
    }
    protected tap(id: string): void {
        const v = this.view();
        if (!v) return;
        const { ms } = v;
        this.info.set(id);
        if (ms.phase === 'landing') {
            if (!ms.lzHex) this.land.emit(id);
            else if (!ms.enemyLz) this.enemyLz.emit(id);
            return;
        }
        if (ms.phase !== 'turns' || v.draft) return;
        const g = ms.groups.find(x => x.id === this.selG());
        if (g && this.reach()?.has(id)) {
            this.move.emit({ gid: g.id, to: id });
            this.selG.set('');
            return;
        }
        const e = ms.enemy.find(x => x.id === this.selE());
        if (e && id !== e.hex) {
            this.moveEnemy.emit({ eid: e.id, to: id });
            this.selE.set('');
            return;
        }
        const mine = groupAt(ms, id);
        const foe = enemyAt(ms, id);
        this.selG.set(mine?.id || '');
        this.selE.set(!mine && foe ? foe.id : '');
    }
    protected toggleUnit(gid: string, current: string[], uid: string, on: boolean): void {
        this.edit.emit({ gid, unitIds: on ? [...current, uid] : current.filter(x => x !== uid) });
    }
}
