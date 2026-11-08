// SPDX-License-Identifier: GPL-3.0-or-later

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CampaignStorageService, parseCampaignSave } from './campaign-storage.service';
import { newCampaign } from './core/runner';
import { makePublication } from './core/testing/fixtures';

describe('CampaignStorageService', () => {
    let storage: CampaignStorageService;
    const ids: string[] = [];

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
        storage = TestBed.inject(CampaignStorageService);
    });
    afterEach(async () => {
        for (const id of ids.splice(0)) await storage.remove(id);
    });

    it('saves, lists, loads and removes campaigns in its own database', async () => {
        const pub = makePublication();
        const c = newCampaign({ pub, name: 'Stored Company' });
        ids.push(c.id);
        await storage.save(c, pub);

        const listed = (await storage.list()).find(s => s.id === c.id);
        expect(listed).toEqual(jasmine.objectContaining({ name: 'Stored Company', pubTitle: 'Test publication', date: c.date }));
        const rec = await storage.load(c.id);
        expect(rec!.campaign).toEqual(c);
        expect(rec!.pub.contracts[0].id).toBe('ct_glass');

        await storage.remove(c.id);
        expect(await storage.load(c.id)).toBeNull();

        const dbs = await indexedDB.databases();
        expect(dbs.some(d => d.name === 'mekbay-campaign')).toBeTrue();
    });

    it('keeps the working publication as a draft across reloads', async () => {
        const pub = makePublication();
        await storage.saveDraft(pub);
        expect((await storage.loadDraft())!.title).toBe('Test publication');
    });

    it('parses only campaign save files', () => {
        const pub = makePublication();
        const c = newCampaign({ pub });
        expect(parseCampaignSave(JSON.stringify({ kind: 'mekbay-campaign', campaign: c, pub })).campaign.id).toBe(c.id);
        expect(() => parseCampaignSave(JSON.stringify(pub))).toThrowError(/Not a campaign save/);
        expect(() => parseCampaignSave('nope')).toThrow();
    });
});
