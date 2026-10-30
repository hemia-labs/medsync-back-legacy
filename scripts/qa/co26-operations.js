'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../src/domain/odontogram/operations');
let id = 0;
const batch = (chart, ops, base = chart.revision) => ({ batch_id: 'batch-' + ++id, base_revision: base, generation: chart.generation, catalog_version: D.CATALOG_VERSION, ops: ops.map(op => ({ client_op_id: 'op-' + ++id, ...op })) });
const add = (tooth, code = 'car', surfaces = 'MO') => ({ type: 'finding.add', tooth, code, surfaces, surface_pending: false });
test('volume ceiling rejects the complete batch without truncation or partial note writes',()=>{
 const chart=D.emptyChart('mixed');chart.teeth[16].findings=Array.from({length:D.LIMITS.findings_per_tooth},(_,i)=>({id:'old-'+i,status:'corrected',code:'car',surfaces:'M'}));
 const before=D.clone(chart);
 assert.throws(()=>D.applyBatch(chart,batch(chart,[{type:'note.set',tooth:17,text:'Must not persist'},add(16)]),'actor'),e=>e.code==='CO26_VOLUME_LIMIT');
 assert.deepEqual(chart,before);
});
test('explicit merge follows transitive overlaps and preserves identities in one audited reversible event',()=>{
 let chart=D.emptyChart('mixed');chart=D.applyBatch(chart,batch(chart,[add(16,'car','MO'),{...add(16,'car','OD'),overlap_choice:'separate'},add(16,'res','O'),{type:'note.set',tooth:16,text:'Keep'}]),'actor').chart;
 const before=D.clone(chart);const proposal=batch(chart,[{...add(16,'car','MV'),overlap_choice:'merge'}]);
 const merged=D.applyBatch(chart,proposal,'actor');const active=merged.chart.teeth[16].findings.filter(f=>f.status==='active');
 assert.equal(active.find(f=>f.code==='car').surfaces,'MODV');assert.equal(active.find(f=>f.code==='res').surfaces,'O');assert.equal(merged.chart.teeth[16].note,'Keep');
 assert.equal(active.find(f=>f.code==='car').merged_from.length,2);assert.equal(merged.events.length,1);
 const restored=D.applyBatch(merged.chart,batch(merged.chart,[{type:'operation.undo',tooth:16,target_op_id:proposal.ops[0].client_op_id}]),'actor',{[proposal.ops[0].client_op_id]:{actor:'actor',revision:merged.chart.revision,event:merged.events[0]}});
 assert.deepEqual(restored.chart.teeth[16].findings,before.teeth[16].findings);
});
test('mixed dentition, surfaces and atomic invalid batches preserve original', () => {
    const original = D.emptyChart('mixed');
    const result = D.applyBatch(original, batch(original, [add(16), add(55)]), 'actor');
    assert.equal(result.chart.revision, 1); assert.equal(original.revision, 0);
    assert.equal(result.chart.teeth[55].findings[0].surfaces, 'MO');
    assert.throws(() => D.applyBatch(original, batch(original, [add(16), add(99)]), 'actor'));
    assert.equal(original.teeth[16].findings.length, 0);
    assert.throws(() => D.applyBatch(original, batch(original, [add(16, 'car', null)]), 'actor'));
});
test('same actor two tabs conflict on the same tooth; other teeth merge', () => {
    const chart = D.emptyChart('permanent');
    const first = D.applyBatch(chart, batch(chart, [add(16)]), 'same-actor').chart;
    assert.throws(() => D.applyBatch(first, batch(first, [add(16, 'res', 'D')], 0), 'same-actor'), e => e.code === 'CO26_TOOTH_CONFLICT');
    const merged = D.applyBatch(first, batch(first, [add(17)], 0), 'same-actor').chart;
    assert.equal(merged.revision, 2); assert.equal(merged.teeth[16].findings.length, 1);
    assert.equal(merged.teeth[17].findings.length, 1);
});
test('exact duplicate and same note are no-op; revision increments once per batch', () => {
    let chart = D.emptyChart('permanent');
    chart = D.applyBatch(chart, batch(chart, [add(16), { type: 'note.set', tooth: 16, text: 'Prior note' }]), 'actor').chart;
    const result = D.applyBatch(chart, batch(chart, [add(16), { type: 'note.set', tooth: 16, text: 'Prior note' }]), 'actor');
    assert.equal(result.changed, false); assert.equal(result.chart.revision, 1);
    assert.throws(() => D.applyBatch(chart, batch(chart, [add(16, 'car', 'OD')]), 'actor'), /solapadas/);
});
test('review never deletes notes/restorations; later clinical changes invalidate current check', () => {
    let chart = D.emptyChart('primary');
    chart = D.applyBatch(chart, batch(chart, [add(55, 'res', 'O'), { type: 'note.set', tooth: 55, text: 'Nota previa' }]), 'actor').chart;
    chart = D.applyBatch(chart, batch(chart, [{ type: 'tooth.review', tooth: 55 }]), 'actor').chart;
    assert.equal(chart.teeth[55].note, 'Nota previa'); assert.equal(chart.teeth[55].findings.length, 1);
    assert.equal(chart.teeth[55].reviewed_revision, 2);
    chart = D.applyBatch(chart, batch(chart, [{ type: 'note.set', tooth: 55, text: 'Cambio posterior' }]), 'actor').chart;
    assert.ok(chart.teeth[55].version > chart.teeth[55].reviewed_revision);
});
test('evolution and inverse keep origins, results and note with atomic events', () => {
    let chart = D.emptyChart('permanent');
    chart = D.applyBatch(chart, batch(chart, [add(16), { type: 'note.set', tooth: 16, text: 'Keep note' }]), 'actor').chart;
    const origin = chart.teeth[16].findings[0].id;
    const evolution = batch(chart, [{ type: 'finding.evolve', tooth: 16, origins: [origin], results: [{ code: 'res', surfaces: 'MO' }] }]);
    const result = D.applyBatch(chart, evolution, 'actor');
    assert.equal(result.events.length, 1); assert.equal(result.chart.teeth[16].findings[0].status, 'resolved');
    assert.equal(result.chart.teeth[16].findings[1].origin_ids[0], origin);
    chart = D.applyBatch(result.chart, batch(result.chart, [{ type: 'finding.evolve.undo', tooth: 16, evolution_id: evolution.ops[0].client_op_id }]), 'actor').chart;
    assert.equal(chart.teeth[16].findings[0].status, 'active'); assert.equal(chart.teeth[16].findings[1].status, 'corrected');
    assert.equal(chart.teeth[16].note, 'Keep note');
});
test('correction restore is audited and lifecycle generation blocks stale edits', () => {
    let chart = D.emptyChart('permanent');
    chart = D.applyBatch(chart, batch(chart, [add(16)]), 'actor').chart;
    const finding_id = chart.teeth[16].findings[0].id;
    chart = D.applyBatch(chart, batch(chart, [{ type: 'finding.remove', tooth: 16, finding_id }]), 'actor').chart;
    chart = D.applyBatch(chart, batch(chart, [{ type: 'finding.restore', tooth: 16, finding_id }]), 'actor').chart;
    assert.equal(chart.teeth[16].findings[0].status, 'active');
    const stale = batch(chart, [add(17)]); chart.generation++;
    assert.throws(() => D.applyBatch(chart, stale, 'actor'), e => e.code === 'CO26_GENERATION');
});
test('canonical hash includes identity-independent payload and ignores object key ordering', () => {
    assert.equal(D.hash({ b: 2, a: [1, 2] }), D.hash({ a: [1, 2], b: 2 }));
    assert.notEqual(D.hash({ text: 'A' }), D.hash({ text: 'B' }));
});
test('review freshness follows operation order within a single revision', () => {
    const chart = D.emptyChart('permanent');
    const reviewFirst = D.applyBatch(chart,batch(chart,[{type:'tooth.review',tooth:16},{type:'note.set',tooth:16,text:'After review'}]),'actor').chart;
    assert.equal(reviewFirst.teeth[16].reviewed_revision,1);assert.equal(reviewFirst.teeth[16].version,1);assert.equal(reviewFirst.teeth[16].review_invalidated,true);
    const reviewLast = D.applyBatch(chart,batch(chart,[{type:'note.set',tooth:16,text:'Before review'},{type:'tooth.review',tooth:16}]),'actor').chart;
    assert.equal(reviewLast.teeth[16].review_invalidated,false);
});
test('pres corrects presence explicitly without touching notes or inferring health',()=>{
 const initial=D.emptyChart('permanent');
 let chart=D.applyBatch(initial,batch(initial,[add(18,'aus',null),{type:'note.set',tooth:18,text:'Keep previous text'}]),'actor').chart;
 chart=D.applyBatch(chart,batch(chart,[{type:'presence.correct',tooth:18}]),'actor').chart;
 assert.equal(chart.teeth[18].findings[0].status,'corrected');assert.equal(chart.teeth[18].note,'Keep previous text');assert.equal(chart.teeth[18].reviewed_revision,null);
});
test('undo uses only server event snapshots and rejects later changes or another actor', () => {
    const initial = D.emptyChart('permanent');
    const original = batch(initial, [add(16)]);
    const applied = D.applyBatch(initial, original, 'actor');
    const target = original.ops[0].client_op_id;
    const undoEvents = { [target]: { actor: 'actor', revision: 1, event: applied.events[0] } };
    const request = batch(applied.chart, [{ type: 'operation.undo', tooth: 16, target_op_id: target, before: { note: 'Untrusted text' } }]);
    assert.throws(() => D.applyBatch(applied.chart, request, 'actor'), /no pertenece/);
    const restored = D.applyBatch(applied.chart, request, 'actor', undoEvents);
    assert.equal(restored.chart.teeth[16].findings.length, 0);
    assert.equal(restored.chart.teeth[16].note, '');
    assert.throws(() => D.applyBatch(applied.chart, request, 'other-actor', undoEvents), /no pertenece/);
    const newer = D.applyBatch(applied.chart, batch(applied.chart, [{ type: 'note.set', tooth: 16, text: 'Later work' }]), 'actor').chart;
    assert.throws(() => D.applyBatch(newer, batch(newer, [{ type: 'operation.undo', tooth: 16, target_op_id: target }]), 'actor', undoEvents), /no pertenece/);
});
