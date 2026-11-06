// SPDX-License-Identifier: GPL-3.0-or-later

import { Injectable } from '@angular/core';
import type { Campaign } from './core/campaign.model';
import type { Publication } from './core/publication.model';

/*
 * Campaign saves live in their own IndexedDB database so MekBay's main
 * database (db.service.ts) and its version are never touched.
 */

const DB_NAME = 'mekbay-campaign';
const DB_VERSION = 1;
const STORE = 'campaigns';

/** A campaign with the publication it runs on: everything needed to resume it. */
export interface CampaignSave {
    kind: 'mekbay-campaign';
    campaign: Campaign;
    pub: Publication;
    savedAt: string;
}

export interface CampaignSummary {
    id: string;
    name: string;
    pubTitle: string;
    date: string;
    savedAt: string;
}

/** Parse an exported save; throws on anything that is not one. */
export function parseCampaignSave(text: string): CampaignSave {
    const x = JSON.parse(text) as Partial<CampaignSave>;
    if (x?.kind !== 'mekbay-campaign' || !x.campaign?.id || !x.pub) throw new Error('Not a campaign save file.');
    return { kind: 'mekbay-campaign', campaign: x.campaign, pub: x.pub, savedAt: x.savedAt || new Date().toISOString() };
}

@Injectable({ providedIn: 'root' })
export class CampaignStorageService {
    private dbPromise: Promise<IDBDatabase | null> | null = null;

    private db(): Promise<IDBDatabase | null> {
        // ponytail: no in-memory fallback; without IndexedDB saves only survive via export
        this.dbPromise ??= new Promise(resolve => {
            if (typeof indexedDB === 'undefined') return resolve(null);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        return this.dbPromise;
    }

    private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
        const db = await this.db();
        if (!db) return null;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = op(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req.result ?? null);
            tx.onerror = () => reject(tx.error);
        });
    }

    async save(campaign: Campaign, pub: Publication): Promise<CampaignSave> {
        const rec: CampaignSave = { kind: 'mekbay-campaign', campaign, pub, savedAt: new Date().toISOString() };
        await this.run('readwrite', s => s.put(rec, campaign.id));
        return rec;
    }

    load(id: string): Promise<CampaignSave | null> {
        return this.run<CampaignSave | undefined>('readonly', s => s.get(id)).then(x => x ?? null);
    }

    async list(): Promise<CampaignSummary[]> {
        const all = (await this.run<CampaignSave[]>('readonly', s => s.getAll())) ?? [];
        return all
            .map(r => ({ id: r.campaign.id, name: r.campaign.name, pubTitle: r.pub.title, date: r.campaign.date, savedAt: r.savedAt }))
            .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    }

    async remove(id: string): Promise<void> {
        await this.run('readwrite', s => s.delete(id));
    }
}
