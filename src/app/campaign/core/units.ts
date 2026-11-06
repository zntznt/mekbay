// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The slice of a MekBay unit the campaign engine reads. MekBay's `UnitSummary`
 * is structurally assignable to it, so the app can hand its catalog lookup in
 * directly while the core stays free of services.
 */
export interface CampaignUnitData {
    /** MekBay unit name; the campaign's unit identifier. */
    name: string;
    chassis: string;
    model: string;
    type: string;
    subtype: string;
    tons: number;
    bv: number;
    techBase: string;
    year?: number;
    omni?: number;
    as: { PV: number; SZ: number; specials: readonly string[] };
}

/** Resolves a MekBay unit name to its data. */
export type UnitLookup = (name: string) => CampaignUnitData | undefined;

export type UnitGroup = 'Mek' | 'Vehicle' | 'Battle Armor' | 'Infantry' | 'ProtoMek' | 'Aero' | 'Other';

export const isMek = (u: CampaignUnitData | undefined): boolean => u?.type === 'Mek';
export const isVehicle = (u: CampaignUnitData | undefined): boolean =>
    !!u && (u.type === 'Tank' || u.type === 'VTOL' || u.type === 'Naval');
export const isBattleArmor = (u: CampaignUnitData | undefined): boolean =>
    !!u && u.type === 'Infantry' && u.subtype === 'Battle Armor';
export const isOmni = (u: CampaignUnitData | undefined): boolean => !!u && (!!u.omni || /omni/i.test(u.subtype));

export function unitGroup(u: CampaignUnitData): UnitGroup {
    if (u.type === 'Mek') return 'Mek';
    if (isVehicle(u)) return 'Vehicle';
    if (isBattleArmor(u)) return 'Battle Armor';
    if (u.type === 'Infantry') return 'Infantry';
    if (u.type === 'ProtoMek') return 'ProtoMek';
    if (u.type === 'Aero') return 'Aero';
    return 'Other';
}

/** Unit count weight: conventional infantry count half; battle armor is a full unit (R-11). */
export function unitCountWeight(u: CampaignUnitData | undefined): number {
    if (!u) return 1;
    return u.type === 'Infantry' && u.subtype !== 'Battle Armor' ? 0.5 : 1;
}

/** Lookup over a fixed list, keyed by name. Handy for tests and offline fixtures. */
export function unitLookupFrom(units: readonly CampaignUnitData[]): UnitLookup {
    const byName = new Map(units.map(u => [u.name, u]));
    return name => byName.get(name);
}
