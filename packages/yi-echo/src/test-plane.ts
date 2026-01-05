#!/usr/bin/env tsx
/**
 * Test Plane API Client
 *
 * Verifies connectivity and basic operations with Plane.delo.sh
 */

import { PlaneClient } from '@flume/core';

const PLANE_API_KEY = 'plane_api_72e0decd8f9e46e68e2885521b8d64ff';

async function testPlane(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🛫 PLANE API CLIENT TEST');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();

  const plane = new PlaneClient({
    baseUrl: 'https://plane.delo.sh',
    apiKey: PLANE_API_KEY,
    workspaceSlug: '33god',
  });

  // Test 1: List projects
  console.log('📋 TEST 1: List Projects');
  console.log('─────────────────────────────────────────────────────────');
  const projects = await plane.listProjects();
  console.log(`Found ${projects.length} projects:`);
  for (const p of projects) {
    console.log(`  - ${p.identifier}: ${p.name}`);
  }
  console.log();

  // Test 2: Find specific project
  console.log('🔍 TEST 2: Find Flume Project');
  console.log('─────────────────────────────────────────────────────────');
  const flumeProject = await plane.findProjectByIdentifier('FLUME');
  if (flumeProject) {
    console.log(`Found: ${flumeProject.name} (${flumeProject.id})`);
    console.log(`Description: ${flumeProject.description?.substring(0, 100)}...`);
  } else {
    console.log('Flume project not found');
  }
  console.log();

  // Test 3: List states for a project
  console.log('📊 TEST 3: List States for Flume');
  console.log('─────────────────────────────────────────────────────────');
  if (flumeProject) {
    const states = await plane.listStates(flumeProject.id);
    console.log(`Found ${states.length} states:`);
    for (const s of states) {
      console.log(`  - ${s.name} (${s.group})${s.default ? ' [default]' : ''}`);
    }
  }
  console.log();

  // Test 4: List work items
  console.log('📝 TEST 4: List Work Items in Flume');
  console.log('─────────────────────────────────────────────────────────');
  if (flumeProject) {
    const workItems = await plane.listWorkItems(flumeProject.id);
    console.log(`Found ${workItems.length} work items:`);
    for (const item of workItems.slice(0, 5)) {
      console.log(`  - FLUME-${item.sequence_id}: ${item.name}`);
    }
    if (workItems.length > 5) {
      console.log(`  ... and ${workItems.length - 5} more`);
    }
  }
  console.log();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ PLANE API CLIENT TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
}

testPlane().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
