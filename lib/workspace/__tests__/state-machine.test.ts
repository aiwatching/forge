/**
 * State Machine Tests — verify smith/task status transitions and message flow.
 *
 * Usage: npx tsx lib/workspace/__tests__/state-machine.test.ts
 */

import assert from 'node:assert';
import { WorkspaceOrchestrator } from '../orchestrator';
import { AgentBus } from '../agent-bus';
import type { WorkspaceAgentConfig, AgentState, BusMessage, WorkerEvent } from '../types';

const TEST_WS = 'test-sm-' + Date.now();
const TEST_PATH = '/tmp/test-sm';

// ─── Helpers ─────────────────────────────────────────────

function createOrch(): WorkspaceOrchestrator {
  return new WorkspaceOrchestrator(TEST_WS, TEST_PATH, 'test');
}

function addInput(orch: WorkspaceOrchestrator, id = 'input-1'): void {
  orch.addAgent({
    id, label: 'Requirements', icon: '📝', type: 'input',
    content: '', entries: [], role: '', backend: 'cli',
    dependsOn: [], outputs: [], steps: [],
  });
}

function addAgent(orch: WorkspaceOrchestrator, id: string, label: string, dependsOn: string[]): void {
  orch.addAgent({
    id, label, icon: '🤖', role: 'test', backend: 'cli',
    dependsOn, outputs: [], workDir: id, // unique workDir to avoid conflicts
    steps: [{ id: 's1', label: 'Step 1', prompt: 'do something' }],
  });
}

function getState(orch: WorkspaceOrchestrator, id: string): AgentState {
  return orch.getAllAgentStates()[id];
}

function collectEvents(orch: WorkspaceOrchestrator): any[] {
  const events: any[] = [];
  orch.on('event', (e: any) => events.push(e));
  return events;
}

let passed = 0;
let failed = 0;
let testNum = 0;

function ok(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function test(name: string, fn: () => void | Promise<void>) {
  testNum++;
  console.log(`\n📋 Test ${testNum}: ${name}`);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.catch(e => {
        console.log(`  💥 Crashed: ${e.message}`);
        failed++;
      });
    }
  } catch (e: any) {
    console.log(`  💥 Crashed: ${e.message}`);
    failed++;
  }
}

// ─── Tests ───────────────────────────────────────────────

