#!/usr/bin/env node

/**
 * Comprehensive workflow test script for Proxmox MCP Server
 * Tests complete lifecycle workflows for VMs, containers, networking, disks, snapshots, and backups
 *
 * Usage:
 *   node test-workflows.js [options]
 *
 * Options:
 *   --dry-run           Show what would be done without executing
 *   --workflow=NAME     Run specific workflow (lxc, vm, network, disk, snapshot, backup, all)
 *   --no-cleanup        Skip cleanup after tests
 *   --interactive       Prompt before each destructive operation
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

// Configuration
const config = {
  dryRun: process.argv.includes('--dry-run'),
  interactive: process.argv.includes('--interactive'),
  noCleanup: process.argv.includes('--no-cleanup'),
  workflow: process.argv.find(arg => arg.startsWith('--workflow='))?.split('=')[1] || 'all',
  testNode: null,  // Will be auto-detected
  testVmid: null,  // Will be generated
  testResources: []  // Track resources for cleanup
};

// Test results
const results = {
  passed: [],
  failed: [],
  skipped: []
};

// Create readline interface for interactive prompts
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${colors.dim}[${timestamp}]${colors.reset} ${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log(`\n${colors.cyan}${'═'.repeat(70)}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}  ${title}${colors.reset}`);
  console.log(`${colors.cyan}${'═'.repeat(70)}${colors.reset}\n`);
}

function logStep(step, detail = '') {
  console.log(`${colors.blue}▶${colors.reset} ${colors.bright}${step}${colors.reset}`);
  if (detail) console.log(`  ${colors.dim}${detail}${colors.reset}`);
}

function logSuccess(message) {
  console.log(`  ${colors.green}✓ ${message}${colors.reset}`);
}

function logError(message) {
  console.log(`  ${colors.red}✗ ${message}${colors.reset}`);
}

function logWarning(message) {
  console.log(`  ${colors.yellow}⚠ ${message}${colors.reset}`);
}

async function prompt(question) {
  return new Promise((resolve) => {
    rl.question(`${colors.yellow}${question} (y/n): ${colors.reset}`, (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Call MCP tool
async function callTool(toolName, args = {}) {
  if (config.dryRun) {
    log(`[DRY-RUN] Would call: ${toolName} with ${JSON.stringify(args)}`, 'dim');
    return { success: true, dryRun: true, content: 'Dry run - no actual call made' };
  }

  return new Promise((resolve, reject) => {
    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    };

    const serverProcess = spawn('node', [path.join(__dirname, 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    serverProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    serverProcess.on('close', (code) => {
      try {
        const lines = stdout.split('\n');
        let response = null;
        for (const line of lines) {
          if (line.trim().startsWith('{')) {
            try {
              response = JSON.parse(line);
              break;
            } catch (e) {
              // Not JSON, continue
            }
          }
        }

        if (response) {
          if (response.error) {
            resolve({
              success: false,
              error: response.error.message,
              errorCode: response.error.code
            });
          } else if (response.result && response.result.content) {
            const content = response.result.content[0];
            // Check if it's an error message about permissions
            if (content.text && content.text.includes('Requires Elevated Permissions')) {
              resolve({
                success: false,
                error: 'Elevated permissions required',
                content: content.text
              });
            } else {
              resolve({
                success: true,
                content: content.text || '',
                isError: response.result.isError || false
              });
            }
          } else {
            resolve({
              success: false,
              error: 'No content in response'
            });
          }
        } else {
          reject(new Error(`No JSON response. stdout: ${stdout.substring(0, 200)}`));
        }
      } catch (error) {
        reject(error);
      }
    });

    serverProcess.on('error', reject);
    serverProcess.stdin.write(JSON.stringify(request) + '\n');
    serverProcess.stdin.end();
  });
}

// Track resource for cleanup
function trackResource(type, node, vmid) {
  config.testResources.push({ type, node, vmid });
  log(`Tracking resource for cleanup: ${type} ${vmid} on ${node}`, 'dim');
}

// Record test result
function recordResult(workflow, testName, success, message, details = null) {
  const result = { workflow, test: testName, message, details };
  if (success) {
    results.passed.push(result);
    logSuccess(`${testName}: ${message}`);
  } else {
    results.failed.push(result);
    logError(`${testName}: ${message}`);
  }
}

// ============================================================================
// WORKFLOW TESTS
// ============================================================================

async function testLXCWorkflow() {
  logSection('LXC Container Complete Workflow');

  try {
    // Step 1: Get next available VMID
    logStep('Step 1: Get next available VMID');
    const vmidResult = await callTool('proxmox_get_next_vmid');
    if (!vmidResult.success) {
      recordResult('lxc', 'Get VMID', false, vmidResult.error);
      return;
    }
    const vmidMatch = vmidResult.content.match(/\d{3,}/);
    if (!vmidMatch) {
      recordResult('lxc', 'Get VMID', false, 'Could not parse VMID from response');
      return;
    }
    config.testVmid = vmidMatch[0];
    logSuccess(`Got VMID: ${config.testVmid}`);

    // Step 2: List available templates
    logStep('Step 2: List available templates', `Node: ${config.testNode}`);
    const templatesResult = await callTool('proxmox_list_templates', {
      node: config.testNode,
      storage: 'local'
    });
    if (!templatesResult.success) {
      recordResult('lxc', 'List Templates', false, templatesResult.error);
      return;
    }
    logSuccess('Templates listed successfully');

    // Try to find a Debian template - handles markdown format: **local:vztmpl/debian-...**
    const templateMatch = templatesResult.content.match(/\*\*local:vztmpl\/(debian-\d+-standard[^\s*]+)\*\*/i) ||
                         templatesResult.content.match(/\*\*local:vztmpl\/([^\s*]+\.tar\.[gxz]+)\*\*/i) ||
                         templatesResult.content.match(/\*\*local:vztmpl\/(debian[^\s*]+)\*\*/i) ||
                         templatesResult.content.match(/\*\*local:vztmpl\/([^\s*]+)\*\*/i);

    if (!templateMatch) {
      recordResult('lxc', 'Find Template', false, 'No suitable template found', templatesResult.content);
      return;
    }
    const template = `local:vztmpl/${templateMatch[1]}`;
    logSuccess(`Found template: ${template}`);

    // Step 3: Create LXC container
    if (config.interactive) {
      const proceed = await prompt(`Create LXC container ${config.testVmid}?`);
      if (!proceed) {
        recordResult('lxc', 'Create Container', false, 'Skipped by user');
        return;
      }
    }

    logStep('Step 3: Create LXC container', `VMID: ${config.testVmid}, Template: ${template}`);
    const createResult = await callTool('proxmox_create_lxc', {
      node: config.testNode,
      vmid: config.testVmid,
      ostemplate: template,
      hostname: `test-mcp-${config.testVmid}`,
      password: 'Test123!@#',
      memory: 512,
      storage: 'local-lvm',
      rootfs: '4'
    });

    if (!createResult.success) {
      recordResult('lxc', 'Create Container', false, createResult.error || 'Creation failed', createResult.content);
      return;
    }
    trackResource('lxc', config.testNode, config.testVmid);
    recordResult('lxc', 'Create Container', true, `Container ${config.testVmid} created`);
    await sleep(2000); // Wait for creation to complete

    // Step 4: Start container
    logStep('Step 4: Start LXC container', `VMID: ${config.testVmid}`);
    const startResult = await callTool('proxmox_start_lxc', {
      node: config.testNode,
      vmid: config.testVmid
    });

    if (!startResult.success) {
      recordResult('lxc', 'Start Container', false, startResult.error);
    } else {
      recordResult('lxc', 'Start Container', true, `Container ${config.testVmid} started`);
      await sleep(3000); // Wait for startup
    }

    // Step 5: Check status
    logStep('Step 5: Check container status');
    const statusResult = await callTool('proxmox_get_vm_status', {
      node: config.testNode,
      vmid: config.testVmid,
      type: 'lxc'
    });

    if (!statusResult.success) {
      recordResult('lxc', 'Check Status', false, statusResult.error);
    } else {
      const isRunning = statusResult.content.toLowerCase().includes('running');
      recordResult('lxc', 'Check Status', isRunning,
        isRunning ? 'Container is running' : 'Container is not running',
        statusResult.content.substring(0, 200));
    }

    // Step 6: Create snapshot
    logStep('Step 6: Create snapshot', `Name: test-snapshot`);
    const snapshotResult = await callTool('proxmox_create_snapshot_lxc', {
      node: config.testNode,
      vmid: config.testVmid,
      snapname: 'test-snapshot'
    });

    if (!snapshotResult.success) {
      recordResult('lxc', 'Create Snapshot', false, snapshotResult.error);
    } else {
      recordResult('lxc', 'Create Snapshot', true, 'Snapshot created');
      await sleep(5000); // Increased wait time for Proxmox to register snapshot
    }

    // Step 7: List snapshots (with retry logic)
    logStep('Step 7: List snapshots');

    let hasSnapshot = false;
    let listSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const listSnapshotsResult = await callTool('proxmox_list_snapshots_lxc', {
        node: config.testNode,
        vmid: config.testVmid
      });

      if (!listSnapshotsResult.success) {
        if (attempt === 3) {
          recordResult('lxc', 'List Snapshots', false, listSnapshotsResult.error);
        }
        break;
      }

      hasSnapshot = listSnapshotsResult.content.includes('test-snapshot');
      if (hasSnapshot) {
        listSuccess = true;
        recordResult('lxc', 'List Snapshots', true, 'Snapshot found in list');
        break;
      }

      if (attempt < 3) {
        logWarning(`Snapshot not found yet, retrying in 2 seconds... (attempt ${attempt}/3)`);
        await sleep(2000);
      }
    }

    if (listSuccess === false && hasSnapshot === false) {
      recordResult('lxc', 'List Snapshots', false, 'Snapshot not found in list after 3 attempts');
    }

    // Step 8: Stop container
    logStep('Step 8: Stop LXC container');
    const stopResult = await callTool('proxmox_stop_lxc', {
      node: config.testNode,
      vmid: config.testVmid
    });

    if (!stopResult.success) {
      recordResult('lxc', 'Stop Container', false, stopResult.error);
    } else {
      recordResult('lxc', 'Stop Container', true, `Container ${config.testVmid} stopped`);
      await sleep(3000);
    }

    // Step 9: Delete snapshot
    logStep('Step 9: Delete snapshot');
    const deleteSnapshotResult = await callTool('proxmox_delete_snapshot_lxc', {
      node: config.testNode,
      vmid: config.testVmid,
      snapname: 'test-snapshot'
    });

    if (!deleteSnapshotResult.success) {
      recordResult('lxc', 'Delete Snapshot', false, deleteSnapshotResult.error);
    } else {
      recordResult('lxc', 'Delete Snapshot', true, 'Snapshot deleted');
      await sleep(2000);
    }

  } catch (error) {
    recordResult('lxc', 'Workflow', false, `Exception: ${error.message}`);
  }
}

