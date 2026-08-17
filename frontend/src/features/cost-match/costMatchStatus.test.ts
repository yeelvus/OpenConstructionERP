// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The decisions the cost-match screen makes for itself, and the wrong version
 * of each.
 *
 * Every case below has a plausible implementation that gets it backwards: an
 * `adoptedItem` that reads the row rather than the ruling shows a cost item the
 * reviewer explicitly refused; a tier mapper that re-derives what the run
 * already recorded lets the badge disagree with the record, and one that
 * renders an unknown value raw puts an untranslated word on a translated
 * screen; a tally that leaves its zeros out cannot tell "no rejections" from
 * "we did not look"; and a quantity reader that trusts `Number()` turns "1,5"
 * into NaN and one credit line into a 422 on five hundred.
 */

import { describe, it, expect } from 'vitest';

import {
  DECISION_STATE_ORDER,
  HIGH_CONFIDENCE,
  REVIEW_CONFIDENCE,
  TIER_ORDER,
  adoptedItem,
  canConfirm,
  confidenceBand,
  confidencePercent,
  confidenceValue,
  currentDecision,
  decisionStateOf,
  decisionTone,
  groupByTier,
  needsPerson,
  overrideOptions,
  parseBillLines,
  resultTier,
  tallyResults,
  tierForConfidence,
  tierTone,
} from './costMatchStatus';
import type { MatchCandidate, MatchDecision, MatchResult } from './api';

/** One ruling out of a result's append-only history. */
function decision(over: Partial<MatchDecision> = {}): MatchDecision {
  return {
    id: 'decision-1',
    result_id: 'result-1',
    run_id: 'run-1',
    seq: 1,
    decision: 'confirmed',
    tier_at_decision: 'high_confidence',
    confidence_at_decision: '0.81',
    decided_cost_item_id: 'item-1',
    decided_code: 'C-100',
    decided_description: 'Concrete C25/30, foundations',
    decided_unit: 'm3',
    decided_rate: '142.50',
    decided_currency: 'EUR',
    decided_by: 'user-1',
    note: null,
    created_at: '2026-05-04T09:00:00Z',
    ...over,
  };
}

/** A runner-up the matcher kept on the result. */
function candidate(over: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    cost_item_id: 'item-2',
    code: 'C-200',
    description: 'Concrete C25/30, slabs',
    unit: 'm3',
    rate: '138.00',
    currency: 'EUR',
    confidence: '0.62',
    band: 'medium',
    reason_codes: ['description_similarity'],
    ...over,
  };
}

/** One scored line. Full, so it satisfies every `Pick` in the module. */
function result(over: Partial<MatchResult> = {}): MatchResult {
  return {
    id: 'result-1',
    run_id: 'run-1',
    project_id: 'project-1',
    line_no: 1,
    source_ref: 'A.1.10',
    source_description: 'Concrete C25/30 to foundations',
    source_unit: 'm3',
    source_quantity: '120.000',
    tier: 'high_confidence',
    confidence: '0.81',
    tie: false,
    hint_code: '',
    reason_codes: ['description_similarity'],
    factors: { exact: 0, unit: 1 },
    alternatives: [],
    suggested_cost_item_id: 'item-1',
    suggested_code: 'C-100',
    suggested_description: 'Concrete C25/30, foundations',
    suggested_unit: 'm3',
    suggested_rate: '142.50',
    suggested_currency: 'EUR',
    decision_state: 'pending',
    decisions: [],
    explanation: 'The description matched closely.',
    hint: null,
    created_at: '2026-05-04T08:00:00Z',
    updated_at: '2026-05-04T08:00:00Z',
    ...over,
  };
}

