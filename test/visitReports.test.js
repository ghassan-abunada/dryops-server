// Monitor report: the fixture is shared byte for byte with the DryOps app
// (lib/__tests__/fixtures/monitorReport.json). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { validateMonitorReport, isMonitorReportComplete, summarizeMonitorReport, monitorTaskLine, createReportKinds } = require('../visitReports');
const { gpp, dewPointF } = require('../psychrometrics');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'monitorReport.json'), 'utf8'));

test('psychrometrics match the app', () => {
  assert.strictEqual(gpp(70, 50), 54);
  assert.strictEqual(gpp(80, 60), 92);
  assert.strictEqual(gpp(61, 35), 28);
  assert.strictEqual(gpp(92, 22), 49);
  assert.strictEqual(gpp(null, 50), null);
  assert.strictEqual(gpp(70, 101), null);
  assert.strictEqual(dewPointF(70, 0), null);
  assert.ok(Math.abs(dewPointF(70, 50) - 50.5) < 1);
});

test('monitor summary matches the shared fixture byte for byte', () => {
  const v = validateMonitorReport(fixture.input);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.strictEqual(summarizeMonitorReport(v.report), fixture.expected_summary);
  assert.strictEqual(monitorTaskLine(v.report), fixture.expected_task_line);
  assert.strictEqual(isMonitorReportComplete(v.report), true);
});

test('validation rebuilds a whitelist and reports problems', () => {
  const bad = validateMonitorReport({ ...fixture.input, kind: 'demo', arrival_time: '9:40', rooms: [{ name: '', reading: { temp_f: 500, rh: 40 } }] });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((e) => /kind must be monitor/.test(e)));
  assert.ok(bad.errors.some((e) => /arrival_time/.test(e)));
  assert.ok(bad.errors.some((e) => /room 1 needs a name/.test(e)));
  assert.ok(bad.errors.some((e) => /temp must be a number/.test(e)));
  const extra = validateMonitorReport({ ...fixture.input, evil: 'x', rooms: [{ ...fixture.input.rooms[0], junk: 1 }] });
  assert.ok(extra.ok);
  assert.strictEqual('evil' in extra.report, false);
  assert.strictEqual('junk' in extra.report.rooms[0], false);
  // one outlet slot per running dehumidifier
  const two = validateMonitorReport({ ...fixture.input, rooms: [{ ...fixture.input.rooms[0], equipment: [{ type: 'Dehumidifier', qty_before: 0, qty_present: 2 }], dehu_outlets: [] }] });
  assert.strictEqual(two.report.rooms[0].dehu_outlets.length, 2);
  assert.strictEqual(isMonitorReportComplete(two.report), false);
});

test('registry wires demo + monitor', () => {
  const kinds = createReportKinds({ validateDemoReport: () => 1, isDemoReportComplete: () => 2, summarizeDemoReport: () => 3, demoReportTaskLine: () => 4 });
  assert.strictEqual(kinds.demo.column, 'demo_report');
  assert.strictEqual(kinds.monitor.column, 'monitor_report');
  assert.strictEqual(kinds.monitor.requiredFromTechLink, true);
  assert.strictEqual(kinds.demo.summarize(), 3);
});