async function testVMLifecycleWorkflow() {
  logSection('VM Lifecycle Operations Workflow');

  try {
    // Find an existing VM to test with
    logStep('Step 1: Find existing VM for testing');
    const vmsResult = await callTool('proxmox_get_vms');

    if (!vmsResult.success) {
      recordResult('vm-lifecycle', 'Find VM', false, vmsResult.error);
      return;
    }

    // Try to find a stopped VM, or any VM - handles format: (ID: 100) ... • Node: pve1 ... • Status: running
    const vmMatch = vmsResult.content.match(/\(ID:\s*(\d+)\).*?[•\s]*Node:\s*(\S+).*?[•\s]*Status:\s*(\S+)/is);

    if (!vmMatch) {
      recordResult('vm-lifecycle', 'Find VM', false, 'No VMs found for testing');
      return;
    }

    const existingVmid = vmMatch[1];
    const existingNode = vmMatch[2];
    const existingStatus = vmMatch[3];

    logSuccess(`Found VM ${existingVmid} on ${existingNode} (status: ${existingStatus})`);
    recordResult('vm-lifecycle', 'Find VM', true, `Testing with VM ${existingVmid}`);

    // Determine VM type
    logStep('Step 2: Detect VM type');
    let vmType = 'lxc';
    if (vmsResult.content.includes(`ID: ${existingVmid}`) && vmsResult.content.includes('QEMU')) {
      vmType = 'qemu';
    }
    logSuccess(`VM type: ${vmType}`);

    // Step 3: Get detailed status
    logStep('Step 3: Get VM status');
    const statusResult = await callTool('proxmox_get_vm_status', {
      node: existingNode,
      vmid: existingVmid,
      type: vmType
    });

    if (!statusResult.success) {
      recordResult('vm-lifecycle', 'Get Status', false, statusResult.error);
    } else {
      recordResult('vm-lifecycle', 'Get Status', true, 'Status retrieved successfully');
    }

    // Test start/stop based on current state
    if (existingStatus.toLowerCase().includes('stopped')) {
      logStep('Step 4: Start VM (currently stopped)');
      const startTool = vmType === 'lxc' ? 'proxmox_start_lxc' : 'proxmox_start_vm';
      const startResult = await callTool(startTool, {
        node: existingNode,
        vmid: existingVmid
      });

      recordResult('vm-lifecycle', 'Start VM', startResult.success,
        startResult.success ? 'VM started' : startResult.error);

      if (startResult.success) {
        await sleep(3000);

        // Now test reboot
        logStep('Step 5: Reboot VM');
        const rebootTool = vmType === 'lxc' ? 'proxmox_reboot_lxc' : 'proxmox_reboot_vm';
        const rebootResult = await callTool(rebootTool, {
          node: existingNode,
          vmid: existingVmid
        });

        recordResult('vm-lifecycle', 'Reboot VM', rebootResult.success,
          rebootResult.success ? 'VM rebooted' : rebootResult.error);
      }
    } else if (existingStatus.toLowerCase().includes('running')) {
      logStep('Step 4: VM already running, testing reboot');
      const rebootTool = vmType === 'lxc' ? 'proxmox_reboot_lxc' : 'proxmox_reboot_vm';
      const rebootResult = await callTool(rebootTool, {
        node: existingNode,
        vmid: existingVmid
      });

      recordResult('vm-lifecycle', 'Reboot VM', rebootResult.success,
        rebootResult.success ? 'VM rebooted' : rebootResult.error);
    }

  } catch (error) {
    recordResult('vm-lifecycle', 'Workflow', false, `Exception: ${error.message}`);
  }
}

