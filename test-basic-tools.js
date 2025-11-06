#!/usr/bin/env node

/**
 * Test script for basic (non-elevated) Proxmox MCP tools
 * This tests all tools that should work without PROXMOX_ALLOW_ELEVATED=true
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

// Test results tracker
const results = {
  passed: [],
  failed: [],
  warnings: []
};

// Call a tool and return the result
async function callTool(toolName, args = {}) {
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
        // Find JSON response in stdout
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
          resolve({ response, stderr, code });
        } else {
          reject(new Error(`No JSON response found. stdout: ${stdout}, stderr: ${stderr}`));
        }
      } catch (error) {
        reject(error);
      }
    });

    serverProcess.on('error', reject);

    // Send request
    serverProcess.stdin.write(JSON.stringify(request) + '\n');
    serverProcess.stdin.end();
  });
}

// Print test header
function printHeader(message) {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}${message}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}\n`);
}

// Print test result
function printResult(toolName, success, message, details = null) {
  const icon = success ? '✓' : '✗';
  const color = success ? colors.green : colors.red;

  console.log(`${color}${icon} ${toolName}${colors.reset}`);
  console.log(`  ${message}`);

  if (details) {
    console.log(`  ${colors.yellow}Details:${colors.reset} ${details}`);
  }
  console.log();

  if (success) {
    results.passed.push({ tool: toolName, message });
  } else {
    results.failed.push({ tool: toolName, message, details });
  }
}

// Test a tool
async function testTool(toolName, args = {}, validator = null) {
  try {
    console.log(`${colors.blue}Testing: ${toolName}${colors.reset}`);

    const { response } = await callTool(toolName, args);

    if (response.error) {
      printResult(toolName, false, `Error: ${response.error.message}`, response.error.code);
      return false;
    }

    if (!response.result || !response.result.content || response.result.content.length === 0) {
      printResult(toolName, false, 'No content returned', JSON.stringify(response.result));
      return false;
    }

    const content = response.result.content[0];

    // Check if it's an error message about permissions
    if (content.text && content.text.includes('Requires Elevated Permissions')) {
      printResult(toolName, false, 'Incorrectly requires elevated permissions', content.text.substring(0, 100));
      return false;
    }

    // Run custom validator if provided
    if (validator) {
      const validationResult = validator(content);
      if (!validationResult.success) {
        printResult(toolName, false, validationResult.message, validationResult.details);
        return false;
      }
    }

    printResult(toolName, true, 'Success', `Returned ${content.text ? content.text.length : 0} characters`);
    return true;
  } catch (error) {
    printResult(toolName, false, `Exception: ${error.message}`, error.stack);
    return false;
  }
}

// Main test suite
async function runTests() {
  printHeader('Testing Basic Proxmox MCP Tools');

  console.log(`${colors.yellow}Note: These tests require a working Proxmox connection.${colors.reset}`);
  console.log(`${colors.yellow}Ensure .env is configured with valid credentials.${colors.reset}\n`);

  // Test 1: proxmox_get_nodes
  await testTool('proxmox_get_nodes', {}, (content) => {
    if (!content.text || content.text.length === 0) {
      return { success: false, message: 'Empty response' };
    }
    if (!content.text.includes('Node') && !content.text.includes('node')) {
      return { success: false, message: 'Response does not appear to contain node information' };
    }
    return { success: true };
  });

  // Test 2: proxmox_get_cluster_status
  await testTool('proxmox_get_cluster_status', {}, (content) => {
    if (!content.text || content.text.length === 0) {
      return { success: false, message: 'Empty response' };
    }
    return { success: true };
  });

  // Test 3: proxmox_get_vms
  await testTool('proxmox_get_vms', {}, (content) => {
    if (!content.text || content.text.length === 0) {
      return { success: false, message: 'Empty response' };
    }
    return { success: true };
  });

  // Test 4: proxmox_get_storage
  await testTool('proxmox_get_storage', {}, (content) => {
    if (!content.text || content.text.length === 0) {
      return { success: false, message: 'Empty response' };
    }
    return { success: true };
  });

  // Test 5: proxmox_get_next_vmid
  await testTool('proxmox_get_next_vmid', {}, (content) => {
    if (!content.text || content.text.length === 0) {
      return { success: false, message: 'Empty response' };
    }
    // Check if response contains a number
    if (!/\d{3,}/.test(content.text)) {
      return { success: false, message: 'Response does not contain a valid VMID number', details: content.text };
    }
    return { success: true };
  });

  // Test 6: proxmox_list_templates (requires node parameter)
  // First we need to get a node name from proxmox_get_nodes
  console.log(`${colors.blue}Testing: proxmox_list_templates (requires node name)${colors.reset}`);
  console.log(`${colors.yellow}  Getting node name first...${colors.reset}`);

  try {
    const { response: nodesResponse } = await callTool('proxmox_get_nodes', {});
    if (nodesResponse.result && nodesResponse.result.content && nodesResponse.result.content[0]) {
      const nodesText = nodesResponse.result.content[0].text;
      // Try to extract first node name
      const nodeMatch = nodesText.match(/(?:Node|node):\s*(\S+)/i) ||
                        nodesText.match(/^(\S+)/m);

      if (nodeMatch && nodeMatch[1]) {
        const nodeName = nodeMatch[1].replace(/[^a-zA-Z0-9-]/g, '');
        console.log(`${colors.yellow}  Using node: ${nodeName}${colors.reset}`);

        await testTool('proxmox_list_templates', { node: nodeName }, (content) => {
          if (!content.text || content.text.length === 0) {
            return { success: false, message: 'Empty response' };
          }
          return { success: true };
        });
      } else {
        printResult('proxmox_list_templates', false, 'Could not extract node name from nodes list', nodesText.substring(0, 100));
      }
    } else {
      printResult('proxmox_list_templates', false, 'Could not get nodes list to find node name');
    }
  } catch (error) {
    printResult('proxmox_list_templates', false, `Failed to get node for testing: ${error.message}`);
  }

  // Test 7: proxmox_get_vm_status (requires node and vmid)
  console.log(`${colors.blue}Testing: proxmox_get_vm_status (requires node and vmid)${colors.reset}`);
  console.log(`${colors.yellow}  Getting VM info first...${colors.reset}`);

  try {
    const { response: vmsResponse } = await callTool('proxmox_get_vms', {});
    if (vmsResponse.result && vmsResponse.result.content && vmsResponse.result.content[0]) {
      const vmsText = vmsResponse.result.content[0].text;
      // Try to extract first VM info - handles format: (ID: 100) ... • Node: pve1
      const vmMatch = vmsText.match(/\(ID:\s*(\d+)\).*?[•\s]*Node:\s*(\S+)/is);

      if (vmMatch && vmMatch[1] && vmMatch[2]) {
        const vmid = vmMatch[1];
        const nodeName = vmMatch[2].replace(/[^a-zA-Z0-9-]/g, '');
        console.log(`${colors.yellow}  Using VM: ${vmid} on node: ${nodeName}${colors.reset}`);

        await testTool('proxmox_get_vm_status', { node: nodeName, vmid: vmid }, (content) => {
          if (!content.text || content.text.length === 0) {
            return { success: false, message: 'Empty response' };
          }
          return { success: true };
        });
      } else {
        printResult('proxmox_get_vm_status', false, 'Could not extract VM info from VMs list', vmsText.substring(0, 100));
      }
    } else {
      printResult('proxmox_get_vm_status', false, 'Could not get VMs list to find VM for testing');
    }
  } catch (error) {
    printResult('proxmox_get_vm_status', false, `Failed to get VM info for testing: ${error.message}`);
  }

  // Print summary
  printHeader('Test Summary');

  console.log(`${colors.green}Passed: ${results.passed.length}${colors.reset}`);
  results.passed.forEach(r => console.log(`  ✓ ${r.tool}`));

  if (results.failed.length > 0) {
    console.log(`\n${colors.red}Failed: ${results.failed.length}${colors.reset}`);
    results.failed.forEach(r => console.log(`  ✗ ${r.tool}: ${r.message}`));
  }

  console.log(`\n${colors.cyan}Total: ${results.passed.length}/${results.passed.length + results.failed.length} passed${colors.reset}\n`);

  // Exit with error code if any tests failed
  process.exit(results.failed.length > 0 ? 1 : 0);
}

// Run the tests
runTests().catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});
