// SPDX-License-Identifier: GPL-3.0-or-later

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { GameSystem } from '../models/common.model';
import type { LoadForceEntry } from '../models/load-force-entry.model';
import { DataService } from '../services/data.service';
import { ForceBuilderService } from '../services/force-builder.service';
import { CampaignService } from './campaign.service';
import { CampaignStorageService, type CampaignSave } from './campaign-storage.service';
import { lookup, makeMap, makeMapPublication, makePublication, UNITS } from './core/testing/fixtures';
import { paintHex, starterMap } from './core/map-edit';

const RAISED = { basePay: 8, support: 8, transport: 7, salvage: 7, command: 7 };

describe('CampaignService', () => {
    let svc: CampaignService;
    let saved: Map<string, CampaignSave>;
    let createGeneratedForce: jasmine.Spy;

    beforeEach(() => {
        saved = new Map();
        const storage = {
            save: async (campaign: CampaignSave['campaign'], pub: CampaignSave['pub']) => {
                const rec: CampaignSave = { kind: 'mekbay-campaign', campaign: structuredClone(campaign), pub, savedAt: '' };
                saved.set(campaign.id, rec);
                return rec;
            },
            load: async (id: string) => saved.get(id) ?? null,
            list: async () => [...saved.values()].map(r => ({ id: r.campaign.id, name: r.campaign.name, pubTitle: r.pub.title, date: r.campaign.date, savedAt: '' })),
            remove: async (id: string) => void saved.delete(id),
            all: async () => [...saved.values()],
            put: async (rec: CampaignSave) => void saved.set(rec.campaign.id, rec),
            saveDraft: async () => {},
            loadDraft: async () => null,
        };
        createGeneratedForce = jasmine.createSpy('createGeneratedForce').and.resolveTo({});
        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                { provide: DataService, useValue: { getUnitByName: lookup, getUnits: () => UNITS } },
                { provide: CampaignStorageService, useValue: storage },
                { provide: ForceBuilderService, useValue: { createGeneratedForce } },
            ],
        });
        svc = TestBed.inject(CampaignService);
    });

    /** Imported publication, started Classic campaign with a Wolverine and a Locust, both piloted. */
    async function started() {
        expect(svc.importPublication(JSON.stringify(makePublication()))).toBeTrue();
        expect(await svc.startCampaign('Test Company', GameSystem.CLASSIC)).toBeTrue();
        await svc.addUnit('Wolverine WVR-6R');
        await svc.addUnit('Locust LCT-1V');
        const c = svc.campaign()!;
        await svc.assignPilot(c.units[0].id, c.pilots[0].id);
        await svc.assignPilot(c.units[1].id, c.pilots[1].id);
        return svc.campaign()!;
    }

    it('saves an edited map into the publication and saved campaigns not playing it, refusing map errors', async () => {
        expect(await svc.saveMap({ ...starterMap(), hexes: { '0101': { t: 'hx_gone' } } })).toBeNull();
        expect(svc.pub()).toBeNull();
        const fresh = paintHex(starterMap(), '0202', 'hx_water');
        expect(await svc.saveMap(fresh, true)).toEqual({ updated: 0, kept: 0 });
        expect(svc.pub()!.maps[0].hexes['0202'].t).toBe('hx_water');
        expect(svc.pub()!.contracts[0].mapId).toBe(fresh.id);

        expect(svc.importPublication(JSON.stringify(makeMapPublication()))).toBeTrue();
        expect(await svc.startCampaign('Waiting', GameSystem.CLASSIC)).toBeTrue();
        const waiting = svc.campaign()!.id;
        expect(await svc.startCampaign('On the map', GameSystem.CLASSIC)).toBeTrue();
        const playing = saved.get(svc.campaign()!.id)!;
        playing.campaign.contract = { map: { mapId: 'mp_atoll' } } as never;
        svc.close();
        const edited = { ...makeMap(), name: 'Edited Atoll' };
        expect(await svc.saveMap(edited)).toEqual({ updated: 1, kept: 1 });
        expect(svc.pub()!.maps[0].name).toBe('Edited Atoll');
        expect(saved.get(waiting)!.pub.maps[0].name).toBe('Edited Atoll');
        expect(playing.pub.maps[0].name).toBe('Test Atoll');
    });

    it('validates an imported publication and rejects junk', () => {
        expect(svc.importPublication('{nope')).toBeFalse();
        expect(svc.error()).toContain('Not a publication file');
        expect(svc.importPublication(JSON.stringify(makePublication()))).toBeTrue();
        expect(svc.pubErrors()).toEqual([]);
        expect(svc.pub()!.title).toBe('Test publication');
    });

    it('starts a campaign in a system the publication allows and saves it', async () => {
        svc.importPublication(JSON.stringify({ ...makePublication(), systems: [GameSystem.CLASSIC] }));
        expect(await svc.startCampaign('X', GameSystem.ALPHA_STRIKE)).toBeFalse();
        expect(await svc.startCampaign('X', GameSystem.CLASSIC)).toBeTrue();
        expect(svc.campaign()!.system).toBe(GameSystem.CLASSIC);
        expect(saved.has(svc.campaign()!.id)).toBeTrue();
        expect(svc.saves().length).toBe(1);
    });

    it('keeps the state untouched when a rule is broken', async () => {
        const before = await started();
        expect(await svc.signContract('ct_glass', { ...RAISED, basePay: 9 })).toBeFalse();
        expect(svc.error()).not.toBe('');
        expect(svc.campaign()).toBe(before);
    });

    it('signs a contract, plays a track and applies its result', async () => {
        await started();
        expect(await svc.signContract('ct_glass', RAISED)).toBeTrue();
        expect(svc.campaign()!.warchest).toBe(2900);
        const item = svc.nextTrack()!;
        expect(item.key).toBe('n1');
        const c = svc.campaign()!;
        await svc.startTrack(item, c.units.map(u => u.id));
        const f = svc.force()!;
        expect(f.ok).toBeTrue();
        expect(f.groups[0].units.map(u => u.unit)).toEqual(['Wolverine WVR-6R', 'Locust LCT-1V']);

        expect(await svc.applyTrack({ winner: 'A', tier: 'success', salvage: [{ unit: 'No Such Unit' }] })).toBeFalse();
        expect(svc.error()).toContain('Unknown salvage unit');
        const [p1] = svc.campaign()!.pilots;
        expect(await svc.applyTrack({ winner: 'A', tier: 'success', designated: 100, mvp: p1.id, salvage: [{ unit: 'Atlas AS7-D' }] })).toBeTrue();
        expect(svc.campaign()!.warchest).toBe(2900 + 400 + 380);
        expect(svc.campaign()!.draft).toBeNull();
        expect(svc.nextTrack()!.key).toBe('n2');
        expect(saved.get(c.id)!.campaign.warchest).toBe(3680);
    });

    it('loads the track force into MekBay with pilot skills', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        await svc.startTrack(svc.nextTrack()!, svc.campaign()!.units.map(u => u.id));
        expect(await svc.loadForceInMekBay()).toBeTrue();
        const entry = createGeneratedForce.calls.mostRecent().args[0] as LoadForceEntry;
        expect(entry.type).toBe(GameSystem.CLASSIC);
        const units = entry.groups[0].units;
        expect(units.map(u => u.unit?.name)).toEqual(['Wolverine WVR-6R', 'Locust LCT-1V']);
        expect(units[0].gunnery).toEqual(jasmine.any(Number));
        expect(units[0].piloting).toEqual(jasmine.any(Number));
        expect(units.map(u => u.alias)).toEqual(svc.campaign()!.pilots.map(p => p.name));
    });

    it('runs months and closes the contract', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        await svc.endMonth();
        await svc.endMonth();
        expect(svc.campaign()!.contract!.status).toBe('ended');
        expect(await svc.closeContract(true)).toBeTrue();
        expect(svc.campaign()!.contract).toBeNull();
        expect(svc.campaign()!.history.length).toBe(1);
    });

    it('round-trips a save through export and import', async () => {
        const c = await started();
        const json = svc.exportSave();
        svc.close();
        saved.clear();
        expect(await svc.importSave('{"kind":"other"}')).toBeFalse();
        expect(await svc.importSave(json)).toBeTrue();
        expect(svc.campaign()!.id).toBe(c.id);
        expect(svc.campaign()!.units.length).toBe(2);
        expect(svc.pub()!.title).toBe('Test publication');
        expect(saved.has(c.id)).toBeTrue();
    });

    // ---------- between tracks ----------

    /** Signed contract and track n1 won: Locust armor damage, first pilot wounded twice, Atlas and Locust salvage. */
    async function afterTrack() {
        await started();
        await svc.signContract('ct_glass', RAISED);
        await svc.startTrack(svc.nextTrack()!, svc.campaign()!.units.map(u => u.id));
        const c = svc.campaign()!;
        const [p1] = c.pilots;
        expect(await svc.applyTrack({
            winner: 'A', tier: 'success', units: { [c.units[1].id]: { state: 'armor' } }, pilots: { [p1.id]: { wounds: 2 } },
            salvage: [{ unit: 'Atlas AS7-D' }, { unit: 'Locust LCT-1V' }],
        })).toBeTrue();
        return svc.campaign()!;
    }
    const last = () => svc.campaign()!.ledger.at(-1)!;

    it('repairs a damaged unit and refuses an operational one', async () => {
        const c = await afterTrack();
        const locust = c.units[1];
        expect(await svc.repair(c.units[0].id)).toBeFalse();
        expect(svc.campaign()).toBe(c);
        expect(await svc.repair(locust.id)).toBeTrue();
        const after = svc.campaign()!;
        expect(after.units[1].state).toBe('ok');
        expect(last().kind).toBe('repair');
        // 20 t × 0.5 = 10 SP, Battle support covers none of a straight repair bill here.
        expect(after.warchest).toBe(c.warchest + last().net);
    });

    it('reconfigures an Omni within its chassis', async () => {
        await started();
        await svc.addUnit('Timber Wolf Prime');
        const tw = svc.campaign()!.units[2];
        expect(svc.configsOf('Timber Wolf Prime').map(u => u.name)).toEqual(['Timber Wolf A']);
        expect(await svc.reconfigure(tw.id, 'Atlas AS7-D')).toBeFalse();
        expect(await svc.reconfigure(tw.id, 'Timber Wolf A')).toBeTrue();
        expect(svc.campaign()!.units[2].unit).toBe('Timber Wolf A');
    });

    it('heals within the between-track limit and invests SP', async () => {
        const c = await afterTrack();
        const p1 = c.pilots[0];
        expect(p1.wounds).toBe(2);
        expect(await svc.heal(p1.id)).toBeTrue();
        expect(svc.campaign()!.pilots[0].wounds).toBe(1);
        expect(last().kind).toBe('heal');
        expect(await svc.heal(p1.id)).toBeFalse();
        expect(svc.campaign()!.pilots[0].wounds).toBe(1);

        const unspent = svc.campaign()!.pilots[0].unspent;
        expect(await svc.investSp(p1.id, 'piloting', unspent + 1)).toBeFalse();
        expect(await svc.investSp(p1.id, 'piloting', 100)).toBeTrue();
        expect(svc.campaign()!.pilots[0].cols.piloting).toBe(100);
        expect(svc.campaign()!.pilots[0].unspent).toBe(unspent - 100);
    });

    it('hires pilots and crews and trains a command ability in a track-less month', async () => {
        const c = await started();
        expect(await svc.hire({ kind: 'named', name: 'New Hire' })).toBeTrue();
        expect(svc.campaign()!.pilots.at(-1)!.name).toBe('New Hire');
        expect(svc.campaign()!.warchest).toBe(c.warchest - 150);
        await svc.addUnit('Atlas AS7-D');
        const atlas = svc.campaign()!.units[2];
        expect(await svc.hire({ kind: 'green', cuId: atlas.id })).toBeTrue();
        expect(svc.campaign()!.units[2].crew.kind).toBe('green');
        expect(await svc.trainSca(c.pilots[0].id, 'Test Ability')).toBeTrue();
        expect(svc.campaign()!.pilots[0].scas).toEqual(['Test Ability']);
        expect(last().kind).toBe('training');
    });

    it('buys and sells units at MekBay values', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        const w0 = svc.campaign()!.warchest;
        expect(await svc.addUnit('Atlas AS7-D')).toBeTrue();
        expect(svc.campaign()!.warchest).toBe(w0 - 1900);
        const atlas = svc.campaign()!.units.at(-1)!;
        expect(await svc.removeUnit(atlas.id)).toBeTrue();
        expect(svc.campaign()!.warchest).toBe(w0 - 1900 + 950);
        expect(svc.campaign()!.ledger.slice(-2).map(e => e.kind)).toEqual(['purchase', 'sale']);
    });

    it('orders through a sponsor and blocks in-scope purchases elsewhere', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        expect(await svc.setSponsor('sp_works')).toBeTrue();
        expect(await svc.addUnit('Manticore Heavy Tank')).toBeFalse();
        expect(svc.error()).toContain('Test Works');
        expect(await svc.orderFromSponsor('Manticore Heavy Tank', 'territory')).toBeTrue();
        const tank = svc.campaign()!.units.at(-1)!;
        expect(tank.delivery?.due).toBeTruthy();
        expect(last().cost).toBe(900);
        expect(await svc.setSponsor('')).toBeTrue();
        expect(svc.campaign()!.sponsorBanned).toEqual(['sp_works']);
        expect(svc.campaign()!.units.some(u => u.id === tank.id)).toBeFalse();
    });

    it('rolls contract purchase availability and the purchase table', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        expect(await svc.rollPurchaseTable()).toBeFalse();
        expect(await svc.rollPurchaseGate()).toBeTrue();
        expect(await svc.rollPurchaseGate()).toBeFalse();
        expect(await svc.rollPurchaseTable()).toBeTrue();
        const st = Object.values(svc.campaign()!.contract!.purchase!)[0];
        expect(st.count).toBe(1);
        expect(st.logs[0].flatMap(l => l.units ?? []).map(u => u.unit)).toEqual(['Phoenix Hawk PXH-1']);
        expect(await svc.rollPurchaseTable()).toBeFalse();
        expect(await svc.addUnit('Phoenix Hawk PXH-1', { source: 'contract' })).toBeTrue();
        expect(svc.campaign()!.units.at(-1)!.source).toBe('contract');
    });

    it('searches the scrapyard once a month and buys the find', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        expect(await svc.searchScrapyard('tb_scrap')).toBeTrue();
        expect(svc.campaign()!.scrapyard!.unit).toBe('Locust LCT-1V');
        expect(await svc.searchScrapyard('tb_scrap')).toBeFalse();
        expect(await svc.buyScrapyard()).toBeTrue();
        const cu = svc.campaign()!.units.at(-1)!;
        expect(cu.source).toBe('scrapyard');
        expect(last().cost).toBe(215);
        expect(await svc.buyScrapyard()).toBeFalse();
    });

    it('keeps or declines salvage from the pool', async () => {
        const c = await afterTrack();
        const [atlas, locust] = c.contract!.salvagePool;
        expect(await svc.buySalvage(atlas.id)).toBeTrue();
        const after = svc.campaign()!;
        expect(after.units.at(-1)!.unit).toBe('Atlas AS7-D');
        expect(after.units.at(-1)!.state).toBe('destroyed');
        expect(after.warchest).toBe(c.warchest - 950);
        expect(await svc.declineSalvage(locust.id)).toBeTrue();
        expect(svc.campaign()!.contract!.salvagePool).toEqual([]);
    });

    it('rolls track events once and applies their effects with the result', async () => {
        await started();
        await svc.signContract('ct_glass', RAISED);
        expect(await svc.rollEvents()).toBeFalse(); // no track set up yet
        const c = svc.campaign()!;
        await svc.startTrack(svc.nextTrack()!, c.units.map(u => u.id));
        expect(await svc.rollEvents()).toBeTrue();
        expect(svc.campaign()!.draft!.complications.length).toBeGreaterThan(0);
        expect(await svc.rollEvents()).toBeFalse();
        expect(svc.error()).toContain('already rolled');
        expect(await svc.applyTrack({ winner: 'A', tier: 'success', ammoTons: 1 })).toBeTrue();
        expect(svc.campaign()!.contract!.between!.block).toEqual(['rearm']);
    });

    it('moves to a hiring hall only between contracts', async () => {
        await started();
        expect(await svc.goToHall('hh_test')).toBeTrue();
        expect(svc.campaign()!.hallId).toBe('hh_test');
        await svc.signContract('ct_glass', RAISED);
        expect(await svc.goToHall('')).toBeFalse();
    });
});
