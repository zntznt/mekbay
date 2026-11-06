// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';

/*
 * Opponent modules attach to a campaign and drive the opposing force. Each
 * module carries its own `system`: a module is written for one game system,
 * independently of whichever system the campaign tracks its own force in.
 *
 * ACES (BattleTech Aces, card-driven solo opponent) is published for Alpha
 * Strike only. A Classic edition is expected, so the state below is keyed by
 * `GameSystem` rather than hard-wired to Alpha Strike. Only the state shape is
 * defined here; no ACES rules are implemented, and none are invented for Classic.
 */

/** Command card letters. */
export type AcesCommandCard = 'A' | 'B' | 'C' | 'D' | 'E';
export const ACES_COMMAND_CARDS: readonly AcesCommandCard[] = ['A', 'B', 'C', 'D', 'E'];

/** Role key as printed on the cards of the module's system (e.g. a deck per role). */
export type AcesRole = string;

/** One role's deck: card ids in draw order, plus the discards. */
export interface AcesDeck {
    drawPile: string[];
    discardPile: string[];
}

/** An opposing unit under ACES control. */
export interface AcesUnit {
    /** MekBay unit name. */
    unit: string;
    role: AcesRole;
    /** Priority number used to order activations and targets. */
    priority: number;
    keywords: string[];
}

export type InitiativeWinner = 'player' | 'opponent';

/** Initiative state, tracking repeat winners so a penalty can be applied. */
export interface AcesInitiative {
    lastWinner: InitiativeWinner | null;
    /** Consecutive wins by `lastWinner`. */
    streak: number;
    /** Modifier currently applied against the repeat winner. */
    repeatWinnerPenalty: number;
}

/** One sortie (battle) run by the module, for the campaign record. */
export interface AcesSortie {
    id: string;
    date: string;
    contractRef: string;
    /** Track record id once the battle is applied. */
    trackRef: string;
    turns: number;
    result: string;
    note: string;
}

export interface AcesState<S extends GameSystem = GameSystem> {
    kind: 'aces';
    system: S;
    turn: number;
    commandCard: AcesCommandCard | null;
    decks: Record<AcesRole, AcesDeck>;
    units: AcesUnit[];
    initiative: AcesInitiative;
    /** Keywords active for the current battle. */
    keywords: string[];
    sorties: AcesSortie[];
}

/** Every opponent module the campaign can carry. */
export type OpponentModule = AcesState;
export type OpponentKind = OpponentModule['kind'];

/** Systems with a published ACES edition. Add Classic here once it exists. */
export const ACES_SYSTEMS: ReadonlySet<GameSystem> = new Set([GameSystem.ALPHA_STRIKE]);

export function acesAvailable(system: GameSystem): boolean {
    return ACES_SYSTEMS.has(system);
}

/** Empty ACES state for a system with a published edition. */
export function newAcesState<S extends GameSystem>(system: S): AcesState<S> {
    if (!acesAvailable(system)) throw new Error(`ACES has no published edition for ${system}.`);
    return {
        kind: 'aces', system, turn: 0, commandCard: null, decks: {}, units: [],
        initiative: { lastWinner: null, streak: 0, repeatWinnerPenalty: 0 }, keywords: [], sorties: [],
    };
}
