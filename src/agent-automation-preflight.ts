import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configuredExaClient } from './exa.js';
import { createLocalDirectoryComputer } from './local-computer.js';
import { getProvider } from './provider.js';
import { createSkillRuntime } from './skills.js';
import type { AgentAutomation } from './agent-automation.js';

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface AgentAutomationPreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
}

export interface AgentAutomationPreflightResult {
  automationId: string;
  ok: boolean;
  checks: AgentAutomationPreflightCheck[];
}

function check(
  checks: AgentAutomationPreflightCheck[],
  name: string,
  status: PreflightStatus,
  detail: string,
): void {
  checks.push({ name, status, detail });
}

export async function preflightAgentAutomation(
  automation: AgentAutomation,
): Promise<AgentAutomationPreflightResult> {
  const checks: AgentAutomationPreflightCheck[] = [];

  let cwd: string | undefined;
  try {
    cwd = await realpath(resolve(automation.cwd));
    const metadata = await stat(cwd);
    if (!metadata.isDirectory()) {
      check(checks, 'cwd', 'fail', `Working path is not a directory: ${cwd}`);
      cwd = undefined;
    } else {
      check(checks, 'cwd', 'pass', cwd);
    }
  } catch (error) {
    check(
      checks,
      'cwd',
      'fail',
      `Working directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const skillRoots = automation.skillRoots.map((root) => resolve(root));
  try {
    const skills = await createSkillRuntime([], skillRoots);
    for (const diagnostic of skills.diagnostics) {
      check(checks, 'skill', 'fail', diagnostic);
    }

    if (automation.skillName) {
      const matched = skills.list().find((skill) => skill.name === automation.skillName);
      if (matched) {
        check(checks, 'skill', 'pass', `${matched.name}: ${matched.path}`);
      } else {
        check(
          checks,
          'skill',
          'fail',
          `Skill "${automation.skillName}" was not found in configured standalone roots.`,
        );
      }
    } else if (skillRoots.length) {
      const names = skills.list().map((skill) => skill.name);
      check(
        checks,
        'skill',
        names.length ? 'pass' : 'warn',
        names.length ? `Available skills: ${names.join(', ')}` : 'No standalone skills discovered.',
      );
    } else {
      check(checks, 'skill', 'warn', 'No standalone skill configured.');
    }
  } catch (error) {
    check(
      checks,
      'skill',
      'fail',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    getProvider();
    check(checks, 'provider', 'pass', `LLM provider configured: ${process.env.LLM_PROVIDER}`);
  } catch (error) {
    check(
      checks,
      'provider',
      'fail',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (configuredExaClient()) {
    check(checks, 'exa', 'pass', 'EXA_API_KEY is configured.');
  } else {
    check(checks, 'exa', 'warn', 'EXA_API_KEY is not configured; native web_search/web_fetch will be unavailable.');
  }

  if (cwd) {
    try {
      const computer = await createLocalDirectoryComputer(cwd);
      try {
        const git = await computer.exec({
          command: 'git',
          args: ['--version'],
          timeoutMs: 5000,
        });
        if (git.exitCode === 0) {
          check(checks, 'git', 'pass', git.stdout.trim() || 'git is available.');
        } else {
          check(checks, 'git', 'warn', git.stderr.trim() || `git exited with ${git.exitCode}.`);
        }
      } finally {
        await computer.destroy();
      }
    } catch (error) {
      check(
        checks,
        'git',
        'warn',
        `git preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (automation.state !== 'enabled') {
    check(checks, 'automation', 'warn', 'Automation is disabled; run-now will be skipped until it is enabled.');
  } else {
    check(checks, 'automation', 'pass', `Next scheduled run: ${automation.nextRunAt}`);
  }

  return {
    automationId: automation.automationId,
    ok: !checks.some((item) => item.status === 'fail'),
    checks,
  };
}