describe('confidenceValue', () => {
  it('reads a plain-decimal string', () => {
    expect(confidenceValue('0.8125')).toBe(0.8125);
    expect(confidenceValue('1')).toBe(1);
  });

  it('collapses a zero, an absent and an unreadable score onto the same 0', () => {
    // The honest collapse: all of them mean "this row claims nothing", and
    // there is no third rendering for them to disagree about.
    expect(confidenceValue('0')).toBe(0);
    expect(confidenceValue('0.0000')).toBe(0);
    expect(confidenceValue(null)).toBe(0);
    expect(confidenceValue(undefined)).toBe(0);
    expect(confidenceValue('')).toBe(0);
    expect(confidenceValue('banana')).toBe(0);
  });

  it('refuses an unbounded value instead of letting it band as certainty', () => {
    expect(confidenceValue('Infinity')).toBe(0);
    expect(confidenceValue('-Infinity')).toBe(0);
    expect(confidenceValue('NaN')).toBe(0);
  });
});

describe('confidencePercent', () => {
  it('renders a stored score as whole percent', () => {
    expect(confidencePercent('0.75')).toBe(75);
    expect(confidencePercent('0.4567')).toBe(46);
    expect(confidencePercent('1')).toBe(100);
  });

  it('renders a score of nothing and a missing score alike, at 0', () => {
    expect(confidencePercent('0')).toBe(0);
    expect(confidencePercent(null)).toBe(0);
  });
});

describe('confidenceBand', () => {
  it('bands inclusively at the cutoffs the score was written against', () => {
    // The reason confidence crosses the wire as a string. Through a JSON
    // number this boundary arrives as 0.7499999999999999 and the row is
    // repainted a colour the scorer never meant.
    expect(confidenceBand('0.75')).toBe('high');
    expect(confidenceBand(String(HIGH_CONFIDENCE))).toBe('high');
    expect(confidenceBand('0.45')).toBe('medium');
    expect(confidenceBand(String(REVIEW_CONFIDENCE))).toBe('medium');
  });

  it('holds the band one ulp under each cutoff', () => {
    expect(confidenceBand('0.7499999999999999')).toBe('medium');
    expect(confidenceBand('0.4499999999999999')).toBe('low');
  });

  it('reads a score of nothing and a missing score as the same low band', () => {
    expect(confidenceBand('0')).toBe('low');
    expect(confidenceBand(null)).toBe('low');
  });
});

describe('tierForConfidence', () => {
  it('is unmatched with no candidate, whatever the number says', () => {
    // The case a naive reading gets wrong: a high score with nothing to
    // attach it to is not a match at all.
    expect(tierForConfidence('0.99', { hasSuggestion: false })).toBe('unmatched');
    expect(tierForConfidence('0.99', { hasSuggestion: false, exact: 1 })).toBe('unmatched');
  });

  it('is unmatched below the review cutoff even with a candidate on the row', () => {
    // The matcher keeps its best candidate for context; keeping it is not the
    // same as claiming it.
    expect(tierForConfidence('0.44', { hasSuggestion: true })).toBe('unmatched');
    expect(tierForConfidence('0.4499999999999999', { hasSuggestion: true })).toBe('unmatched');
  });

  it('puts the cutoff itself, and everything under high, into review', () => {
    expect(tierForConfidence('0.45', { hasSuggestion: true })).toBe('needs_review');
    expect(tierForConfidence(String(REVIEW_CONFIDENCE), { hasSuggestion: true })).toBe('needs_review');
    expect(tierForConfidence('0.7499999999999999', { hasSuggestion: true })).toBe('needs_review');
  });

  it('needs both word-for-word equality and a score that survived the unit check', () => {
    // An exact text match priced per cubic metre against a line measured in
    // square metres is not exact: the unit penalty pushes it into review, and
    // the equality factor alone must not pull it back out.
    expect(tierForConfidence('0.75', { hasSuggestion: true, exact: 1 })).toBe('exact');
    expect(tierForConfidence('0.62', { hasSuggestion: true, exact: 1 })).toBe('needs_review');
  });

  it('is confident rather than exact without the equality factor', () => {
    expect(tierForConfidence('0.9', { hasSuggestion: true })).toBe('high_confidence');
    expect(tierForConfidence('0.9', { hasSuggestion: true, exact: 0 })).toBe('high_confidence');
    expect(tierForConfidence('0.9', { hasSuggestion: true, exact: 0.999 })).toBe('high_confidence');
  });
});

