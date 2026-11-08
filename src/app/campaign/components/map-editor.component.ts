// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { GameSystem } from '../../models/common.model';
import { DialogsService } from '../../services/dialogs.service';
import { CampaignService } from '../campaign.service';
import { selectableSteps, stepLabel } from '../core/engine';
import { describeEffect, hexType, inMap, MAP_RULE_RANGES, MAX_MAP_SIDE, type MapRuleNum } from '../core/hex-map';
import {
    addHexType, clampInt, clampPayouts, deleteHexType, EFFECT_FIELDS, EFFECT_KINDS, FINAL_BSP_MAX, HOLD_TURNS_MAX, imageProblem, MAX_EFFECTS, MAX_MAP_IMAGE_CHARS,
    MAX_PAYOUTS, newMapEffect, PAYOUT_SP_MAX, paintHex, resizeMap, setEffects, setHex, setImage, updateHexType, withMap, withMapContract, type EffectList,
} from '../core/map-edit';
import { HEX_DEFAULT, newCampaignMap, newHexType, newPublication, type CampaignMap, type HexType, type MapEffect, type MapEffectKind, type MapHex, type MapRules } from '../core/publication.model';
import { validate } from '../core/validate';
import { HexMapComponent } from './hex-map.component';

const UNDO_DEPTH = 20;
const SYSTEM_LABEL: Record<GameSystem, string> = { [GameSystem.CLASSIC]: 'Classic', [GameSystem.ALPHA_STRIKE]: 'Alpha Strike' };
const RULE_LABEL: Record<MapRuleNum, string> = {
    turns: 'Map turns', turnsPerMonth: 'Turns per month', maxGroups: 'Max formations', groupSize: 'Units per formation', minMechs: "Min 'Mechs each",
    lightTons: 'Light up to (tons)', lightSz: 'Light up to (AS size)', lightMove: 'Light move', heavyMove: 'Heavy move',
    reinforcements: 'Strategic reinforcements', bspPerScale: 'BSP per Scale',
};
const KIND_LABEL: Record<MapEffectKind, string> = {
    incomePct: 'Income %', maintPct: 'Maintenance %', purchase: "'Mech purchases", reinforce: 'Strategic reinforcement', recruit: 'Recruit pilots',
    supportPct: 'Support %', bsp: 'BSP', pilotSpMult: 'Pilot SP ×', heal: 'Healing', cancel: 'Cancel opponent hex', garrison: 'Garrison', note: 'Note',
};
const FIELD_LABEL: Partial<Record<keyof MapEffect, string>> = {
    target: 'Hex type', pct: 'Fixed %', die: 'Die (blank = fixed)', mult: '× %', sign: 'Sign', value: 'Value', g: 'Gunnery', p: 'Piloting', skill: 'AS skill',
    cost: 'Cost SP', note: 'Classic note', asNote: 'AS note', text: 'Text',
};
const TEXT_FIELDS = new Set<keyof MapEffect>(['target', 'die', 'note', 'asNote', 'text']);

/** Download text as a file. */
export function downloadText(filename: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Scale and JPEG-compress an image file until it fits the publication's image cap. */
async function embedImage(file: File): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('Not an image file.');
    if (file.size > 40e6) throw new Error('The image file is over 40 MB.');
    const bmp = await createImageBitmap(file);
    try {
        const canvas = document.createElement('canvas');
        // ponytail: four fixed size/quality steps; a binary search on quality would squeeze out a little more detail
        for (const [maxSide, q] of [[2048, 0.85], [1600, 0.8], [1200, 0.7], [900, 0.6]]) {
            const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
            canvas.width = Math.max(1, Math.round(bmp.width * k));
            canvas.height = Math.max(1, Math.round(bmp.height * k));
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            const url = canvas.toDataURL('image/jpeg', q);
            if (!imageProblem(url)) return url;
        }
    } finally {
        bmp.close();
    }
    throw new Error(`The image does not compress under ${(MAX_MAP_IMAGE_CHARS / 1e6).toFixed(1)} MB.`);
}

