// SPDX-License-Identifier: GPL-3.0-or-later

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { GameSystem } from '../models/common.model';
import type { LoadForceEntry } from '../models/load-force-entry.model';
import { DataService } from '../services/data.service';
import { ForceBuilderService } from '../services/force-builder.service';
import { CampaignService } from './campaign.service';
import { CampaignStorageService, type CampaignSave } from './campaign-storage.service';
import { lookup, makePublication, UNITS } from './core/testing/fixtures';

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
});