describe('resultTier', () => {
  it('keeps the tier the run recorded rather than deriving its own', () => {
    // The record of what the matcher decided. Re-deriving it here would let
    // the badge and the row disagree the day a cutoff moves.
    expect(resultTier(result({ tier: 'exact', confidence: '0.10' }))).toBe('exact');
    expect(resultTier(result({ tier: 'unmatched', confidence: '0.99' }))).toBe('unmatched');
  });

  it('re-derives a tier this screen has no rendering for', () => {
    // The field is a bare `str` on purpose, so a later version can write a
    // word this build has never seen. Rendering it raw would put an
    // untranslated string in the middle of a translated screen.
    expect(resultTier(result({ tier: 'partial_match', confidence: '0.81' }))).toBe('high_confidence');
    expect(resultTier(result({ tier: 'partial_match', confidence: '0.50' }))).toBe('needs_review');
    expect(resultTier(result({ tier: '', confidence: '0.50' }))).toBe('needs_review');
  });

  it('re-derives from the same three inputs the matcher used', () => {
    expect(
      resultTier(result({ tier: 'partial_match', confidence: '0.92', factors: { exact: 1 } })),
    ).toBe('exact');
    expect(
      resultTier(result({ tier: 'partial_match', confidence: '0.92', suggested_cost_item_id: null })),
    ).toBe('unmatched');
    expect(resultTier(result({ tier: 'partial_match', confidence: '0.10' }))).toBe('unmatched');
  });
});

describe('tierTone', () => {
  it('paints only an exact match as a settled answer', () => {
    // A confident match is still a proposal nobody has accepted. Green there
    // would have the screen vouching for something the record does not.
    expect(tierTone('exact')).toBe('success');
    expect(tierTone('high_confidence')).toBe('blue');
    expect(tierTone('needs_review')).toBe('warning');
    expect(tierTone('unmatched')).toBe('neutral');
  });

  it('has a colour for every tier a row can narrow to', () => {
    for (const tier of TIER_ORDER) {
      expect(tierTone(tier)).toBeTruthy();
    }
    // Including a row carrying a word from a later version, which narrows
    // before it is painted.
    expect(tierTone(resultTier(result({ tier: 'partial_match' })))).toBeTruthy();
  });
});

describe('decisionStateOf', () => {
  it('reads the four states a review moves between', () => {
    for (const state of DECISION_STATE_ORDER) {
      expect(decisionStateOf(result({ decision_state: state }))).toBe(state);
    }
  });

  it('reads a state it has never seen as still awaiting a person', () => {
    // The safe direction. Anything else would clear a line out of the queue
    // on the strength of a word this build cannot read.
    expect(decisionStateOf(result({ decision_state: 'escalated' }))).toBe('pending');
    expect(decisionStateOf(result({ decision_state: '' }))).toBe('pending');
  });
});

describe('decisionTone', () => {
  it('paints a rejection neutrally rather than as a failure', () => {
    // Ruling that nothing in this base fits is a real and useful answer, and
    // it takes the line out of the queue. `pending` is the state with work
    // outstanding, so that is the one that warns.
    expect(decisionTone('rejected')).toBe('neutral');
    expect(decisionTone('pending')).toBe('warning');
    expect(decisionTone('confirmed')).toBe('success');
    expect(decisionTone('overridden')).toBe('blue');
  });

  it('has a colour for every state a row can narrow to', () => {
    for (const state of DECISION_STATE_ORDER) {
      expect(decisionTone(state)).toBeTruthy();
    }
    expect(decisionTone(decisionStateOf(result({ decision_state: 'escalated' })))).toBeTruthy();
  });
});