/** Edits one publication map: grid, background, hex types, painted hexes and map rules, validated live. */
@Component({
    selector: 'map-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [HexMapComponent],
    styleUrls: ['./campaign.shared.scss'],
    template: `
        <section class="cp-card">
            <div class="cp-row me-head">
                <label class="me-name">Map name <input class="bt-input" type="text" [value]="draft().name" (change)="setName($any($event.target).value)"></label>
                <button type="button" class="bt-button" [disabled]="!history().length" (click)="undo()">Undo</button>
                <button type="button" class="bt-button" [disabled]="errors().length > 0" (click)="save()">Save{{ warnCount() ? ' (' + warnCount() + ' warnings)' : '' }}</button>
                <button type="button" class="bt-button" [disabled]="errors().length > 0" (click)="exportJson()">Export JSON</button>
                <button type="button" class="bt-button" (click)="close()">Close</button>
            </div>
            <p class="cp-muted me-small">{{ svc.pub()?.title || 'New publication' }}{{ dirty() ? ' · unsaved changes' : '' }}{{ status() ? ' · ' + status() : '' }}</p>
            @if (problem()) { <p class="cp-danger" role="alert">{{ problem() }}</p> }
            @if (mapIssues().length) {
                <ul class="cp-list me-issues">
                    @for (i of mapIssues(); track $index) { <li [class.cp-danger]="i.level === 'error'" [class.cp-warn]="i.level === 'warn'" [class.cp-muted]="i.level === 'info'">{{ i.msg }}</li> }
                </ul>
            }
        </section>

        <div class="me-layout">
            <section class="cp-card">
                <div class="cp-row" role="radiogroup" aria-label="Map tool">
                    <button type="button" class="bt-button tiny" role="radio" [attr.aria-checked]="painting()" [class.selected]="painting()" (click)="painting.set(true)">Paint</button>
                    <button type="button" class="bt-button tiny" role="radio" [attr.aria-checked]="!painting()" [class.selected]="!painting()" (click)="painting.set(false)">Select / pan</button>
                    <span class="cp-muted me-small">{{ painting() ? 'Tap or drag to paint ' + tool().name + '.' : 'Tap a hex to name it or set its map end.' }}</span>
                </div>
                <hex-map [map]="draft()" [paint]="painting()" [selected]="selHex()" (hexPaint)="paintAt($event)" (hexTap)="tapHex($event)" />
            </section>

            <div>
                <div class="cp-row" role="tablist">
                    @for (t of tabs; track t) {
                        <button type="button" class="bt-button tiny" role="tab" [attr.aria-selected]="tab() === t" [class.selected]="tab() === t" (click)="tab.set(t)">{{ t }}</button>
                    }
                </div>

                @switch (tab()) {
                    @case ('Hexes') {
                        <section class="cp-card">
                            <h4>Paint with</h4>
                            <div class="me-palette">
                                @for (t of draft().hexTypes; track t.id) {
                                    <button type="button" class="bt-button tiny" [class.selected]="t.id === tool().id" (click)="pickTool(t.id)">
                                        <span class="me-swatch" [style.background]="t.color"></span>{{ t.name }} <small class="cp-muted">{{ counts()[t.id] || '' }}</small>
                                    </button>
                                }
                            </div>
                            @if (hexInfo(); as h) {
                                <h4>Hex {{ h.id }}</h4>
                                <div class="cp-grid">
                                    <label>Hex type
                                        <select class="bt-select" (change)="patchHex(h.id, { t: $any($event.target).value })">
                                            @for (t of draft().hexTypes; track t.id) { <option [value]="t.id" [selected]="t.id === h.type.id">{{ t.name }}</option> }
                                        </select>
                                    </label>
                                    <label>Name <input class="bt-input" type="text" [value]="h.hex.name || ''" (change)="patchHex(h.id, { name: $any($event.target).value })"></label>
                                    @if (h.type.lz) {
                                        <label>Map end (sides land on different ends)
                                            <input class="bt-input" type="text" list="me-ends" [value]="h.hex.end || ''" (change)="patchHex(h.id, { end: $any($event.target).value.trim() })">
                                        </label>
                                        <datalist id="me-ends"><option value="north"></option><option value="south"></option><option value="east"></option><option value="west"></option></datalist>
                                    }
                                </div>
                            }
                        </section>
                    }
                    @case ('Hex types') {
                        <section class="cp-card">
                            <div class="cp-row">
                                <select class="bt-select" aria-label="Hex type" (change)="pickTool($any($event.target).value)">
                                    @for (t of draft().hexTypes; track t.id) { <option [value]="t.id" [selected]="t.id === tool().id">{{ t.name }}</option> }
                                </select>
                                <button type="button" class="bt-button tiny" (click)="newType()">New hex type</button>
                                @if (tool().id !== defaultType) { <button type="button" class="bt-button tiny" (click)="removeType()">Delete</button> }
                            </div>
                            @if (tool(); as t) {
                                <div class="cp-grid">
                                    <label>Name <input class="bt-input" type="text" [value]="t.name" (change)="setType(t.id, { name: $any($event.target).value.trim() || t.name })"></label>
                                    <label>Colour <input type="color" [value]="t.color" (change)="setType(t.id, { color: $any($event.target).value })"></label>
                                    <label>SP per map turn <input class="bt-input" type="number" min="0" max="100000" [value]="t.income" (change)="setType(t.id, { income: num($event, 0, 100000) })"></label>
                                    <label>Scenario when attacked
                                        <select class="bt-select" (change)="setType(t.id, { trackId: $any($event.target).value })">
                                            <option value="">None</option>
                                            @for (tr of tracks(); track tr.id) { <option [value]="tr.id" [selected]="tr.id === t.trackId">{{ tr.name }}</option> }
                                        </select>
                                    </label>
                                    @for (s of systems(); track s) {
                                        <label>Terrain ({{ systemLabel[s] }}) <input class="bt-input" type="text" [value]="t.terrain[s] || ''" (change)="setTerrain(t, s, $any($event.target).value)"></label>
                                    }
                                </div>
                                <div class="cp-row">
                                    <label><input type="checkbox" [checked]="!!t.lz" (change)="setType(t.id, { lz: $any($event.target).checked ? 'lz' : '' })"> Landing zone / base</label>
                                    <label><input type="checkbox" [checked]="t.hq" (change)="setType(t.id, { hq: $any($event.target).checked })"> HQ</label>
                                    <label><input type="checkbox" [checked]="t.strategic" (change)="setType(t.id, { strategic: $any($event.target).checked })"> Strategic point</label>
                                    <label><input type="checkbox" [checked]="t.impassable" (change)="setType(t.id, { impassable: $any($event.target).checked })"> No entry</label>
                                    <label><input type="checkbox" [checked]="t.noBattle" (change)="setType(t.id, { noBattle: $any($event.target).checked })"> No battle</label>
                                </div>
                                @for (L of effectLists(t); track L.list) {
                                    <span class="cp-label">{{ L.label }}</span>
                                    @for (e of t[L.list]; track $index; let i = $index) {
                                        <div class="me-effect">
                                            <div class="cp-row">
                                                <b>{{ kindLabel[e.kind] }}</b>
                                                @for (f of fields[e.kind]; track f) {
                                                    @if (f === 'target') {
                                                        <select class="bt-select" [attr.aria-label]="fieldLabel[f]" (change)="setEffect(t, L.list, i, f, $any($event.target).value)">
                                                            <option value="">{{ fieldLabel[f] }}</option>
                                                            @for (x of draft().hexTypes; track x.id) { <option [value]="x.id" [selected]="x.id === e.target">{{ x.name }}</option> }
                                                        </select>
                                                    } @else if (f === 'sign') {
                                                        <select class="bt-select" aria-label="Sign" (change)="setEffect(t, L.list, i, f, $any($event.target).value)">
                                                            <option value="-1" [selected]="(e.sign ?? -1) < 0">−</option>
                                                            <option value="1" [selected]="(e.sign ?? -1) > 0">+</option>
                                                        </select>
                                                    } @else {
                                                        <label class="me-field">{{ fieldLabel[f] }}
                                                            <input class="bt-input" [class.me-num]="!textFields.has(f)" [type]="textFields.has(f) ? 'text' : 'number'" [value]="e[f] ?? ''" (change)="setEffect(t, L.list, i, f, $any($event.target).value)">
                                                        </label>
                                                    }
                                                }
                                                <button type="button" class="bt-button tiny" (click)="removeEffect(t, L.list, i)">Remove</button>
                                            </div>
                                            <small class="cp-muted">{{ describe(e) }}</small>
                                        </div>
                                    }
                                    @if (t[L.list].length < effectMax) {
                                        <select class="bt-select me-add" [attr.aria-label]="'Add to ' + L.label" (change)="addEffect(t, L.list, $event)">
                                            <option value="">Add effect…</option>
                                            @for (k of kinds; track k) { <option [value]="k">{{ kindLabel[k] }}</option> }
                                        </select>
                                    }
                                }
                            }
                        </section>
                    }
                    @case ('Grid') {
                        <section class="cp-card">
                            <div class="cp-grid">
                                <label>Columns <input class="bt-input" type="number" min="1" [max]="maxSide" [value]="draft().cols" (change)="resize(num($event, 1, maxSide), draft().rows)"></label>
                                <label>Rows <input class="bt-input" type="number" min="1" [max]="maxSide" [value]="draft().rows" (change)="resize(draft().cols, num($event, 1, maxSide))"></label>
                            </div>
                            <p class="cp-muted me-small">Up to {{ maxSide }}×{{ maxSide }}. Shrinking drops the hexes left outside (Undo brings them back).</p>
                            <label class="cp-block">Background image (scaled and compressed to {{ (imageCap / 1e6).toFixed(1) }} MB or less)
                                <input type="file" accept="image/*" (change)="onImage($event)">
                            </label>
                            @if (draft().image) {
                                <div class="cp-row">
                                    <span class="cp-muted">{{ (draft().image.length / 1e6).toFixed(2) }} MB</span>
                                    <button type="button" class="bt-button tiny" (click)="clearImage()">Remove image</button>
                                </div>
                            }
                            <label><input type="checkbox" [checked]="addContract()" (change)="addContract.set($any($event.target).checked)" [disabled]="hasContract()"> {{ hasContract() ? 'A contract plays on this map' : 'Add a contract that plays on this map when saving' }}</label>
                        </section>
                    }
                    @case ('Rules') {
                        @if (draft().rules; as r) {
                            <section class="cp-card">
                                <div class="cp-grid">
                                    @for (k of ruleKeys; track k) {
                                        <label>{{ ruleLabel[k] }} <input class="bt-input" type="number" [min]="ranges[k][0]" [max]="ranges[k][1]" [value]="r[k]" (change)="setRuleNum(k, $event)"></label>
                                    }
                                </div>
                                <div class="cp-row">
                                    <label><input type="checkbox" [checked]="r.purchaseNeedsHex" (change)="setRules({ purchaseNeedsHex: $any($event.target).checked })"> 'Mech purchases need a purchase hex</label>
                                    <label><input type="checkbox" [checked]="r.recruitNeedsHex" (change)="setRules({ recruitNeedsHex: $any($event.target).checked })"> Hiring needs a recruit hex</label>
                                </div>
                                <h4>Victory</h4>
                                <div class="cp-row">
                                    <label><input type="checkbox" [checked]="r.victory.turns" (change)="setVictory({ turns: $any($event.target).checked })"> Last turn: higher Warchest wins</label>
                                    <label><input type="checkbox" [checked]="r.victory.zeroSp" (change)="setVictory({ zeroSp: $any($event.target).checked })"> A side at 0 SP loses</label>
                                    <label><input type="checkbox" [checked]="r.victory.captureHq" (change)="setVictory({ captureHq: $any($event.target).checked })"> Capturing the enemy landing zone wins</label>
                                </div>
                                <div class="cp-grid">
                                    <label>Hold strategic points (turns, 0 = off) <input class="bt-input" type="number" min="0" [max]="holdMax" [value]="r.victory.holdTurns" (change)="setVictory({ holdTurns: num($event, 0, holdMax) })"></label>
                                </div>
                                <h4>Final battle</h4>
                                <div class="cp-grid">
                                    <label class="me-check"><span><input type="checkbox" [checked]="r.final.enabled" (change)="setFinal({ enabled: $any($event.target).checked })"> Play a final battle</span></label>
                                    <label>Track
                                        <select class="bt-select" (change)="setFinal({ trackId: $any($event.target).value })">
                                            <option value="">None</option>
                                            @for (tr of tracks(); track tr.id) { <option [value]="tr.id" [selected]="tr.id === r.final.trackId">{{ tr.name }}</option> }
                                        </select>
                                    </label>
                                    <label>Support
                                        <select class="bt-select" (change)="setSupport($any($event.target).value)">
                                            <option value="" [selected]="r.final.support == null">Contract terms</option>
                                            @for (s of supportSteps; track s) { <option [value]="s" [selected]="s === r.final.support">{{ stepLabel('support', s) }}</option> }
                                        </select>
                                    </label>
                                    <label>BSP each side <input class="bt-input" type="number" min="0" [max]="finalBspMax" [value]="r.final.bsp" (change)="setFinal({ bsp: num($event, 0, finalBspMax) })"></label>
                                </div>
                                <span class="cp-label">Objective payouts</span>
                                @for (po of r.final.payouts; track $index; let i = $index) {
                                    <div class="cp-row">
                                        <input class="bt-input" type="text" aria-label="Objective" placeholder="Objective" [value]="po.name" (change)="setPayout(i, { name: $any($event.target).value })">
                                        <input class="bt-input me-num" type="number" aria-label="SP" min="0" [value]="po.sp" (change)="setPayout(i, { sp: num($event, 0, payoutSpMax) })"> SP
                                        <button type="button" class="bt-button tiny" (click)="removePayout(i)">Remove</button>
                                    </div>
                                }
                                <div class="cp-row">
                                    <button type="button" class="bt-button tiny" [disabled]="r.final.payouts.length >= payoutMax" (click)="addPayout()">Add payout</button>
                                    <button type="button" class="bt-button tiny" (click)="resetRules()">Reset rules to defaults</button>
                                </div>
                            </section>
                        }
                    }
                }
            </div>
        </div>

    `,
    styles: `
        .me-head { align-items: flex-end; }
        .me-name { display: flex; flex-direction: column; flex: 1 1 200px; font-size: 0.85em; color: var(--text-color-secondary); }
        .me-small { font-size: 0.85em; margin: 0; }
        .me-issues { max-height: 9em; overflow: auto; }
        .me-layout { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(300px, 1fr); gap: 12px; align-items: start; }
        @media (max-width: 900px) { .me-layout { grid-template-columns: minmax(0, 1fr); } }
        .me-palette { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        .me-palette .bt-button { min-height: 40px; display: inline-flex; align-items: center; gap: 6px; }
        .me-swatch { display: inline-block; width: 16px; height: 16px; border: 1px solid #0006; }
        .me-effect { border-left: 2px solid var(--border-color); padding-left: 8px; margin: 6px 0; }
        .me-field { display: flex; flex-direction: column; font-size: 0.8em; color: var(--text-color-secondary); }
        .me-num { width: 6em; }
        .me-add { margin: 4px 0 10px; }
        .bt-button.selected { outline: 2px solid var(--bt-yellow); }
        label { cursor: pointer; }
    `,
})
export class MapEditorComponent {
    protected readonly svc = inject(CampaignService);
    private readonly dialogs = inject(DialogsService);

