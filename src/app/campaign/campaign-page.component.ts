// SPDX-License-Identifier: GPL-3.0-or-later

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RoutedDialogPage } from '../pages/routed-dialog-page';
import { DialogsService } from '../services/dialogs.service';

/** Routed page for the campaign dialog (/campaign). */
@Component({
    selector: 'campaign-page',
    template: '',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignPageComponent extends RoutedDialogPage {
    private readonly dialogsService = inject(DialogsService);

    protected override async openDialog() {
        const { CampaignDialogComponent } = await import('./components/campaign-dialog.component');
        return this.dialogsService.createDialog(CampaignDialogComponent);
    }
}