async function testNetworkWorkflow() {
  logSection('Network Management Workflow');

  try {
    // Find an existing stopped VM to test network operations
    logStep('Step 1: Find stopped VM for network testing');
    const vmsResult = await callTool('proxmox_get_vms');

    if (!vmsResult.success) {
      recordResult('network', 'Find VM', false, vmsResult.error);
      return;
    }

    const vmMatch = vmsResult.content.match(/\(ID:\s*(\d+)\).*?[•\s]*Node:\s*(\S+).*?[•\s]*Status:\s*stopped/is);

    if (!vmMatch) {
      logWarning('No stopped VMs found, skipping network workflow (VM must be stopped)');
      recordResult('network', 'Find VM', false, 'No stopped VMs available');
      return;
    }

    const vmid = vmMatch[1];
    const node = vmMatch[2];

    logSuccess(`Using VM ${vmid} on ${node}`);

    // Determine VM type
    let vmType = vmsResult.content.includes('QEMU') ? 'qemu' : 'lxc';

    // Step 2: Add network interface
    logStep('Step 2: Add network interface', 'Bridge: vmbr0, Interface: net1');
    const addTool = vmType === 'qemu' ? 'proxmox_add_network_vm' : 'proxmox_add_network_lxc';
    const addResult = await callTool(addTool, {
      node: node,
      vmid: vmid,
      net: 'net1',
      bridge: 'vmbr0',
      firewall: true
    });

    if (!addResult.success) {
      recordResult('network', 'Add Interface', false, addResult.error);
      return;
    }
    recordResult('network', 'Add Interface', true, 'Network interface net1 added');

    // Step 3: Update network interface
    logStep('Step 3: Update network interface', 'Add rate limit');
    const updateTool = vmType === 'qemu' ? 'proxmox_update_network_vm' : 'proxmox_update_network_lxc';
    const updateResult = await callTool(updateTool, {
      node: node,
      vmid: vmid,
      net: 'net1',
      rate: 100
    });

    recordResult('network', 'Update Interface', updateResult.success,
      updateResult.success ? 'Network interface updated' : updateResult.error);

    // Step 4: Remove network interface
    logStep('Step 4: Remove network interface');
    const removeTool = vmType === 'qemu' ? 'proxmox_remove_network_vm' : 'proxmox_remove_network_lxc';
    const removeResult = await callTool(removeTool, {
      node: node,
      vmid: vmid,
      net: 'net1'
    });

    recordResult('network', 'Remove Interface', removeResult.success,
      removeResult.success ? 'Network interface removed' : removeResult.error);

  } catch (error) {
    recordResult('network', 'Workflow', false, `Exception: ${error.message}`);
  }
}