    /** The map to edit; a map not yet in the publication is added on save. */
    readonly map = input.required<CampaignMap>();
    readonly closed = output<void>();

    protected readonly tabs = ['Hexes', 'Hex types', 'Grid', 'Rules'] as const;
    protected readonly tab = signal<(typeof this.tabs)[number]>('Hexes');
    protected readonly draft = linkedSignal(() => this.map());
    protected readonly history = signal<CampaignMap[]>([]);
    protected readonly dirty = signal(false);
    protected readonly painting = signal(true);
    protected readonly selHex = signal('');
    protected readonly toolId = signal('');
    protected readonly problem = signal('');
    protected readonly status = signal('');

    protected readonly defaultType = HEX_DEFAULT;
    protected readonly maxSide = MAX_MAP_SIDE;
    protected readonly imageCap = MAX_MAP_IMAGE_CHARS;
    protected readonly holdMax = HOLD_TURNS_MAX;
    protected readonly finalBspMax = FINAL_BSP_MAX;
    protected readonly payoutMax = MAX_PAYOUTS;
    protected readonly effectMax = MAX_EFFECTS;
    protected readonly ranges = MAP_RULE_RANGES;
    protected readonly ruleKeys = Object.keys(MAP_RULE_RANGES) as MapRuleNum[];
    protected readonly ruleLabel = RULE_LABEL;
    protected readonly kindLabel = KIND_LABEL;
    protected readonly kinds = EFFECT_KINDS;
    protected readonly fields = EFFECT_FIELDS;
    protected readonly fieldLabel = FIELD_LABEL;
    protected readonly textFields = TEXT_FIELDS;
    protected readonly systemLabel = SYSTEM_LABEL;
    protected readonly supportSteps = selectableSteps('support');
    protected readonly stepLabel = stepLabel;
    protected readonly payoutSpMax = PAYOUT_SP_MAX;
    /** A number input's value, clamped; the input shows the clamped value even when the model doesn't change. */
    protected num(ev: Event, lo: number, hi: number): number {
        const el = ev.target as HTMLInputElement;
        const v = clampInt(el.value, lo, hi);
        el.value = String(v);
        return v;
    }

