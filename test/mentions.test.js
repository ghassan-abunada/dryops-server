'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handlesIn } = require('../mentions');

test('finds JobNimbus @FirstLast handles', () => {
  assert.deepStrictEqual([...handlesIn('Any updates on this one? @AliZayyad @EthanAmon')], ['alizayyad', 'ethanamon']);
  assert.deepStrictEqual([...handlesIn('@TarikSabbah @AliZayyad  PO scheduled to start Wednesday')], ['tariksabbah', 'alizayyad']);
});

test('ignores emails and trims punctuation', () => {
  assert.deepStrictEqual([...handlesIn('send to gus@a1restorationteam.com')], []);
  assert.deepStrictEqual([...handlesIn('Thanks for the update ! @EthanAmon.')], ['ethanamon']);
  assert.deepStrictEqual([...handlesIn('<p>Done.</p><p>@Gta</p>')], ['gta']);
});