async function testDiskWorkflow() {
  logSection('Disk Management Workflow');

  try {
    logStep('Step 1: Find VM for disk testing');
    const vmsResult = await callTool('proxmox_get_vms');

    if (!vmsResult.success) {
      recordResult('disk', 'Find VM', false, vmsResult.error);
      return;
    }

    // Find a QEMU VM (disk operations are more reliable on QEMU) - handles format: (ID: 100) ... • Node: pve1 ... • Type: QEMU
    const vmMatch = vmsResult.content.match(/\(ID:\s*(\d+)\).*?[•\s]*Node:\s*(\S+).*?[•\s]*Type:\s*QEMU/is);

    if (!vmMatch) {
      logWarning('No QEMU VMs found, skipping disk workflow');
      recordResult('disk', 'Find VM', false, 'No QEMU VMs available');
      return;
    }

    const vmid = vmMatch[1];
    const node = vmMatch[2];

    logSuccess(`Using VM ${vmid} on ${node}`);

    // Step 2: Add disk
    logStep('Step 2: Add disk to VM', 'Size: 10G, Storage: local-lvm');
    const addResult = await callTool('proxmox_add_disk_vm', {
      node: node,
      vmid: vmid,
      disk: 'scsi1',
      size: '10G',
      storage: 'local-lvm'
    });

    if (!addResult.success) {
      recordResult('disk', 'Add Disk', false, addResult.error);
      return;
    }
    recordResult('disk', 'Add Disk', true, 'Disk added successfully');

    // Step 3: Resize disk
    logStep('Step 3: Resize disk', 'New size: +2G');
    const resizeResult = await callTool('proxmox_resize_disk_vm', {
      node: node,
      vmid: vmid,
      disk: 'scsi1',
      size: '+2G'
    });

    recordResult('disk', 'Resize Disk', resizeResult.success,
      resizeResult.success ? 'Disk resized' : resizeResult.error);

    // Step 4: Remove disk (cleanup)
    logStep('Step 4: Remove disk');
    const removeResult = await callTool('proxmox_remove_disk_vm', {
      node: node,
      vmid: vmid,
      disk: 'scsi1'
    });

    recordResult('disk', 'Remove Disk', removeResult.success,
      removeResult.success ? 'Disk removed' : removeResult.error);

  } catch (error) {
    recordResult('disk', 'Workflow', false, `Exception: ${error.message}`);
  }
}