    private readonly emptyPub = newPublication();
    protected readonly tracks = computed(() => this.svc.pub()?.tracks ?? []);
    protected readonly systems = computed(() => this.svc.pub()?.systems ?? [GameSystem.CLASSIC]);
    protected readonly hasContract = computed(() => !!this.svc.pub()?.contracts.some(c => c.mapId === this.draft().id));
    protected readonly addContract = signal(true);

    /** The publication as it would be saved, validated on every edit. */
    private readonly candidate = computed(() => {
        const m = this.draft();
        const pub = withMap(this.svc.pub() ?? this.emptyPub, m);
        return this.addContract() ? withMapContract(pub, m) : pub;
    });
    // ponytail: validates the whole publication per edit; scope validate() to one map if large publications lag
    protected readonly mapIssues = computed(() => validate(this.candidate()).filter(i => i.coll === 'maps' && i.id === this.draft().id));
    protected readonly errors = computed(() => this.mapIssues().filter(i => i.level === 'error'));
    protected readonly warnCount = computed(() => this.mapIssues().filter(i => i.level === 'warn').length);

    protected readonly tool = computed(() => {
        const ts = this.draft().hexTypes;
        return ts.find(t => t.id === this.toolId()) ?? ts.find(t => t.id !== HEX_DEFAULT && !t.impassable) ?? ts[0];
    });
    protected readonly counts = computed(() => {
        const out: Record<string, number> = {};
        for (const h of Object.values(this.draft().hexes)) if (h?.t) out[h.t] = (out[h.t] || 0) + 1;
        return out;
    });
    protected readonly hexInfo = computed(() => {
        const id = this.selHex();
        const m = this.draft();
        return id ? { id, hex: m.hexes[id] ?? {}, type: hexType(m, id) } : null;
    });

