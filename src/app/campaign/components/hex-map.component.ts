// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MapSide } from '../core/campaign.model';
import { allHexes, hexCenter, hexName, hexPoints, hexType, mapPixelSize } from '../core/hex-map';
import type { CampaignMap } from '../core/publication.model';

export interface HexMarker {
    hex: string;
    label: string;
    side: MapSide;
    selected: boolean;
}

/** The publication's hex map as SVG: terrain, names, ownership, objectives, markers and the selected formation's reach. */
@Component({
    selector: 'hex-map',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="hm-tools">
            <button type="button" class="bt-button tiny" (click)="zoom(-6)" aria-label="Zoom out">−</button>
            <button type="button" class="bt-button tiny" (click)="zoom(6)" aria-label="Zoom in">+</button>
        </div>
        <div class="hm-scroll">
            <svg [attr.viewBox]="'0 0 ' + px().w + ' ' + px().h" [attr.width]="px().w" [attr.height]="px().h" role="group" aria-label="Campaign map"
                [class.hm-painting]="paint()" (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up()" (pointercancel)="up()" (lostpointercapture)="up()">
                @if (image()) { <image [attr.href]="image()" x="0" y="0" [attr.width]="px().w" [attr.height]="px().h" preserveAspectRatio="none" opacity="0.5" /> }
                @for (h of cells(); track h.id) {
                    <g class="hm-hex" [class.hm-imp]="h.impassable" [class.hm-reach]="h.steps != null" [class.hm-sel]="h.id === selected()"
                        role="button" [attr.data-hex]="h.id" [attr.aria-label]="h.id + ' ' + h.title" (click)="hexTap.emit(h.id)">
                        <title>{{ h.id }} {{ h.title }}</title>
                        <polygon [attr.points]="h.points" [attr.fill]="h.color" [attr.fill-opacity]="image() ? 0.55 : 0.9"
                            [attr.stroke]="h.owner === 'us' ? '#3d8bfd' : h.owner === 'them' ? '#e5534b' : '#5c574d'" [attr.stroke-width]="h.owner ? 3 : 0.8" />
                        <text class="hm-id" [attr.x]="h.x" [attr.y]="h.y - size() * 0.58">{{ h.id }}</text>
                        @if (h.badge) { <text class="hm-badge" [attr.x]="h.x" [attr.y]="h.y - size() * 0.2">{{ h.badge }}</text> }
                        @if (h.name) { <text class="hm-name" [attr.x]="h.x" [attr.y]="h.y + size() * 0.72">{{ h.name }}</text> }
                        @if (h.steps != null && !h.markers.length) { <text class="hm-steps" [attr.x]="h.x" [attr.y]="h.y + size() * 0.25">→{{ h.steps }}</text> }
                        @for (m of h.markers; track $index) {
                            <g class="hm-marker" [class.hm-them]="m.side === 'them'" [class.hm-msel]="m.selected">
                                <circle [attr.cx]="h.x + m.dx" [attr.cy]="h.y + size() * 0.18" [attr.r]="size() * 0.34" />
                                <text [attr.x]="h.x + m.dx" [attr.y]="h.y + size() * 0.18 + size() * 0.13">{{ m.label }}</text>
                            </g>
                        }
                    </g>
                }
            </svg>
        </div>
    `,
    styles: `
        :host { display: block; }
        .hm-tools { display: flex; gap: 6px; margin-bottom: 6px; }
        .hm-tools .bt-button { min-width: 40px; min-height: 36px; font-size: 1.2em; }
        .hm-scroll { overflow: auto; max-height: 70vh; touch-action: pan-x pan-y; border: 1px solid var(--border-color); }
        svg { display: block; user-select: none; }
        svg.hm-painting { touch-action: none; }
        .hm-hex { cursor: pointer; }
        .hm-imp { cursor: not-allowed; }
        .hm-reach polygon { stroke: #f5c518; stroke-width: 3; }
        .hm-sel polygon { stroke: #fff; stroke-width: 3.5; }
        text { text-anchor: middle; pointer-events: none; fill: #1b1a17; font-family: inherit; }
        .hm-id { font-size: 8px; opacity: 0.7; }
        .hm-badge { font-size: 11px; font-weight: bold; }
        .hm-name { font-size: 8px; font-weight: bold; }
        .hm-steps { font-size: 12px; font-weight: bold; fill: #6b4f00; }
        .hm-marker circle { fill: #1f5fbf; stroke: #fff; stroke-width: 1.5; }
        .hm-marker text { fill: #fff; font-size: 10px; font-weight: bold; }
        .hm-them circle { fill: #b3261e; }
        .hm-msel circle { stroke: #f5c518; stroke-width: 3; }
    `,
})
export class HexMapComponent {
    readonly map = input.required<CampaignMap>();
    readonly owner = input<Record<string, MapSide>>({});
    readonly markers = input<HexMarker[]>([]);
    /** Hexes the selected formation can reach, with the hexes it takes. */
    readonly reach = input<Map<string, number> | null>(null);
    readonly selected = input('');
    /** Landing-zone and enemy-HQ hexes, labelled on the map. */
    readonly lz = input<{ us: string; them: string }>({ us: '', them: '' });
    readonly hexTap = output<string>();
    /** Paint mode: pressing and dragging over hexes emits each hex once per stroke (`start` on the first). Touch drags paint instead of scrolling. */
    readonly paint = input(false);
    readonly hexPaint = output<{ hex: string; start: boolean }>();

    private stroke: Set<string> | null = null;
    private hexUnder(e: PointerEvent): string {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-hex]');
        return el?.getAttribute('data-hex') || '';
    }
    protected down(e: PointerEvent): void {
        if (!this.paint() || e.button > 0) return;
        const hex = this.hexUnder(e);
        if (!hex) return;
        e.preventDefault();
        this.stroke = new Set([hex]);
        this.hexPaint.emit({ hex, start: true });
    }
    protected move(e: PointerEvent): void {
        if (!this.stroke) return;
        if (!e.buttons) return this.up(); // released outside the map
        const hex = this.hexUnder(e);
        if (!hex || this.stroke.has(hex)) return;
        this.stroke.add(hex);
        this.hexPaint.emit({ hex, start: false });
    }
    protected up(): void {
        this.stroke = null;
    }

    protected readonly size = signal(30);
    protected zoom(d: number): void {
        this.size.update(s => Math.min(54, Math.max(18, s + d)));
    }
    protected readonly px = computed(() => {
        const { w, h } = mapPixelSize(this.map(), this.size());
        return { w: Math.ceil(w), h: Math.ceil(h) };
    });
    /** Only embedded images: a remote URL in imported data would be fetched on every view. */
    protected readonly image = computed(() => (this.map().image?.startsWith('data:image/') ? this.map().image : ''));

    /** Geometry depends on the map and zoom only; ownership, markers and reach are layered on per change. */
    private readonly base = computed(() => {
        const map = this.map();
        const size = this.size();
        return allHexes(map).map(id => {
            const t = hexType(map, id);
            const { x, y } = hexCenter(id, size);
            const end = map.hexes[id]?.end;
            const badge = t.hq || t.lz ? (end ? `LZ ${end}` : 'LZ') : t.strategic ? '★' : t.income ? `${t.income}` : '';
            return { id, x, y, points: hexPoints(x, y, size - 0.8), color: t.color || '#ccc', impassable: t.impassable, name: hexName(map, id), title: t.name, badge };
        });
    });
    protected readonly cells = computed(() => {
        const owner = this.owner();
        const reach = this.reach();
        const lz = this.lz();
        const s = this.size();
        const byHex = new Map<string, HexMarker[]>();
        for (const m of this.markers()) byHex.set(m.hex, [...(byHex.get(m.hex) || []), m]);
        return this.base().map(h => {
            const ms = byHex.get(h.id) || [];
            const badge = h.id === lz.us ? 'Base' : h.id === lz.them ? 'Enemy HQ' : h.badge;
            return { ...h, badge, owner: owner[h.id], steps: reach?.get(h.id), markers: ms.map((m, i) => ({ ...m, dx: (i - (ms.length - 1) / 2) * s * 0.7 })) };
        });
    });
}