async function testSnapshotWorkflow() {
  logSection('Snapshot Workflow');

  try {
    logStep('Step 1: Find VM for snapshot testing');
    const vmsResult = await callTool('proxmox_get_vms');

    if (!vmsResult.success) {
      recordResult('snapshot', 'Find VM', false, vmsResult.error);
      return;
    }

    const vmMatch = vmsResult.content.match(/\(ID:\s*(\d+)\).*?[•\s]*Node:\s*(\S+)/is);

    if (!vmMatch) {
      recordResult('snapshot', 'Find VM', false, 'No VMs found');
      return;
    }

    const vmid = vmMatch[1];
    const node = vmMatch[2];
    const vmType = vmsResult.content.includes('QEMU') ? 'qemu' : 'lxc';

    logSuccess(`Using ${vmType} ${vmid} on ${node}`);

    const snapname = `test-snap-${Date.now()}`;

    // Step 2: Create snapshot
    logStep('Step 2: Create snapshot', `Name: ${snapname}`);
    const createTool = vmType === 'qemu' ? 'proxmox_create_snapshot_vm' : 'proxmox_create_snapshot_lxc';
    const createResult = await callTool(createTool, {
      node: node,
      vmid: vmid,
      snapname: snapname
    });

    if (!createResult.success) {
      recordResult('snapshot', 'Create Snapshot', false, createResult.error);
      return;
    }
    recordResult('snapshot', 'Create Snapshot', true, `Snapshot ${snapname} created`);
    await sleep(5000); // Increased wait time for Proxmox to register snapshot

    // Step 3: List snapshots (with retry logic)
    logStep('Step 3: List snapshots');
    const listTool = vmType === 'qemu' ? 'proxmox_list_snapshots_vm' : 'proxmox_list_snapshots_lxc';

    let hasSnapshot = false;
    let listSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const listResult = await callTool(listTool, {
        node: node,
        vmid: vmid
      });

      if (!listResult.success) {
        if (attempt === 3) {
          recordResult('snapshot', 'List Snapshots', false, listResult.error);
        }
        break;
      }

      hasSnapshot = listResult.content.includes(snapname);
      if (hasSnapshot) {
        listSuccess = true;
        recordResult('snapshot', 'List Snapshots', true, `Snapshot ${snapname} found`);
        break;
      }

      if (attempt < 3) {
        logWarning(`Snapshot not found yet, retrying in 2 seconds... (attempt ${attempt}/3)`);
        await sleep(2000);
      }
    }

    if (listSuccess === false && hasSnapshot === false) {
      recordResult('snapshot', 'List Snapshots', false, 'Snapshot not found in list after 3 attempts');
    }

    // Step 4: Delete snapshot
    logStep('Step 4: Delete snapshot');
    const deleteTool = vmType === 'qemu' ? 'proxmox_delete_snapshot_vm' : 'proxmox_delete_snapshot_lxc';
    const deleteResult = await callTool(deleteTool, {
      node: node,
      vmid: vmid,
      snapname: snapname
    });

    recordResult('snapshot', 'Delete Snapshot', deleteResult.success,
      deleteResult.success ? 'Snapshot deleted' : deleteResult.error);

  } catch (error) {
    recordResult('snapshot', 'Workflow', false, `Exception: ${error.message}`);
  }
}