    /** Apply one edit; `snapshot` keeps the previous map for Undo (a paint stroke snapshots once). */
    protected edit(fn: (m: CampaignMap) => CampaignMap, snapshot = true): void {
        const cur = this.draft();
        let next: CampaignMap;
        try {
            next = fn(cur);
        } catch (e) {
            this.problem.set((e as Error).message);
            return;
        }
        this.problem.set('');
        if (next === cur) return;
        if (snapshot) this.history.update(h => [...h.slice(-(UNDO_DEPTH - 1)), cur]);
        this.draft.set(next);
        this.dirty.set(true);
        this.status.set('');
    }
    protected undo(): void {
        const h = this.history();
        if (!h.length) return;
        this.draft.set(h[h.length - 1]);
        this.history.set(h.slice(0, -1));
        this.dirty.set(true);
    }

    protected paintAt(e: { hex: string; start: boolean }): void {
        const id = this.tool().id;
        this.edit(m => paintHex(m, e.hex, id), e.start);
    }
    protected tapHex(hex: string): void {
        if (!this.painting()) this.selHex.set(this.selHex() === hex ? '' : hex);
    }
    protected pickTool(id: string): void {
        this.toolId.set(id);
    }
    protected resize(cols: unknown, rows: unknown): void {
        this.edit(m => resizeMap(m, Number(cols), Number(rows)));
        if (this.selHex() && !inMap(this.draft(), this.selHex())) this.selHex.set('');
    }
    protected setName(v: string): void {
        this.edit(m => ({ ...m, name: v.trim() || m.name }));
    }
    protected patchHex(id: string, patch: Partial<MapHex>): void {
        this.edit(m => setHex(m, id, patch));
    }
    protected clearImage(): void {
        this.edit(m => setImage(m, ''));
    }

