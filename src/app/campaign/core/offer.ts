// SPDX-License-Identifier: GPL-3.0-or-later

import { RuleError, type ActiveContract, type Campaign, type ContractOffer, type RunnerEnv } from './campaign.model';
import type { Terms } from './engine';
import { draftContract, runGenerator } from './generator';
import { byId, type GeneratorChain, type Hall, type Publication } from './publication.model';
import { acceptContract, note, type AcceptInput } from './runner';

/*
 * Random contract offers: between contracts, the hiring hall's generator rolls
 * a contract. The command negotiates and signs it like any other contract, or
 * declines it; a hall makes a set number of offers per month.
 */

/** Hall and generator that would make the next offer, or why none can be made now. */
export function offerSource(c: Campaign, pub: Publication): { hall?: Hall; gen?: GeneratorChain; why: string } {
    if (c.contract) return { why: 'Finish the current contract first.' };
    const hall = byId(pub, 'halls', c.hallId);
    if (!hall) return { why: 'Base the command at a hiring hall to get random contract offers.' };
    const gen = byId(pub, 'generators', hall.generatorId);
    if (!gen) return { hall, why: `${hall.name} has no contract generator.` };
    if (c.offer) return { hall, gen, why: 'Answer the current offer first.' };
    const used = c.offers.date === c.date ? c.offers.n : 0;
    if (used >= Math.max(1, hall.offersPerMonth || 1)) return { hall, gen, why: `${hall.name} has no more offers this month; wait a month.` };
    return { hall, gen, why: '' };
}

/** Longest generator input value kept (inputs only steer tag rules). */
export const MAX_INPUT_LENGTH = 80;
/** Generator inputs the player fills in; `hall` is always the hiring hall's name. */
export const playerInputs = (gen: GeneratorChain | undefined): GeneratorChain['inputs'] => (gen?.inputs || []).filter(i => i.key && i.key !== 'hall');

/** Roll a random contract offer on the hall's generator (the `hall` input gets the hall's name, the rest come from the player). */
export function generateOffer(c: Campaign, env: RunnerEnv, inputs: Record<string, string> = {}): ContractOffer {
    const { hall, gen, why } = offerSource(c, env.pub);
    if (why || !hall || !gen) throw new RuleError(why);
    const given: Record<string, string> = { hall: hall.name };
    for (const i of playerInputs(gen)) given[i.key] = String(inputs[i.key] ?? '').trim().slice(0, MAX_INPUT_LENGTH);
    const { log, draft } = runGenerator(gen, { pub: env.pub, system: c.system, inputs: given, rng: env.rng });
    const { contract, brief } = draftContract(draft, `${hall.name}: ${draft.type || 'random'} contract (${c.date})`);
    const rule = (gen.attackerRolls || []).find(a => a.type.trim().toLowerCase() === contract.type.trim().toLowerCase());
    contract.attackerRoll = rule ? structuredClone(rule) : null;
    const offer: ContractOffer = { hallId: hall.id, generatorId: gen.id, date: c.date, log, contract, brief, jumps: draft.jumps ?? null };
    c.offers = { date: c.date, n: (c.offers.date === c.date ? c.offers.n : 0) + 1 };
    c.offer = offer;
    return offer;
}

export function declineOffer(c: Campaign): void {
    if (!c.offer) throw new RuleError('No contract offer to decline.');
    note(c, `Declined offer: ${c.offer.contract.name}`);
    c.offer = null;
}

/**
 * Sign the offer on negotiated terms. The contract and its brief join the
 * publication (`env.pub` is mutated: callers pass a copy and keep it on success).
 */
export function signOffer(c: Campaign, env: RunnerEnv, terms: Terms, opts: Pick<AcceptInput, 'bring' | 'toftt'> = {}): ActiveContract {
    const o = c.offer;
    if (!o) throw new RuleError('No contract offer to sign.');
    env.pub.contracts.push(o.contract);
    env.pub.briefs.push(o.brief);
    const ac = acceptContract(c, env, { ...opts, contractId: o.contract.id, terms, jumps: o.jumps });
    c.offer = null;
    return ac;
}
