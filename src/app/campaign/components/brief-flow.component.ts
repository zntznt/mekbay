// SPDX-License-Identifier: GPL-3.0-or-later

import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { GameSystem } from '../../models/common.model';
import { byId, vget, type Publication } from '../core/publication.model';
import type { FlowMonth, FlowNode, FlowState } from '../core/script';

const STATE_LABEL: Record<FlowState, string> = {
    won: 'won', lost: 'lost', draw: 'no winner', next: 'next', waiting: 'decide', open: '', off: 'not taken',
};

/** The contract's mission brief as a read-only tree: path taken, branches, and choices to resolve. */
@Component({
    selector: 'brief-flow',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [NgTemplateOutlet],
    styleUrls: ['./campaign.shared.scss'],
    styles: `
        .cp-flow { margin: 0; padding-left: 18px; }
        .cp-flow ul { margin: 2px 0; padding-left: 16px; list-style: none; }
        .cp-flow li { margin: 2px 0; }
        .cp-flow > li:not(.current) { color: var(--text-color-secondary); }
        .off { opacity: 0.45; }
        .tag { font-size: 0.75em; text-transform: uppercase; margin-left: 6px; color: var(--text-color-tertiary); }
        .won .tag, .next .tag, .waiting .tag { color: var(--bt-yellow); }
        .lost .tag { color: var(--danger); }
        .branch { color: var(--text-color-tertiary); }
        .branch.taken { color: var(--text-color); }
        .detail { margin: 4px 0 6px; padding: 6px 8px; border-left: 2px solid var(--bt-yellow); color: var(--text-color); }
        .detail p { margin: 0 0 4px; white-space: pre-line; }
    `,
    template: `
        <ng-template #list let-nodes>
            <ul>
                @for (n of asNodes(nodes); track n.key + $index) {
                    <li [class]="n.state">
                        {{ n.text }}@if (n.kind === 'track') { <small class="cp-muted"> · you {{ n.attacking ? 'attack' : 'defend' }}</small> }<span class="tag">{{ stateLabel[n.state] }}</span>
                        @if (n.state === 'next' && n.trackId) { <ng-container *ngTemplateOutlet="detail; context: { $implicit: n }" /> }
                        @for (b of n.branches || []; track $index) {
                            <div class="branch" [class.taken]="b.taken">
                                {{ b.label }}{{ b.taken === false ? ' (not taken)' : '' }}
                                @if (n.state === 'waiting' && n.kind === 'choice') {
                                    <button type="button" class="bt-button tiny" (click)="choose.emit({ key: n.key, idx: $index })">Choose</button>
                                }
                            </div>
                            @if (b.nodes.length) { <ng-container *ngTemplateOutlet="list; context: { $implicit: b.nodes }" /> }
                        }
                    </li>
                }
            </ul>
        </ng-template>

        <ng-template #detail let-n>
            @if (track(n); as t) {
                <div class="detail">
                    @if (t.situation) { <p>{{ t.situation }}</p> }
                    @if (t.objectives.length) {
                        <span class="cp-label">Objectives</span>
                        <ul class="cp-list">
                            @for (o of t.objectives; track $index) { <li>{{ o.name }}{{ o.text ? ': ' + o.text : '' }}</li> }
                        </ul>
                    }
                    <small class="cp-muted">Ends after {{ t.turns }} turns{{ t.endText ? ' · ' + t.endText : '' }} · Salvage: {{ t.salvage }}</small>
                </div>
            }
        </ng-template>

        <ol class="cp-flow">
            @for (m of months(); track m.n) {
                <li [class.current]="m.current">
                    <strong>Month {{ m.n }}</strong>@if (m.current) { <span class="tag">now</span> }
                    @if (m.note) { <div class="cp-muted">{{ m.note }}</div> }
                    @if (m.nodes.length) { <ng-container *ngTemplateOutlet="list; context: { $implicit: m.nodes }" /> } @else { <div class="cp-muted">No tracks.</div> }
                </li>
            }
        </ol>
    `,
})
export class BriefFlowComponent {
    readonly months = input.required<FlowMonth[]>();
    readonly pub = input.required<Publication>();
    readonly system = input.required<GameSystem>();
    readonly choose = output<{ key: string; idx: number }>();

    protected readonly stateLabel = STATE_LABEL;
    /** Template context variables are untyped. */
    protected readonly asNodes = (x: unknown) => x as FlowNode[];

    /** Briefing for a track node: publication text for the campaign's game system. */
    protected track(x: unknown) {
        const n = x as FlowNode;
        const t = byId(this.pub(), 'tracks', n.trackId);
        if (!t) return null;
        const sys = this.system();
        return {
            situation: vget(t.situation, sys) || '',
            objectives: t.objectives.map(o => ({ name: o.name, text: vget(o.text, sys) || '' })),
            turns: t.end[sys],
            endText: t.end.text,
            salvage: t.salvage,
        };
    }
}