    // ---------- hex types ----------

    protected setType(id: string, patch: Partial<Omit<HexType, 'id'>>): void {
        this.edit(m => updateHexType(m, id, patch));
    }
    protected setTerrain(t: HexType, sys: GameSystem, v: string): void {
        this.setType(t.id, { terrain: { ...t.terrain, [sys]: v } });
    }
    protected newType(): void {
        const t = newHexType();
        this.edit(m => addHexType(m, t));
        if (this.draft().hexTypes.some(x => x.id === t.id)) this.toolId.set(t.id);
    }
    protected async removeType(): Promise<void> {
        const t = this.tool();
        const n = this.counts()[t.id] || 0;
        const into = this.draft().hexTypes.find(x => x.id === HEX_DEFAULT)?.name || 'the default type';
        if (!(await this.dialogs.requestConfirmation(`Delete hex type "${t.name}"? ${n} hex(es) become ${into}; effects aimed at it are removed.`, 'Delete hex type', 'warning'))) return;
        this.edit(m => deleteHexType(m, t.id));
        this.toolId.set('');
    }
    protected effectLists(t: HexType): { list: EffectList; label: string }[] {
        const out: { list: EffectList; label: string }[] = [{ list: 'effects', label: 'Effects while held (recruit options, income …)' }];
        if (t.lz) out.push({ list: 'lzEffects', label: 'Effects of landing here (dice rolled at landing)' });
        return out;
    }
    protected addEffect(t: HexType, list: EffectList, ev: Event): void {
        const sel = ev.target as HTMLSelectElement;
        const kind = sel.value;
        sel.value = '';
        if (!kind) return;
        this.edit(m => setEffects(m, t.id, list, [...t[list], newMapEffect(kind as MapEffectKind)]));
    }
    protected removeEffect(t: HexType, list: EffectList, i: number): void {
        this.edit(m => setEffects(m, t.id, list, t[list].filter((_, j) => j !== i)));
    }
    protected setEffect(t: HexType, list: EffectList, i: number, key: keyof MapEffect, raw: string): void {
        const v = TEXT_FIELDS.has(key) ? raw.trim() : Number(raw) || 0;
        this.edit(m => setEffects(m, t.id, list, t[list].map((e, j) => (j === i ? { ...e, [key]: v } : e))));
    }
    protected describe(e: MapEffect): string {
        return describeEffect(this.draft(), e, this.systems()[0]);
    }