describe('currentDecision', () => {
  it('is null while nobody has ruled', () => {
    expect(currentDecision(result())).toBeNull();
  });

  it('reads the last ruling by seq, not by position in the array', () => {
    const first = decision({ id: 'd1', seq: 1, decision: 'overridden' });
    const second = decision({ id: 'd2', seq: 2, decision: 'rejected' });
    expect(currentDecision(result({ decisions: [second, first] }))?.id).toBe('d2');
    expect(currentDecision(result({ decisions: [first, second] }))?.id).toBe('d2');
  });

  it('does not reorder the history it was handed', () => {
    // It is handed the array the query cache holds, and sorting that in place
    // would reorder the history panel rendering beside it.
    const history = [decision({ id: 'd2', seq: 2 }), decision({ id: 'd1', seq: 1 })];
    currentDecision(result({ decisions: history }));
    expect(history.map((entry) => entry.id)).toEqual(['d2', 'd1']);
  });
});

describe('adoptedItem', () => {
  it('is null on a line nobody has ruled on', () => {
    expect(adoptedItem(result())).toBeNull();
  });

  it('answers with the ruling after an override, not with the suggestion', () => {
    // The reading on this screen that must not be guessed from the row.
    // `suggested_code` still holds what the machine proposed, and a panel
    // that keeps rendering it shows the item the reviewer refused.
    const adopted = adoptedItem(
      result({
        suggested_cost_item_id: 'item-1',
        suggested_code: 'C-100',
        suggested_description: 'Concrete C25/30, foundations',
        decisions: [
          decision({
            seq: 1,
            decision: 'overridden',
            decided_cost_item_id: 'item-9',
            decided_code: 'C-999',
            decided_description: 'Concrete C30/37, foundations',
            decided_unit: 'm3',
            decided_rate: '167.40',
            decided_currency: 'CHF',
          }),
        ],
      }),
    );
    expect(adopted).toEqual({
      costItemId: 'item-9',
      code: 'C-999',
      description: 'Concrete C30/37, foundations',
      unit: 'm3',
      rate: '167.40',
      currency: 'CHF',
      decision: 'overridden',
      seq: 1,
    });
  });

  it('answers a confirmation the same way, with no branch on the ruling', () => {
    // A confirmation copies the suggestion into the same `decided_*` columns
    // an override writes, so one question answers both.
    const adopted = adoptedItem(
      result({ decision_state: 'confirmed', decisions: [decision({ decision: 'confirmed' })] }),
    );
    expect(adopted?.costItemId).toBe('item-1');
    expect(adopted?.code).toBe('C-100');
    expect(adopted?.decision).toBe('confirmed');
  });

  it('is null after a rejection, exactly like a line nobody ruled on', () => {
    // A rejection leaves the columns empty, which is the same question again
    // and not a fourth branch.
    expect(
      adoptedItem(
        result({
          decision_state: 'rejected',
          decisions: [
            decision({
              decision: 'rejected',
              decided_cost_item_id: null,
              decided_code: '',
              decided_description: '',
              decided_rate: null,
            }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it('follows a change of mind to the ruling with the highest seq', () => {
    // What makes the sort load-bearing: newest first is how a history panel
    // hands the same array over.
    const overridden = decision({ id: 'd1', seq: 1, decision: 'overridden', decided_cost_item_id: 'item-9' });
    const rejected = decision({ id: 'd2', seq: 2, decision: 'rejected', decided_cost_item_id: null });
    expect(adoptedItem(result({ decisions: [rejected, overridden] }))).toBeNull();
    expect(adoptedItem(result({ decisions: [overridden, rejected] }))).toBeNull();
    // And the other way round: the override is what stands if it came last.
    expect(
      adoptedItem(result({ decisions: [decision({ seq: 3, decided_cost_item_id: 'item-9' }), rejected] }))
        ?.costItemId,
    ).toBe('item-9');
  });

  it('carries the rate across as the string it arrived as', () => {
    // The figure the line ends up priced at. Through a JSON number this one
    // comes back short, which is why the wire carries a decimal string.
    const adopted = adoptedItem(result({ decisions: [decision({ decided_rate: '1234567.891234567890' })] }));
    expect(adopted?.rate).toBe('1234567.891234567890');
  });

  it('keeps an item priced at zero, and one the base carries no rate for', () => {
    // A zero rate is a real rate, a null rate is a base row nobody priced.
    // Neither un-adopts the item the reviewer chose, because the ruling is
    // what was adopted and the rate is only what it costs.
    expect(adoptedItem(result({ decisions: [decision({ decided_rate: '0.00' })] }))?.rate).toBe('0.00');
    const unpriced = adoptedItem(result({ decisions: [decision({ decided_rate: null })] }));
    expect(unpriced?.rate).toBeNull();
    expect(unpriced?.costItemId).toBe('item-1');
  });
});

describe('needsPerson', () => {
  it('queues the two tiers where the machine is not claiming an answer', () => {
    expect(needsPerson(result({ tier: 'needs_review' }))).toBe(true);
    expect(needsPerson(result({ tier: 'unmatched' }))).toBe(true);
  });

  it('leaves a scored line out of the queue though it is still pending', () => {
    // Nothing is auto-applied, so exact and confident lines do wait for a
    // confirmation. They are not what the queue is for, and this list has to
    // agree with the endpoint that pages it or the badge lies about the work.
    expect(needsPerson(result({ tier: 'exact' }))).toBe(false);
    expect(needsPerson(result({ tier: 'high_confidence' }))).toBe(false);
  });

  it('drops a line out of the queue once anyone has ruled on it', () => {
    for (const state of ['confirmed', 'overridden', 'rejected']) {
      expect(needsPerson(result({ tier: 'needs_review', decision_state: state }))).toBe(false);
      expect(needsPerson(result({ tier: 'unmatched', decision_state: state }))).toBe(false);
    }
  });

  it('keeps a line whose ruling this screen cannot read', () => {
    expect(needsPerson(result({ tier: 'unmatched', decision_state: 'escalated' }))).toBe(true);
  });

  it('reads the tier through the same narrowing as the badge does', () => {
    // A row carrying a tier from a later version must not slip out of the
    // queue on the strength of a word nobody here can read.
    expect(needsPerson(result({ tier: 'partial_match', confidence: '0.10' }))).toBe(true);
    expect(needsPerson(result({ tier: 'partial_match', confidence: '0.99' }))).toBe(false);
  });
});

describe('canConfirm', () => {
  it('is false when the base returned no candidate', () => {
    // There is nothing to confirm and the endpoint answers 422. The honest
    // rulings there are an override or a rejection.
    expect(canConfirm(result({ suggested_cost_item_id: null }))).toBe(false);
  });

  it('is true wherever there is something to confirm', () => {
    expect(canConfirm(result({ suggested_cost_item_id: 'item-1' }))).toBe(true);
  });
});

describe('overrideOptions', () => {
  it('offers the runners-up and not the winner', () => {
    // The winner stays in `alternatives` so the reviewer sees what it beat.
    // Offering it as an override target would file a confirmation under the
    // wrong word in the audit trail.
    const options = overrideOptions(
      result({
        suggested_cost_item_id: 'item-1',
        alternatives: [
          candidate({ cost_item_id: 'item-1', code: 'C-100' }),
          candidate({ cost_item_id: 'item-2', code: 'C-200', rate: '1234567.891234567890' }),
          candidate({ cost_item_id: 'item-3', code: 'C-300' }),
        ],
      }),
    );
    expect(options.map((option) => option.code)).toEqual(['C-200', 'C-300']);
    // The rate the reviewer picks by, handed over as the string it arrived as.
    expect(options[0]?.rate).toBe('1234567.891234567890');
  });

  it('drops a candidate no ruling could name', () => {
    // The ruling is made by id, so a candidate without one cannot be a
    // target however well it reads.
    const options = overrideOptions(
      result({
        suggested_cost_item_id: 'item-1',
        alternatives: [
          candidate({ cost_item_id: null, code: 'C-400' }),
          candidate({ cost_item_id: '', code: 'C-500' }),
          candidate({ cost_item_id: 'item-6', code: 'C-600' }),
        ],
      }),
    );
    expect(options.map((option) => option.code)).toEqual(['C-600']);
  });

  it('offers every named candidate on a line with no suggestion at all', () => {
    // The unmatched line, which is where the picker matters most.
    const options = overrideOptions(
      result({
        suggested_cost_item_id: null,
        alternatives: [candidate({ cost_item_id: 'item-2' }), candidate({ cost_item_id: 'item-3' })],
      }),
    );
    expect(options).toHaveLength(2);
  });

  it('offers nothing when the base returned nothing', () => {
    expect(overrideOptions(result({ alternatives: [] }))).toEqual([]);
  });
});

describe('groupByTier', () => {
  it('returns nothing for no results', () => {
    expect(groupByTier([])).toEqual([]);
  });

  it('orders the groups the way a reviewer works through them', () => {
    const groups = groupByTier([
      result({ id: 'a', tier: 'unmatched' }),
      result({ id: 'b', tier: 'needs_review' }),
      result({ id: 'c', tier: 'exact' }),
      result({ id: 'd', tier: 'high_confidence' }),
    ]);
    expect(groups.map((group) => group.tier)).toEqual([
      'exact',
      'high_confidence',
      'needs_review',
      'unmatched',
    ]);
  });

  it('omits an empty tier rather than rendering a heading over nothing', () => {
    const groups = groupByTier([result({ tier: 'unmatched' }), result({ tier: 'exact' })]);
    expect(groups.map((group) => group.tier)).toEqual(['exact', 'unmatched']);
  });

  it('keeps submission order inside a group', () => {
    // A reviewer reads a bill down the page, not by score.
    const groups = groupByTier([
      result({ id: 'r3', line_no: 3, tier: 'needs_review', confidence: '0.50' }),
      result({ id: 'r1', line_no: 1, tier: 'needs_review', confidence: '0.70' }),
      result({ id: 'r2', line_no: 2, tier: 'needs_review', confidence: '0.60' }),
    ]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['r3', 'r1', 'r2']);
  });

  it('loses nothing, including a row whose tier it had to re-derive', () => {
    const results = [
      result({ tier: 'exact' }),
      result({ tier: 'partial_match', confidence: '0.50' }),
      result({ tier: 'unmatched' }),
    ];
    const grouped = groupByTier(results).reduce((count, group) => count + group.items.length, 0);
    expect(grouped).toBe(results.length);
  });
});

describe('tallyResults', () => {
  it('reports every figure as a real zero on an empty set', () => {
    // A screen that renders an absent count and a real zero the same way
    // cannot tell "no rejections" from "we did not look".
    expect(tallyResults([])).toEqual({
      total: 0,
      exact: 0,
      high_confidence: 0,
      needs_review: 0,
      unmatched: 0,
      pending: 0,
      confirmed: 0,
      overridden: 0,
      rejected: 0,
      queueLength: 0,
    });
  });

  it('counts each row once by tier and once by ruling', () => {
    const tally = tallyResults([
      result({ tier: 'exact', decision_state: 'confirmed' }),
      result({ tier: 'high_confidence', decision_state: 'pending' }),
      result({ tier: 'needs_review', decision_state: 'pending' }),
      result({ tier: 'needs_review', decision_state: 'overridden' }),
      result({ tier: 'unmatched', decision_state: 'rejected' }),
    ]);
    expect(tally.total).toBe(5);
    expect(tally.exact + tally.high_confidence + tally.needs_review + tally.unmatched).toBe(5);
    expect(tally.pending + tally.confirmed + tally.overridden + tally.rejected).toBe(5);
    expect(tally.needs_review).toBe(2);
    expect(tally.pending).toBe(2);
    expect(tally.confirmed).toBe(1);
    expect(tally.rejected).toBe(1);
  });

  it('counts the queue as the pending half of the two open tiers', () => {
    const tally = tallyResults([
      result({ tier: 'needs_review', decision_state: 'pending' }),
      result({ tier: 'unmatched', decision_state: 'pending' }),
      result({ tier: 'unmatched', decision_state: 'rejected' }),
      result({ tier: 'exact', decision_state: 'pending' }),
    ]);
    expect(tally.queueLength).toBe(2);
    expect(tally.pending).toBe(3);
  });

  it('counts a row by the tier and the state it narrows to', () => {
    const tally = tallyResults([
      result({ tier: 'partial_match', confidence: '0.10', decision_state: 'escalated' }),
    ]);
    expect(tally.total).toBe(1);
    expect(tally.unmatched).toBe(1);
    expect(tally.pending).toBe(1);
    expect(tally.queueLength).toBe(1);
  });
});

describe('a result whose collections did not arrive', () => {
  it('is read rather than thrown on', () => {
    // `decisions`, `alternatives` and `factors` each carry a guard, and the
    // panel calls all of these on every row it paints: one absent array
    // would take the whole register down rather than one cell.
    const sparse = result({
      tier: 'partial_match',
      confidence: '0.92',
      decisions: undefined as unknown as MatchDecision[],
      alternatives: undefined as unknown as MatchCandidate[],
      factors: undefined as unknown as Record<string, number>,
    });
    expect(resultTier(sparse)).toBe('high_confidence');
    expect(currentDecision(sparse)).toBeNull();
    expect(adoptedItem(sparse)).toBeNull();
    expect(overrideOptions(sparse)).toEqual([]);
    expect(tallyResults([sparse]).high_confidence).toBe(1);
  });
});

describe('parseBillLines', () => {
  it('reads the four columns a pasted bill carries', () => {
    const bill = parseBillLines('Concrete C25/30 to foundations\tm3\t120.5\tA.1.10');
    expect(bill.lines).toEqual([
      {
        description: 'Concrete C25/30 to foundations',
        unit: 'm3',
        quantity: '120.5',
        source_ref: 'A.1.10',
      },
    ]);
  });

  it('reads the separators a spreadsheet and a CSV actually produce', () => {
    for (const separator of ['\t', ';', '|']) {
      expect(parseBillLines(['Blockwork', 'm2', '48', 'B.2'].join(separator)).lines[0]).toEqual({
        description: 'Blockwork',
        unit: 'm2',
        quantity: '48',
        source_ref: 'B.2',
      });
    }
  });

  it('treats a row with no separator as all description', () => {
    // The common case of one column pasted on its own.
    expect(parseBillLines('Excavate to reduce levels').lines[0]).toEqual({
      description: 'Excavate to reduce levels',
      unit: '',
      quantity: null,
      source_ref: '',
    });
  });

  it('trims the padding a spreadsheet leaves around a cell', () => {
    expect(parseBillLines('  Blockwork ; m2 ; 48 ; B.2 ').lines[0]).toEqual({
      description: 'Blockwork',
      unit: 'm2',
      quantity: '48',
      source_ref: 'B.2',
    });
  });

  it('ignores the columns past the fourth', () => {
    expect(parseBillLines('Blockwork;m2;48;B.2;140.00;EUR').lines[0]?.source_ref).toBe('B.2');
  });

  it('reads a quantity in whatever notation wrote it', () => {
    // A bill is pasted from a spreadsheet in the locale that produced it, so
    // all of these are one number. Whichever of `,` and `.` comes last is the
    // decimal separator.
    const bill = parseBillLines(
      ['a;m3;1,5', 'b;m3;1.234,56', 'c;m3;1,234.56', 'd;m3;1 234.56', 'e;m3;1.234.567,89'].join('\n'),
    );
    expect(bill.lines.map((line) => line.quantity)).toEqual([
      '1.5',
      '1234.56',
      '1234.56',
      '1234.56',
      '1234567.89',
    ]);
    expect(bill.unreadableQuantity).toBe(0);
  });

  it('keeps a quantity as the string it was written as', () => {
    // The figure the line is measured by. Through a JS number this one comes
    // back short, and the schema takes a decimal string for that reason.
    expect(parseBillLines('a;m3;1,234,567.891234567890').lines[0]?.quantity).toBe(
      '1234567.891234567890',
    );
    expect(parseBillLines('a;m3;0.000').lines[0]?.quantity).toBe('0.000');
  });

  it('separates a quantity of zero from a column left blank', () => {
    // Zero of something is a measured quantity. A blank column is a line the
    // schema takes without one, and reporting it as unreadable would send
    // the person hunting for a fault that is not there.
    const bill = parseBillLines(['a;m3;0', 'b;m3;'].join('\n'));
    expect(bill.lines[0]?.quantity).toBe('0');
    expect(bill.lines[1]?.quantity).toBeNull();
    expect(bill.unreadableQuantity).toBe(0);
  });

  it('drops a figure it cannot read and says how many it dropped', () => {
    const bill = parseBillLines(['a;m3;about 12', 'b;m3;12,5,5', 'c;m3;12'].join('\n'));
    expect(bill.lines.map((line) => line.quantity)).toEqual([null, null, '12']);
    expect(bill.unreadableQuantity).toBe(2);
  });

  it('drops a negative figure rather than let one credit line refuse the batch', () => {
    // `quantity` is declared ge=0, so a single credit would 422 all five
    // hundred lines. Keeping the line and reporting the loss is the smaller
    // one, and the row is still there for the reviewer to price by hand.
    const bill = parseBillLines('Credit for omitted works;m3;-4');
    expect(bill.lines[0]?.quantity).toBeNull();
    expect(bill.lines[0]?.description).toBe('Credit for omitted works');
    expect(bill.unreadableQuantity).toBe(1);
  });

  it('keeps a blank row in the middle and drops the ones the paste left at the end', () => {
    // A bill really does contain header-only and empty rows, and dropping
    // them would hide from the reviewer that the paste had holes in it.
    expect(parseBillLines('a\n\nb\n\n\n').lines.map((line) => line.description)).toEqual([
      'a',
      '',
      'b',
    ]);
  });

  it('reads an empty paste as no lines rather than as one blank one', () => {
    expect(parseBillLines('')).toEqual({ lines: [], overflow: 0, unreadableQuantity: 0 });
    expect(parseBillLines('   \n  ').lines).toEqual([]);
  });

  it('reads the line endings of every platform that pastes into it', () => {
    expect(parseBillLines('a\r\nb\rc\nd').lines.map((line) => line.description)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('caps the batch and reports what it could not carry', () => {
    // Past the cap the request is refused whole, so 501 lines must not be
    // sent as one 422 (the backend cap, schemas.MAX_BATCH_LINES, is 500).
    const rows = Array.from({ length: 501 }, (_, index) => `Line ${index + 1};m3;1`);
    const bill = parseBillLines(rows.join('\n'));
    expect(bill.lines).toHaveLength(500);
    expect(bill.overflow).toBe(1);
    expect(bill.lines[499]?.description).toBe('Line 500');
  });

  it('reports no overflow on a paste that exactly fills the batch', () => {
    const rows = Array.from({ length: 500 }, (_, index) => `Line ${index + 1};m3;1`);
    const bill = parseBillLines(rows.join('\n'));
    expect(bill.lines).toHaveLength(500);
    expect(bill.overflow).toBe(0);
  });

  it('takes a lower cap from the caller', () => {
    const bill = parseBillLines(['a;m3;1', 'b;m3;2', 'c;m3;3'].join('\n'), 2);
    expect(bill.lines.map((line) => line.description)).toEqual(['a', 'b']);
    expect(bill.overflow).toBe(1);
  });
});
