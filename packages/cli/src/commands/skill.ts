import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillInstallTarget = 'all' | 'agents' | 'gemini' | 'codex' | 'project';

export interface InstallSkillOptions {
  target?: SkillInstallTarget;
  projectDir?: string;
  homeDir?: string;
}

export interface InstallSkillResult {
  installedPaths: string[];
  skippedSymlinks: string[];
}

export function resolveBundledSkillPath(): string {
  const candidates = [
    new URL('../skills/zterm-cli/SKILL.md', import.meta.url),
    new URL('../../skills/zterm-cli/SKILL.md', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error('Bundled zterm-cli SKILL.md not found in package.');
}

export function readBundledSkill(): string {
  return readFileSync(resolveBundledSkillPath(), 'utf8');
}

export function resolveSkillDestinations(options: InstallSkillOptions = {}): string[] {
  const target = options.target ?? 'all';
  const home = options.homeDir ?? homedir();
  const project = options.projectDir ?? process.cwd();

  if (target === 'agents') {
    return [join(home, '.agents', 'skills', 'zterm-cli', 'SKILL.md')];
  }
  if (target === 'gemini') {
    return [join(home, '.gemini', 'config', 'skills', 'zterm-cli', 'SKILL.md')];
  }
  if (target === 'codex') {
    return [join(home, '.codex', 'skills', 'zterm-cli', 'SKILL.md')];
  }
  if (target === 'project') {
    return [join(resolve(project), '.agents', 'skills', 'zterm-cli', 'SKILL.md')];
  }
  return [
    join(home, '.agents', 'skills', 'zterm-cli', 'SKILL.md'),
    join(home, '.gemini', 'config', 'skills', 'zterm-cli', 'SKILL.md'),
    join(home, '.codex', 'skills', 'zterm-cli', 'SKILL.md'),
  ];
}

export function installSkill(options: InstallSkillOptions = {}): InstallSkillResult {
  const content = readBundledSkill();
  const destinations = resolveSkillDestinations(options);
  const installedPaths: string[] = [];
  const skippedSymlinks: string[] = [];

  for (const dest of destinations) {
    const skillDir = dirname(dest);
    try {
      const stat = lstatSync(skillDir);
      if (stat.isSymbolicLink()) {
        skippedSymlinks.push(dest);
        continue;
      }
    } catch {
      // Directory does not exist yet; create below.
    }
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(dest, content, 'utf8');
    installedPaths.push(dest);
  }

  return { installedPaths, skippedSymlinks };
}