async function testBackupWorkflow() {
  logSection('Backup Workflow');

  try {
    logStep('Step 1: Find VM for backup testing');
    const vmsResult = await callTool('proxmox_get_vms');

    if (!vmsResult.success) {
      recordResult('backup', 'Find VM', false, vmsResult.error);
      return;
    }

    const vmMatch = vmsResult.content.match(/\(ID:\s*(\d+)\).*?[•\s]*Node:\s*(\S+)/is);

    if (!vmMatch) {
      recordResult('backup', 'Find VM', false, 'No VMs found');
      return;
    }

    const vmid = vmMatch[1];
    const node = vmMatch[2];
    const vmType = vmsResult.content.includes('QEMU') ? 'qemu' : 'lxc';

    logSuccess(`Using ${vmType} ${vmid} on ${node}`);

    // Step 2: Create backup
    logStep('Step 2: Create backup', 'Storage: local');
    const createTool = vmType === 'qemu' ? 'proxmox_create_backup_vm' : 'proxmox_create_backup_lxc';
    const createResult = await callTool(createTool, {
      node: node,
      vmid: vmid,
      storage: 'local'
    });

    if (!createResult.success) {
      recordResult('backup', 'Create Backup', false, createResult.error);
      return;
    }
    recordResult('backup', 'Create Backup', true, 'Backup job started');

    logWarning('Backup runs in background. Waiting 5 seconds before listing...');
    await sleep(5000);

    // Step 3: List backups
    logStep('Step 3: List backups');
    const listResult = await callTool('proxmox_list_backups', {
      node: node
    });

    if (!listResult.success) {
      recordResult('backup', 'List Backups', false, listResult.error);
    } else {
      recordResult('backup', 'List Backups', true, 'Backups listed successfully');
    }

    logWarning('Note: Backup deletion requires the backup filename from the list above');

  } catch (error) {
    recordResult('backup', 'Workflow', false, `Exception: ${error.message}`);
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

async function cleanup() {
  if (config.noCleanup || config.dryRun) {
    logWarning('Cleanup skipped');
    return;
  }

  if (config.testResources.length === 0) {
    log('No resources to clean up', 'dim');
    return;
  }

  logSection('Cleanup');

  for (const resource of config.testResources) {
    logStep(`Deleting ${resource.type} ${resource.vmid} on ${resource.node}`);

    const deleteTool = resource.type === 'lxc' ? 'proxmox_delete_lxc' : 'proxmox_delete_vm';
    const deleteResult = await callTool(deleteTool, {
      node: resource.node,
      vmid: resource.vmid
    });

    if (deleteResult.success) {
      logSuccess(`Deleted ${resource.type} ${resource.vmid}`);
    } else {
      logError(`Failed to delete ${resource.type} ${resource.vmid}: ${deleteResult.error}`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║      Proxmox MCP Server - Workflow Test Suite                    ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  // Check for elevated permissions
  log('Checking environment...', 'cyan');

  if (config.dryRun) {
    logWarning('DRY-RUN MODE: No actual operations will be performed');
  }

  if (config.interactive) {
    log('Interactive mode enabled', 'yellow');
  }

  // Get test node
  log('Auto-detecting node...', 'cyan');
  const nodesResult = await callTool('proxmox_get_nodes');
  if (!nodesResult.success) {
    logError('Failed to get nodes. Ensure .env is configured and server is accessible.');
    process.exit(1);
  }

  // Handle node name format: 🟢 **pve1**
  const nodeMatch = nodesResult.content.match(/\*\*([a-zA-Z0-9-]+)\*\*/i) ||
                    nodesResult.content.match(/Node:\s*(\S+)/i) ||
                    nodesResult.content.match(/^([a-zA-Z0-9-]+)/m);

  if (!nodeMatch) {
    logError('Could not detect node name');
    process.exit(1);
  }

  config.testNode = nodeMatch[1].replace(/[^a-zA-Z0-9-]/g, '');
  logSuccess(`Using node: ${config.testNode}`);

  // Run workflows
  const workflows = {
    lxc: testLXCWorkflow,
    vm: testVMLifecycleWorkflow,
    network: testNetworkWorkflow,
    disk: testDiskWorkflow,
    snapshot: testSnapshotWorkflow,
    backup: testBackupWorkflow
  };

  if (config.workflow === 'all') {
    for (const [name, func] of Object.entries(workflows)) {
      await func();
    }
  } else if (workflows[config.workflow]) {
    await workflows[config.workflow]();
  } else {
    logError(`Unknown workflow: ${config.workflow}`);
    log(`Available workflows: ${Object.keys(workflows).join(', ')}, all`, 'yellow');
    process.exit(1);
  }

  // Cleanup
  await cleanup();

  // Print summary
  logSection('Test Summary');

  console.log(`${colors.green}✓ Passed: ${results.passed.length}${colors.reset}`);
  results.passed.forEach(r => {
    console.log(`  ${colors.dim}[${r.workflow}]${colors.reset} ${r.test}`);
  });

  if (results.failed.length > 0) {
    console.log(`\n${colors.red}✗ Failed: ${results.failed.length}${colors.reset}`);
    results.failed.forEach(r => {
      console.log(`  ${colors.dim}[${r.workflow}]${colors.reset} ${r.test}: ${r.message}`);
    });
  }

  if (results.skipped.length > 0) {
    console.log(`\n${colors.yellow}⊘ Skipped: ${results.skipped.length}${colors.reset}`);
  }

  const total = results.passed.length + results.failed.length;
  const passRate = total > 0 ? ((results.passed.length / total) * 100).toFixed(1) : 0;

  console.log(`\n${colors.cyan}${colors.bright}Total: ${results.passed.length}/${total} passed (${passRate}%)${colors.reset}\n`);

  rl.close();
  process.exit(results.failed.length > 0 ? 1 : 0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  logError(`Unhandled error: ${error.message}`);
  console.error(error);
  rl.close();
  process.exit(1);
});

// Run
main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  console.error(error);
  rl.close();
  process.exit(1);
});