    // ---------- rules ----------

    protected setRules(patch: Partial<MapRules>): void {
        this.edit(m => ({ ...m, rules: { ...m.rules, ...patch } }));
    }
    protected setRuleNum(k: MapRuleNum, ev: Event): void {
        const [lo, hi] = MAP_RULE_RANGES[k];
        this.setRules({ [k]: this.num(ev, lo, hi) });
    }
    protected setVictory(patch: Partial<MapRules['victory']>): void {
        this.edit(m => ({ ...m, rules: { ...m.rules, victory: { ...m.rules.victory, ...patch } } }));
    }
    protected setFinal(patch: Partial<MapRules['final']>): void {
        this.edit(m => ({ ...m, rules: { ...m.rules, final: { ...m.rules.final, ...patch } } }));
    }
    protected setSupport(v: string): void {
        this.setFinal({ support: v === '' ? null : Number(v) });
    }
    protected setPayout(i: number, patch: Partial<{ name: string; sp: unknown }>): void {
        const ps = this.draft().rules.final.payouts.map((p, j) => (j === i ? { ...p, ...patch } : p)) as MapRules['final']['payouts'];
        this.setFinal({ payouts: clampPayouts(ps) });
    }
    protected addPayout(): void {
        this.setFinal({ payouts: clampPayouts([...this.draft().rules.final.payouts, { name: '', sp: 0 }]) });
    }
    protected removePayout(i: number): void {
        this.setFinal({ payouts: this.draft().rules.final.payouts.filter((_, j) => j !== i) });
    }
    protected resetRules(): void {
        this.edit(m => ({ ...m, rules: newCampaignMap().rules }));
    }

