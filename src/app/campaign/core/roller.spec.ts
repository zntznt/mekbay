// SPDX-License-Identifier: GPL-3.0-or-later

import { GameSystem } from '../../models/common.model';
import { seededRng } from './dice';
import { newTable } from './publication.model';
import { tableRoller } from './roller';
import { makePublication } from './testing/fixtures';

describe('tableRoller', () => {
    it('stops a self-pointing fan-out instead of hanging', () => {
        const pub = makePublication();
        const t = newTable();
        t.rows = [{ min: 1, max: 6, cells: { r: { kind: 'pointer', tableId: t.id, count: 1_000_000, column: '' } } }];
        pub.tables.push(t);
        const log = tableRoller(seededRng(1))(t, { pub, system: GameSystem.CLASSIC, modifier: 0 });
        expect(log.length).toBeLessThan(600);
        expect(log.some(l => l.text === 'Stopped: too many rolls')).toBeTrue();
    });
});