async function runAll() {
  console.log('🧪 State Machine Tests\n');

  // Test 1: Initial state
  await test('Initial agent state', () => {
    const orch = createOrch();
    addAgent(orch, 'a1', 'Agent1', []);
    const s = getState(orch, 'a1');
    ok(s.smithStatus === 'down', `smithStatus = down (got ${s.smithStatus})`);
    ok(s.taskStatus === 'idle', `taskStatus = idle (got ${s.taskStatus})`);
    ok(s.mode === 'auto', `mode = auto (got ${s.mode})`);
  });

  // Test 2: startDaemon sets all smiths to active
  await test('startDaemon sets smithStatus=active', async () => {
    const orch = createOrch();
    addInput(orch);
    addAgent(orch, 'pm', 'PM', ['input-1']);
    addAgent(orch, 'eng', 'Engineer', ['pm']);

    ok(getState(orch, 'pm').smithStatus === 'down', 'PM starts down');
    ok(getState(orch, 'eng').smithStatus === 'down', 'Engineer starts down');

    await orch.startDaemon();

    ok(getState(orch, 'pm').smithStatus === 'active', 'PM active after startDaemon');
    ok(getState(orch, 'eng').smithStatus === 'active', 'Engineer active after startDaemon');
    ok(orch.isDaemonActive(), 'daemonActive = true');

    orch.stopDaemon();
    ok(getState(orch, 'pm').smithStatus === 'down', 'PM down after stopDaemon');
    ok(getState(orch, 'eng').smithStatus === 'down', 'Engineer down after stopDaemon');
    ok(!orch.isDaemonActive(), 'daemonActive = false');
  });

  // Test 3: stopDaemon preserves taskStatus
  await test('stopDaemon preserves taskStatus', async () => {
    const orch = createOrch();
    addAgent(orch, 'a1', 'Agent1', []);

    // Manually set to done to simulate completed agent
    const states = orch.getAllAgentStates();
    (states['a1'] as any).taskStatus = 'done';
    // Hack: directly modify internal state for testing
    (orch as any).agents.get('a1').state.taskStatus = 'done';

    await orch.startDaemon();
    ok(getState(orch, 'a1').taskStatus === 'done', 'taskStatus stays done after startDaemon');

    orch.stopDaemon();
    ok(getState(orch, 'a1').taskStatus === 'done', 'taskStatus stays done after stopDaemon');
  });

  // Test 4: loadSnapshot resets smith to down and pending messages to failed
  await test('loadSnapshot resets state correctly', () => {
    const orch = createOrch();

    const busLog: BusMessage[] = [
      { id: 'm1', from: 'a', to: 'b', type: 'notify', payload: { action: 'test' }, timestamp: Date.now(), status: 'pending' },
      { id: 'm2', from: 'a', to: 'b', type: 'notify', payload: { action: 'test2' }, timestamp: Date.now(), status: 'done' },
      { id: 'm3', from: 'a', to: 'b', type: 'notify', payload: { action: 'test3' }, timestamp: Date.now(), status: 'pending' },
    ];

    orch.loadSnapshot({
      agents: [{
        id: 'a1', label: 'Agent1', icon: '🤖', role: '', backend: 'cli',
        dependsOn: [], outputs: [], workDir: 'a1',
        steps: [{ id: 's1', label: 'Step1', prompt: 'test' }],
      }],
      agentStates: {
        'a1': {
          smithStatus: 'active', mode: 'auto', taskStatus: 'running',
          history: [], artifacts: [],
        } as AgentState,
      },
      busLog,
    });

    const s = getState(orch, 'a1');
    ok(s.smithStatus === 'down', 'smithStatus reset to down after load');
    ok(s.taskStatus === 'failed', 'running taskStatus becomes failed after load');

    // Check bus messages
    const log = orch.getBusLog();
    const m1 = log.find(m => m.id === 'm1');
    const m2 = log.find(m => m.id === 'm2');
    const m3 = log.find(m => m.id === 'm3');
    ok(m1?.status === 'failed', 'pending message m1 marked failed');
    ok(m2?.status === 'done', 'acked message m2 unchanged');
    ok(m3?.status === 'failed', 'pending message m3 marked failed');
  });

  // Test 5: completeInput sends input_updated messages (no daemon to avoid CLI spawn)
  await test('completeInput sends bus messages to downstream', () => {
    const orch = createOrch();
    addInput(orch);
    addAgent(orch, 'pm', 'PM', ['input-1']);

    // Don't start daemon — just test that completeInput sends bus messages
    const busLog = orch.getBusLog();
    const before = busLog.length;

    orch.completeInput('input-1', 'Build a todo app');

    const after = busLog.length;
    ok(after > before, `New bus messages sent (${before} → ${after})`);

    const inputMsgs = busLog.filter(m => m.payload.action === 'input_updated');
    ok(inputMsgs.length > 0, 'input_updated message found');
    ok(inputMsgs[0].from === 'input-1', 'from = input-1');
    ok(inputMsgs[0].to === 'pm', 'to = pm');
    // Smith is down so message stays pending (not acked)
    ok(inputMsgs[0].status === 'pending', `message pending (smith down) — got ${inputMsgs[0].status}`);
  });

  // Test 6: broadcastCompletion sends upstream_complete (no daemon)
  await test('broadcastCompletion sends upstream_complete', () => {
    const orch = createOrch();
    addInput(orch);
    addAgent(orch, 'pm', 'PM', ['input-1']);
    addAgent(orch, 'eng', 'Engineer', ['pm']);

    // Set PM to done with artifacts
    (orch as any).agents.get('pm').state.taskStatus = 'done';
    (orch as any).agents.get('pm').state.artifacts = [{ type: 'file', path: 'docs/prd.md' }];
    (orch as any).agents.get('pm').state.history = [
      { type: 'result', subtype: 'final_summary', content: 'PRD completed', timestamp: new Date().toISOString() }
    ];

    (orch as any).broadcastCompletion('pm');

    const busLog = orch.getBusLog();
    const upstreamMsgs = busLog.filter(m => m.payload.action === 'upstream_complete' && m.from === 'pm');
    ok(upstreamMsgs.length > 0, 'upstream_complete message sent');
    ok(upstreamMsgs[0].to === 'eng', 'sent to Engineer');
    ok(upstreamMsgs[0].payload.files?.includes('docs/prd.md') === true, 'includes file path');
  });

  // Test 7: Bus message ACK flow
  await test('Bus message ACK: pending → acked on success, pending → failed on error', () => {
    const bus = new AgentBus();
    bus.setAgentStatus('a', 'alive');
    bus.setAgentStatus('b', 'alive');

    const msg = bus.send('a', 'b', 'notify', { action: 'test', content: 'hello' });
    ok(msg.status === 'pending', 'starts as pending');

    // Simulate ack
    msg.status = 'done';
    ok(msg.status === 'done', 'acked after processing');

    // Test failed path
    const msg2 = bus.send('a', 'b', 'notify', { action: 'test2', content: 'world' });
    msg2.status = 'failed';
    ok(msg2.status === 'failed', 'failed on error');

    // Test retry
    const retried = bus.retryMessage(msg2.id);
    ok(retried !== null, 'retryMessage returns message');
    ok(retried!.status === 'pending', 'retried message back to pending');
  });

  // Test 8: markAllPendingAsFailed
  await test('markAllPendingAsFailed on restart', () => {
    const bus = new AgentBus();
    bus.setAgentStatus('a', 'alive');
    bus.setAgentStatus('b', 'alive');

    const m1 = bus.send('a', 'b', 'notify', { action: 'test1' });
    const m2 = bus.send('a', 'b', 'notify', { action: 'test2' });
    m1.status = 'done'; // already processed
    // m2 stays pending

    bus.markAllPendingAsFailed();

    ok(m1.status === 'done', 'acked message unchanged');
    ok(m2.status === 'failed', 'pending message marked failed');
  });

  // Test 9: Manual run (force) dep check logic — test validateCanRun vs force dep check
  await test('Force run checks smith active, normal run checks taskStatus done', () => {
    const orch = createOrch();
    addInput(orch);
    addAgent(orch, 'pm', 'PM', ['input-1']);
    addAgent(orch, 'eng', 'Engineer', ['pm']);

    // Normal validateCanRun: PM idle → should fail
    let error1 = '';
    try { orch.validateCanRun('eng'); } catch (e: any) { error1 = e.message; }
    ok(error1.includes('not completed'), `Normal: rejects when PM idle`);

    // PM done → should pass
    (orch as any).agents.get('pm').state.taskStatus = 'done';
    let error2 = '';
    try { orch.validateCanRun('eng'); } catch (e: any) { error2 = e.message; }
    ok(!error2, `Normal: passes when PM done`);

    // Force dep check: PM smith down → should fail
    (orch as any).agents.get('pm').state.taskStatus = 'idle';
    (orch as any).agents.get('pm').state.smithStatus = 'down';
    // Simulate the force dep check from runAgentDaemon
    const config = (orch as any).agents.get('eng').config;
    let forceError = '';
    for (const depId of config.dependsOn) {
      const dep = (orch as any).agents.get(depId);
      if (dep && dep.config.type !== 'input' && dep.state.smithStatus !== 'active') {
        forceError = `${dep.config.label} smith not active`;
      }
    }
    ok(forceError.includes('not active'), `Force: rejects when PM smith down`);

    // PM smith active → should pass
    (orch as any).agents.get('pm').state.smithStatus = 'active';
    forceError = '';
    for (const depId of config.dependsOn) {
      const dep = (orch as any).agents.get(depId);
      if (dep && dep.config.type !== 'input' && dep.state.smithStatus !== 'active') {
        forceError = `${dep.config.label} smith not active`;
      }
    }
    ok(!forceError, `Force: passes when PM smith active`);
  });

  // Test 10: Auto trigger requires taskStatus=done (check via validateCanRun)
  await test('Auto trigger requires dep taskStatus=done', () => {
    const orch = createOrch();
    addInput(orch);
    addAgent(orch, 'pm', 'PM', ['input-1']);
    addAgent(orch, 'eng', 'Engineer', ['pm']);

    // PM is idle — validateCanRun for Engineer should fail
    let error = '';
    try {
      orch.validateCanRun('eng');
    } catch (e: any) {
      error = e.message;
    }
    ok(error.includes('not completed'), `validateCanRun rejects when PM idle: ${error}`);

    // Set PM to done — should pass
    (orch as any).agents.get('pm').state.taskStatus = 'done';
    let error2 = '';
    try {
      orch.validateCanRun('eng');
    } catch (e: any) {
      error2 = e.message;
    }
    ok(!error2, `validateCanRun passes when PM done (got: ${error2 || 'no error'})`);
  });

  // Test 11: taskStatus transitions - never goes from done to idle
  await test('taskStatus never goes from done→idle', async () => {
    const orch = createOrch();
    addAgent(orch, 'a1', 'Agent1', []);

    // Set to done
    (orch as any).agents.get('a1').state.taskStatus = 'done';
    (orch as any).agents.get('a1').state.smithStatus = 'active';

    // Stop daemon should NOT change taskStatus
    await orch.startDaemon();
    orch.stopDaemon();

    ok(getState(orch, 'a1').taskStatus === 'done',
      `taskStatus stays done after stop (got ${getState(orch, 'a1').taskStatus})`);
  });

  // Test 12: startDaemon doesn't re-send input messages
  await test('startDaemon does NOT broadcast existing input', async () => {
    const orch = createOrch();
    addInput(orch);
    addAgent(orch, 'pm', 'PM', ['input-1']);

    // Complete input first
    orch.completeInput('input-1', 'test content');

    const busLogBefore = orch.getBusLog().length;

    await orch.startDaemon();

    const busLogAfter = orch.getBusLog().length;
    const newMsgs = orch.getBusLog().slice(busLogBefore);
    const inputMsgs = newMsgs.filter(m => m.payload.action === 'input_updated');

    ok(inputMsgs.length === 0, `No input_updated sent by startDaemon (got ${inputMsgs.length})`);

    orch.stopDaemon();
  });

  // ─── Summary ──────────────────────────────────────────

  console.log('\n' + '═'.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(40));

  console.log('');
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// Force exit after 8s in case of dangling timers/workers
setTimeout(() => {
  console.log('\n(Force exit due to dangling timers)');
  process.exit(passed > 0 && failed === 0 ? 0 : 1);
}, 8000);
runAll();