    // ---------- files ----------

    protected async onImage(e: Event): Promise<void> {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        try {
            const url = await embedImage(file);
            this.edit(m => setImage(m, url));
        } catch (err) {
            this.problem.set((err as Error).message);
        }
    }

    protected async save(): Promise<boolean> {
        if (this.errors().length) return false;
        const r = await this.svc.saveMap(this.draft(), this.addContract());
        if (!r) {
            this.problem.set(this.svc.error());
            return false;
        }
        this.dirty.set(false);
        const parts = [`Saved into ${this.svc.pub()?.title}`];
        if (r.updated) parts.push(`${r.updated} saved campaign(s) get it on next load`);
        if (r.kept) parts.push(`${r.kept} campaign(s) playing this map keep their copy`);
        this.status.set(parts.join('; ') + '.');
        return true;
    }
    protected async exportJson(): Promise<void> {
        if (!(await this.save())) return;
        const pub = this.svc.pub()!;
        downloadText(`${pub.title.replace(/[^\w-]+/g, '_') || 'publication'}.publication.json`, JSON.stringify(pub, null, 2));
    }
    protected async close(): Promise<void> {
        if (this.dirty() && !(await this.dialogs.requestConfirmation('Close the map editor and discard unsaved changes?', 'Discard changes', 'warning'))) return;
        this.closed.emit();
    }
}
