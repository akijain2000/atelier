#!/usr/bin/env node

/**
 * E2E Smoke Test: SMS Simulator Round-Trip
 *
 * Tests the full flow: Lead ingestion -> First SMS -> Rova simulator -> Tenant reply -> AI auto-reply
 *
 * Usage:
 *   ATELIER_URL=https://atelier-production-b43e.up.railway.app \
 *   ROVA_URL=https://rova-xxx.onrender.com \
 *   WEBHOOK_SECRET=xxx \
 *   SIMULATOR_SECRET=xxx \
 *   JWT_TOKEN=xxx \
 *   node scripts/e2e-simulator-test.js
 */

const ATELIER = process.env.ATELIER_URL || 'http://localhost:3001';
const ROVA = process.env.ROVA_URL || 'http://localhost:3001';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SIM_SECRET = process.env.SIMULATOR_SECRET;
const JWT = process.env.JWT_TOKEN;

const testPhone = `+4799${Date.now().toString().slice(-6)}`;
const testName = `E2E Test ${Date.now()}`;

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

function assert(condition, msg) {
  if (!condition) { console.error(`  FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`  PASS: ${msg}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== SMS Simulator E2E Test ===');
  console.log(`Atelier: ${ATELIER}`);
  console.log(`Rova:    ${ROVA}`);
  console.log(`Phone:   ${testPhone}`);
  console.log();

  // Step 1: Ingest a lead
  console.log('1. Ingesting lead...');
  const leadPayload = {
    name: testName,
    phone: testPhone,
    email: `e2e-${Date.now()}@test.com`,
    age: 25,
    move_in_date: '2026-06-01',
    intro: 'E2E simulator test lead',
    consent_sms: true,
  };

  const ingestHeaders = {};
  if (WEBHOOK_SECRET) ingestHeaders['X-Webhook-Token'] = WEBHOOK_SECRET;

  const ingest = await post(`${ATELIER}/api/leads/ingest`, leadPayload, ingestHeaders);
  console.log(`  Status: ${ingest.status}`);
  assert(ingest.ok, `Lead ingested (${ingest.status})`);
  const conversationId = ingest.json?.conversationId;
  assert(!!conversationId, `Got conversationId: ${conversationId}`);
  console.log();

  // Step 2: Wait for first message to be sent to Rova
  console.log('2. Waiting for first message in Rova simulator...');
  let foundInRova = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const phones = await get(`${ROVA}/api/sms/simulator/phones`);
    if (phones.ok && phones.json?.some?.(p => p.phone === testPhone)) {
      foundInRova = true;
      break;
    }
    process.stdout.write('.');
  }
  console.log();
  assert(foundInRova, 'First message appeared in Rova simulator');

  if (!foundInRova) {
    console.log('  Checking Atelier conversation state...');
    if (JWT) {
      const conv = await get(`${ATELIER}/api/conversations/${conversationId}`, { Authorization: `Bearer ${JWT}` });
      console.log(`  Conversation flow_state: ${conv.json?.flow_state}`);
      console.log(`  Message count: ${conv.json?.message_count}`);
    }
    console.log('  ABORT: Cannot continue without first message.');
    return;
  }

  // Step 3: Read the thread
  console.log('3. Reading message thread...');
  const thread = await get(`${ROVA}/api/sms/simulator/${encodeURIComponent(testPhone)}/messages`);
  assert(thread.ok, 'Got message thread');
  assert(thread.json?.length > 0, `Thread has ${thread.json?.length} message(s)`);
  if (thread.json?.length) {
    const first = thread.json[0];
    console.log(`  First message: "${first.body?.slice(0, 80)}..."`);
    console.log(`  Direction: ${first.direction}, Chars: ${first.char_count}, Segments: ${first.segments}`);
    assert(first.direction === 'outbound', 'First message is outbound (from Atelier)');
    assert(first.char_count <= 480, `Char count within SMS limits (${first.char_count})`);
  }
  console.log();

  // Step 4: Send a tenant reply
  console.log('4. Sending tenant reply...');
  const reply = await post(`${ROVA}/api/sms/simulator/${encodeURIComponent(testPhone)}/reply`, {
    body: 'Hi! Yes I saw the video, the apartment looks great. Is it still available?',
  });
  console.log(`  Status: ${reply.status}`);
  assert(reply.ok, 'Reply sent successfully');
  assert(reply.json?.forwarded === true, 'Reply forwarded to Atelier');
  console.log();

  // Step 5: Wait for AI auto-reply (debounce is 30s default)
  console.log('5. Waiting for AI auto-reply (up to 60s for debounce + generation)...');
  let aiReplyFound = false;
  const startWait = Date.now();
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const msgs = await get(`${ROVA}/api/sms/simulator/${encodeURIComponent(testPhone)}/messages`);
    const outbounds = (msgs.json || []).filter(m => m.direction === 'outbound');
    if (outbounds.length >= 2) {
      aiReplyFound = true;
      const aiMsg = outbounds[outbounds.length - 1];
      console.log(`  AI reply received after ${Math.round((Date.now() - startWait) / 1000)}s`);
      console.log(`  AI response: "${aiMsg.body?.slice(0, 100)}..."`);
      console.log(`  Chars: ${aiMsg.char_count}, Segments: ${aiMsg.segments}`);
      assert(aiMsg.char_count <= 480, `AI reply within SMS limits (${aiMsg.char_count})`);
      break;
    }
    process.stdout.write('.');
  }
  console.log();
  assert(aiReplyFound, 'AI auto-reply received in Rova simulator');
  console.log();

  // Step 6: Cleanup
  console.log('6. Cleaning up test thread...');
  const del = await fetch(`${ROVA}/api/sms/simulator/${encodeURIComponent(testPhone)}/clear`, { method: 'DELETE' });
  assert(del.ok, 'Test thread cleared');
  console.log();

  console.log('=== E2E Test Complete ===');
}

main().catch(err => {
  console.error('E2E test crashed:', err);
  process.exitCode = 1;
});
